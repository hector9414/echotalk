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
function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export class TranslationPipeline {
  private recognizer: SpeechRecognizer | null = null;
  private currentSegmentId: string | null = null;
  // Text currently shown in the open (non-final) segment, so it can still be
  // delivered if the utterance ends without new words or the pipeline stops.
  private currentPendingText = '';
  // How many leading WORDS of the recognizer's cumulative (within-utterance)
  // text were already delivered via a forced chunk. Counted in words, not
  // characters: the ASR routinely revises earlier words (punctuation,
  // casing, corrections), which shifts character offsets and made a
  // char-based slice cut words in half.
  private handledWordCount = 0;
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

    this.resetUtterance();
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

  // A segment still open here (e.g. the presenter pauses mid-sentence) is
  // delivered with whatever text it had, instead of being abandoned - an
  // abandoned segment never gets finalized and stays as "Transcribiendo…"
  // on every listener's screen forever.
  stop(): void {
    this.recognizer?.stop();
    this.recognizer = null;
    const segmentId = this.currentSegmentId;
    const pendingText = this.currentPendingText;
    this.resetUtterance();
    if (segmentId && pendingText) this.deliverSafely(pendingText, segmentId);
  }

  private resetUtterance(): void {
    this.currentSegmentId = null;
    this.currentPendingText = '';
    this.handledWordCount = 0;
    this.utteranceStartedAt = null;
  }

  private handleInterim(text: string): void {
    const words = wordsOf(text);
    const pendingText = words.slice(this.handledWordCount).join(' ');
    // Nothing new beyond what a forced chunk already delivered (the ASR
    // often re-sends the same interim) - creating a segment here would
    // leave an empty one that is never finalized.
    if (!pendingText) return;

    if (this.utteranceStartedAt === null) {
      this.utteranceStartedAt = this.now();
    }

    if (!this.currentSegmentId) {
      this.currentSegmentId = this.sessionManager.createSegment(pendingText).id;
    } else {
      this.sessionManager.updateSegmentInterim(this.currentSegmentId, pendingText);
    }
    this.currentPendingText = pendingText;

    if (this.now() - this.utteranceStartedAt >= this.maxInterimDurationMs) {
      const segmentId = this.currentSegmentId;
      this.handledWordCount = words.length;
      this.currentSegmentId = null; // the next interim/final starts a fresh displayed segment
      this.currentPendingText = '';
      this.utteranceStartedAt = this.now(); // restart the window for the rest of this utterance
      this.deliverSafely(pendingText, segmentId);
    }
  }

  private async handleFinal(text: string): Promise<void> {
    const pendingText = wordsOf(text).slice(this.handledWordCount).join(' ');
    const segmentId = this.currentSegmentId;
    const lastInterimText = this.currentPendingText;
    this.resetUtterance();

    // The final can carry no new words beyond a forced chunk (or a revision
    // can make it shorter). If a segment is still open, deliver the text it
    // was showing rather than leaving it pending forever; if none is open,
    // there's genuinely nothing to deliver.
    const textToDeliver = pendingText || (segmentId ? lastInterimText : '');
    if (!textToDeliver) return;

    await this.deliver(textToDeliver, segmentId ?? this.sessionManager.createSegment(textToDeliver).id);
  }

  private deliverSafely(text: string, segmentId: string): void {
    this.deliver(text, segmentId).catch((err: Error) => {
      console.error('Error procesando fragmento:', err.message);
    });
  }

  private async deliver(text: string, initialSegmentId: string): Promise<void> {
    const session = this.sessionManager.getSession();
    const sourceLang = getLanguageOption(session.sourceLanguage);
    const targetLang = getLanguageOption(session.targetLanguage);
    if (!sourceLang || !targetLang) return;

    let translated: string;
    try {
      translated = await this.provider.translator.translate(text, sourceLang.translateCode, targetLang.translateCode);
    } catch (err) {
      // Show the untranslated text rather than leave "Transcribiendo…"
      // stuck on screen with no way to recover.
      console.error('Error traduciendo segmento, se muestra el texto original:', (err as Error).message);
      this.sessionManager.finalizeSegment(initialSegmentId, text, null);
      return;
    }
    const chunks = splitForTts(translated);

    // Common case: a single chunk reuses the segment already shown to
    // listeners as "transcribing...". Rare case (very long utterance): extra
    // chunks become their own finalized segments, so the listener's existing
    // audio queue plays them back-to-back in order, instead of splicing
    // multiple independently-encoded TTS clips into one buffer.
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const segmentId = i === 0 ? initialSegmentId : this.sessionManager.createSegment('').id;
      let audioUrl: string | null = null;
      try {
        const synthesized = await this.provider.synthesizer.synthesize(
          chunkText,
          targetLang.ttsLanguageCode,
          targetLang.ttsVoiceName,
        );
        // The session may have been stopped while TTS was in flight (its
        // segments and audio were already cleared) - don't leak a clip.
        if (this.sessionManager.hasSegment(segmentId)) {
          this.audioStore.set(segmentId, synthesized);
          audioUrl = `/api/audio/${segmentId}`;
        }
      } catch (err) {
        // Voice is a bonus over the text: still show the translation.
        console.error('Error sintetizando voz, se muestra solo el texto:', (err as Error).message);
      }
      this.sessionManager.finalizeSegment(segmentId, chunkText, audioUrl);
    }
  }
}
