import { getLanguageOption, TTS_SAFE_BYTE_LIMIT } from './config';
import type { AudioStore } from './audioStore';
import type { SessionManager } from './sessionManager';
import type { SpeechRecognizer, TranslationProvider } from './providers/types';

export interface PipelineCallbacks {
  onSttStatus?: (status: 'connected' | 'reconnecting' | 'error') => void;
}

// Splits text on sentence boundaries if it's close to Google Text-to-Speech's
// 5000-byte input limit, so an unusually long finalized segment still gets
// voiced instead of erroring out. A single utterance almost never gets this
// long - this is a defensive guard, not the common path.
export function splitForTts(text: string, byteLimit = TTS_SAFE_BYTE_LIMIT): string[] {
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (Buffer.byteLength(candidate, 'utf8') > byteLimit && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Orchestrates one direction of translation for the current session: feeds
// presenter audio into the provider's speech recognizer, and on each
// finalized utterance runs translate -> synthesize -> stores the clip ->
// marks the segment final. Interim results only update the in-progress
// segment's source text (see SPEC.md: interim results are never translated
// or synthesized, to avoid re-translating a growing sentence several times a
// second).
export class TranslationPipeline {
  private recognizer: SpeechRecognizer | null = null;
  private currentSegmentId: string | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly audioStore: AudioStore,
    private readonly provider: TranslationProvider,
    private readonly callbacks: PipelineCallbacks = {},
  ) {}

  start(): void {
    const session = this.sessionManager.getSession();
    const sourceLang = getLanguageOption(session.sourceLanguage);
    if (!sourceLang) {
      throw new Error('Idioma de origen invalido para iniciar el pipeline');
    }

    this.currentSegmentId = null;
    this.recognizer = this.provider.createRecognizer(sourceLang.sttCode, {
      onInterim: (text) => this.handleInterim(text),
      onFinal: (text) => {
        this.handleFinal(text).catch((err: Error) => {
          console.error('Error procesando segmento final:', err.message);
        });
      },
      onError: (err) => {
        console.error('Error de reconocimiento de voz:', err.message);
        this.callbacks.onSttStatus?.('reconnecting');
      },
    });
    this.callbacks.onSttStatus?.('connected');
  }

  writeAudio(chunk: Buffer): void {
    if (!this.recognizer || !this.sessionManager.isLive()) return;
    this.recognizer.write(chunk);
  }

  stop(): void {
    this.recognizer?.stop();
    this.recognizer = null;
    this.currentSegmentId = null;
  }

  private handleInterim(text: string): void {
    if (!text.trim()) return;
    if (!this.currentSegmentId) {
      this.currentSegmentId = this.sessionManager.createSegment(text).id;
    } else {
      this.sessionManager.updateSegmentInterim(this.currentSegmentId, text);
    }
  }

  private async handleFinal(text: string): Promise<void> {
    const initialSegmentId = this.currentSegmentId ?? this.sessionManager.createSegment(text).id;
    this.currentSegmentId = null; // next interim result starts a new utterance

    if (!text.trim()) return;

    const session = this.sessionManager.getSession();
    const sourceLang = getLanguageOption(session.sourceLanguage);
    const targetLang = getLanguageOption(session.targetLanguage);
    if (!sourceLang || !targetLang) return;

    const translated = await this.provider.translator.translate(text, sourceLang.translateCode, targetLang.translateCode);
    const chunks = splitForTts(translated);

    // Common case: a single chunk reuses the segment already shown to
    // listeners as "transcribing...". Rare case (very long utterance): extra
    // chunks become their own finalized segments, so the listener's existing
    // audio queue plays them back-to-back in order, instead of splicing
    // multiple independently-encoded TTS clips into one buffer.
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const synthesized = await this.provider.synthesizer.synthesize(
        chunkText,
        targetLang.ttsLanguageCode,
        targetLang.ttsVoiceName,
      );
      const segmentId = i === 0 ? initialSegmentId : this.sessionManager.createSegment('').id;
      this.audioStore.set(segmentId, synthesized);
      this.sessionManager.finalizeSegment(segmentId, chunkText, `/api/audio/${segmentId}`);
    }
  }
}
