import {
  LOCAL_STT_URL,
  LOCAL_STT_CHUNK_INTERVAL_MS,
  LOCAL_STT_SILENCE_MS,
  LOCAL_STT_SILENCE_RMS_THRESHOLD,
} from '../../config';
import type { RecognitionHandlers, SpeechRecognizer } from '../types';
import { pcm16ToWav } from './wav';

const SAMPLE_RATE_HERTZ = 16000;
const BYTES_PER_SAMPLE = 2; // LINEAR16, mono

// whisper.cpp (and most Whisper-based engines) don't have native streaming
// like Google's streamingRecognize - they transcribe a finite audio buffer
// and return one result, with no partial-hypothesis callback. This manager
// *simulates* streaming the same way the real-world wrappers researched for
// this feature do (see SPEC.md): keep accumulating the current utterance's
// audio, re-transcribe the whole thing every LOCAL_STT_CHUNK_INTERVAL_MS as
// an "interim" preview, and finalize (clear the buffer, emit onFinal) once a
// run of near-silence chunks suggests the speaker paused. This is honest
// about being slower/choppier than Google's word-by-word captions - see the
// "Proveedor local" section in SPEC.md for the latency tradeoff this implies.
export interface LocalSttOptions {
  url?: string;
  chunkIntervalMs?: number;
  silenceMs?: number;
  silenceRmsThreshold?: number;
}

function chunkDurationMs(chunk: Buffer): number {
  const samples = chunk.length / BYTES_PER_SAMPLE;
  return (samples / SAMPLE_RATE_HERTZ) * 1000;
}

function rms(chunk: Buffer): number {
  const samples = chunk.length / BYTES_PER_SAMPLE;
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = chunk.readInt16LE(i * BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

// Whisper expects a 2-letter language hint, not the BCP-47/Google-specific
// codes used elsewhere in the app (e.g. 'en-US', or Google's 'cmn-Hans-CN'
// for Chinese) - see SPEC.md for the known per-provider language-code gap.
const WHISPER_LANGUAGE_OVERRIDES: Record<string, string> = {
  'cmn-hans-cn': 'zh',
};

function toWhisperLanguage(languageCode: string): string {
  const lower = languageCode.toLowerCase();
  return WHISPER_LANGUAGE_OVERRIDES[lower] ?? lower.split('-')[0];
}

export class LocalSttStreamManager implements SpeechRecognizer {
  private readonly url: string;
  private readonly chunkIntervalMs: number;
  private readonly silenceMs: number;
  private readonly silenceRmsThreshold: number;

  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  private silentRunMs = 0;
  private busy = false;
  private finalizePending = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly languageCode: string,
    private readonly handlers: RecognitionHandlers,
    private readonly fetchImpl: typeof fetch = fetch,
    options: LocalSttOptions = {},
  ) {
    this.url = options.url ?? LOCAL_STT_URL;
    this.chunkIntervalMs = options.chunkIntervalMs ?? LOCAL_STT_CHUNK_INTERVAL_MS;
    this.silenceMs = options.silenceMs ?? LOCAL_STT_SILENCE_MS;
    this.silenceRmsThreshold = options.silenceRmsThreshold ?? LOCAL_STT_SILENCE_RMS_THRESHOLD;

    this.timer = setInterval(() => {
      void this.runTranscription('interim');
    }, this.chunkIntervalMs);
  }

  write(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer.push(chunk);
    this.bufferBytes += chunk.length;

    if (rms(chunk) < this.silenceRmsThreshold) {
      this.silentRunMs += chunkDurationMs(chunk);
      if (this.silentRunMs >= this.silenceMs) {
        void this.runTranscription('final');
      }
    } else {
      this.silentRunMs = 0;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.bufferBytes = 0;
  }

  private async runTranscription(trigger: 'interim' | 'final'): Promise<void> {
    if (this.stopped || this.bufferBytes === 0) return;

    if (this.busy) {
      if (trigger === 'final') this.finalizePending = true;
      return;
    }

    this.busy = true;
    const isFinal = trigger === 'final';
    const audio = Buffer.concat(this.buffer);
    if (isFinal) {
      this.buffer = [];
      this.bufferBytes = 0;
      this.silentRunMs = 0;
    }

    try {
      const text = await this.transcribe(audio);
      if (!this.stopped && text) {
        if (isFinal) this.handlers.onFinal(text);
        else this.handlers.onInterim(text);
      }
    } catch (err) {
      if (!this.stopped) this.handlers.onError(err as Error);
    } finally {
      this.busy = false;
      if (this.finalizePending) {
        this.finalizePending = false;
        void this.runTranscription('final');
      }
    }
  }

  private async transcribe(pcm: Buffer): Promise<string> {
    const wav = pcm16ToWav(pcm, SAMPLE_RATE_HERTZ);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('language', toWhisperLanguage(this.languageCode));

    const response = await this.fetchImpl(`${this.url}/inference`, { method: 'POST', body: form });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Servidor local de STT fallo (HTTP ${response.status}): ${detail || response.statusText}`);
    }

    const data = (await response.json()) as { text?: string };
    return (data.text ?? '').trim();
  }
}
