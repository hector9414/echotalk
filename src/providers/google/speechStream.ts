import { SpeechClient } from '@google-cloud/speech';
import type { Duplex } from 'stream';
import { STT_RESTART_INTERVAL_MS, STT_REPLAY_BUFFER_MS } from '../../config';
import type { RecognitionHandlers, SpeechRecognizer } from '../types';

const SAMPLE_RATE_HERTZ = 16000;
const BYTES_PER_SAMPLE = 2; // LINEAR16, mono
const REPLAY_BUFFER_BYTES = Math.floor((STT_REPLAY_BUFFER_MS / 1000) * SAMPLE_RATE_HERTZ * BYTES_PER_SAMPLE);

interface StreamingRecognizeResponseLike {
  results?: Array<{
    isFinal?: boolean | null;
    alternatives?: Array<{ transcript?: string | null }> | null;
  }> | null;
}

// Narrow slice of SpeechClient's surface that GoogleSttStreamManager actually
// uses, so tests can inject a lightweight fake instead of the real gRPC client.
export interface SpeechClientLike {
  streamingRecognize(request: unknown): Duplex;
}

let sharedClient: SpeechClient | undefined;
function getSpeechClient(): SpeechClient {
  if (!sharedClient) sharedClient = new SpeechClient();
  return sharedClient;
}

/**
 * Wraps Google Cloud Speech-to-Text's streamingRecognize behind the app's
 * provider-agnostic SpeechRecognizer interface, and hides the fact that a
 * single Google stream can only stay open ~5 minutes: it transparently closes
 * and reopens the underlying stream every STT_RESTART_INTERVAL_MS (or
 * immediately on error, with backoff), replaying a short buffer of recent
 * audio into the new stream so the model has acoustic context across the
 * seam. Callers (the pipeline) see one continuous logical stream and never
 * know a restart happened.
 */
export class GoogleSttStreamManager implements SpeechRecognizer {
  private readonly client: SpeechClientLike;
  private readonly languageCode: string;
  private readonly handlers: RecognitionHandlers;

  private stream: Duplex | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private replayBuffer: Buffer[] = [];
  private replayBufferBytes = 0;
  private stopped = false;
  private errorStreak = 0;

  constructor(languageCode: string, handlers: RecognitionHandlers, client: SpeechClientLike = getSpeechClient()) {
    this.client = client;
    this.languageCode = languageCode;
    this.handlers = handlers;
    this.openStream(false);
  }

  write(chunk: Buffer): void {
    if (this.stopped) return;
    this.appendToReplayBuffer(chunk);
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(chunk);
    }
  }

  stop(): void {
    this.stopped = true;
    this.closeStream();
  }

  private appendToReplayBuffer(chunk: Buffer): void {
    this.replayBuffer.push(chunk);
    this.replayBufferBytes += chunk.length;
    while (this.replayBufferBytes > REPLAY_BUFFER_BYTES && this.replayBuffer.length > 1) {
      const removed = this.replayBuffer.shift();
      if (removed) this.replayBufferBytes -= removed.length;
    }
  }

  private openStream(isRestart: boolean): void {
    // Model availability varies by language and changes over time - verify
    // 'latest_long' is supported for the languages you enable before going live.
    const stream = this.client.streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: SAMPLE_RATE_HERTZ,
        languageCode: this.languageCode,
        enableAutomaticPunctuation: true,
        model: 'latest_long',
      },
      interimResults: true,
    });

    stream.on('data', (data: StreamingRecognizeResponseLike) => {
      this.errorStreak = 0;
      const result = data.results?.[0];
      const transcript = result?.alternatives?.[0]?.transcript;
      if (!result || !transcript) return;
      if (result.isFinal) {
        this.handlers.onFinal(transcript);
      } else {
        this.handlers.onInterim(transcript);
      }
    });

    stream.on('error', (err: Error) => {
      if (this.stopped || this.stream !== stream) return;
      this.handlers.onError(err);
      this.scheduleRestart(true);
    });

    stream.on('end', () => {
      if (!this.stopped && this.stream === stream) {
        this.doRestart();
      }
    });

    this.stream = stream;

    if (isRestart) {
      for (const chunk of this.replayBuffer) {
        stream.write(chunk);
      }
    }

    this.restartTimer = setTimeout(() => this.doRestart(), STT_RESTART_INTERVAL_MS);
  }

  private doRestart(): void {
    if (this.stopped) return;
    this.closeStream();
    this.openStream(true);
  }

  private scheduleRestart(afterError: boolean): void {
    if (this.stopped) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const delay = afterError ? Math.min(500 * 2 ** this.errorStreak, 5000) : 0;
    this.errorStreak += 1;
    this.restartTimer = setTimeout(() => this.doRestart(), delay);
  }

  private closeStream(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stream) {
      const current = this.stream;
      this.stream = null;
      current.removeAllListeners();
      current.end();
      current.destroy();
    }
  }
}
