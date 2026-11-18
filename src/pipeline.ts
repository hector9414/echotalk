import { getLanguageOption, MAX_INTERIM_DURATION_MS, TTS_SAFE_BYTE_LIMIT } from './config';
import type { AudioStore } from './audioStore';
import type { SessionManager } from './sessionManager';
import type { SpeechRecognizer, TranslationProvider } from './providers/types';

export interface PipelineCallbacks {
  onSttStatus?: (status: 'connected' | 'reconnecting' | 'error') => void;
  // Overridable for tests; defaults to Date.now. Not a real-time knob for
  // production use.
  now?: () => number;
  maxInterimDurationMs?: number;
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
// or synthesized on their own, to avoid re-translating a growing sentence
// several times a second) - UNLESS the speaker goes past
// maxInterimDurationMs without a natural pause, in which case the text
// accumulated so far is force-delivered anyway (see handleInterim below).
// Without that safety valve, someone who talks for a long stretch without
// pausing would hear/see nothing translated until they finally stop.
export class TranslationPipeline {
  private recognizer: SpeechRecognizer | null = null;
  private currentSegmentId: string | null = null;
  // How many leading characters of the recognizer's current (cumulative,
  // within-utterance) text have already been translated/delivered via a
  // forced chunk - the next chunk only covers text.slice(handledLength).
  private handledLength = 0;
  private utteranceStartedAt: number | null = null;
  private readonly now: () => number;
  private readonly maxInterimDurationMs: number;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly audioStore: AudioStore,
    private readonly provider: TranslationProvider,
    private readonly callbacks: PipelineCallbacks = {},
  ) {
    this.now = callbacks.now ?? Date.now;
    this.maxInterimDurationMs = callbacks.maxInterimDurationMs ?? MAX_INTERIM_DURATION_MS;
  }

  start(): void {
    const session = this.sessionManager.getSession();
    const sourceLang = getLanguageOption(session.sourceLanguage);
    if (!sourceLang) {
      throw new Error('Idioma de origen invalido para iniciar el pipeline');
    }

    this.currentSegmentId = null;
    this.handledLength = 0;
    this.utteranceStartedAt = null;
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
    this.handledLength = 0;
    this.utteranceStartedAt = null;
  }

  private handleInterim(text: string): void {
    if (!text.trim()) return;
    if (this.utteranceStartedAt === null) {
      this.utteranceStartedAt = this.now();
    }

    const pendingText = text.slice(this.handledLength);
    if (!this.currentSegmentId) {
      this.currentSegmentId = this.sessionManager.createSegment(pendingText).id;
    } else {
      this.sessionManager.updateSegmentInterim(this.currentSegmentId, pendingText);
    }

    if (pendingText.trim() && this.now() - this.utteranceStartedAt >= this.maxInterimDurationMs) {
      const segmentId = this.currentSegmentId;
      this.handledLength = text.length;
      this.currentSegmentId = null; // the next interim/final starts a fresh displayed segment
      this.utteranceStartedAt = this.now(); // restart the window for the rest of this utterance
      this.deliver(pendingText, segmentId).catch((err: Error) => {
        console.error('Error procesando fragmento forzado por pausa larga:', err.message);
      });
    }
  }

  private async handleFinal(text: string): Promise<void> {
    const pendingText = text.slice(this.handledLength);
    this.handledLength = 0;
    this.utteranceStartedAt = null;

    // Nothing left to deliver - e.g. a forced chunk already covered this
    // whole utterance and no new words arrived before the natural final.
    // Don't create a segment just to leave it empty and never finalized.
    if (!pendingText.trim()) {
      this.currentSegmentId = null;
      return;
    }

    const segmentId = this.currentSegmentId ?? this.sessionManager.createSegment(pendingText).id;
    this.currentSegmentId = null;
    await this.deliver(pendingText, segmentId);
  }

  private async deliver(text: string, initialSegmentId: string): Promise<void> {
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
