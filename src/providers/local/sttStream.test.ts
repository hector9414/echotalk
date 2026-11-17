import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSttStreamManager } from './sttStream';
import type { RecognitionHandlers } from '../types';

const SAMPLE_RATE_HERTZ = 16000;

// amplitude 0 -> rms 0 (silent); a few thousand -> comfortably above the
// thresholds used in these tests.
function makeChunk(amplitude: number, durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE_HERTZ);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

function noopHandlers(overrides: Partial<RecognitionHandlers> = {}): RecognitionHandlers {
  return { onInterim() {}, onFinal() {}, onError() {}, ...overrides };
}

function makeFakeFetch(responses: Array<{ ok: boolean; text?: string }>) {
  const calls: Array<{ url: string; body: FormData }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: init.body });
    const response = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: response.ok,
      status: response.ok ? 200 : 500,
      statusText: '',
      text: async () => '',
      json: async () => ({ text: response.text ?? '' }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// Every test below spawns a setInterval inside LocalSttStreamManager, so
// manager.stop() MUST run even if an assertion throws first - otherwise the
// dangling interval keeps the event loop alive and the whole suite hangs
// forever instead of just failing this one test (this bit the WS tests
// earlier in the project for the same underlying reason: a timer/listener
// outliving the assertion that was supposed to clean it up).
async function withManager(manager: LocalSttStreamManager, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } finally {
    manager.stop();
  }
}

describe('LocalSttStreamManager', () => {
  it('periodically re-transcribes the accumulated buffer as an interim result, without clearing it', async () => {
    const fake = makeFakeFetch([{ ok: true, text: 'hola' }]);
    const interim: string[] = [];
    const manager = new LocalSttStreamManager('es-ES', noopHandlers({ onInterim: (t) => interim.push(t) }), fake.fetchImpl, {
      chunkIntervalMs: 30,
      silenceMs: 10_000, // never trigger finalize in this test
      silenceRmsThreshold: 500,
      url: 'http://127.0.0.1:8178',
    });

    await withManager(manager, async () => {
      manager.write(makeChunk(5000, 20)); // loud -> not silence
      await new Promise((resolve) => setTimeout(resolve, 45)); // 1 tick at ~30ms, not yet a 2nd at ~60ms

      assert.deepEqual(interim, ['hola']);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].url, 'http://127.0.0.1:8178/inference');
      const body = fake.calls[0].body;
      assert.equal(body.get('response_format'), 'json');
      assert.equal(body.get('language'), 'es');
      assert.ok(body.get('file') instanceof Blob);
    });
  });

  it('maps known BCP-47/Google-style codes to a 2-letter Whisper language hint', async () => {
    const fake = makeFakeFetch([{ ok: true, text: 'hi' }]);
    const manager = new LocalSttStreamManager('en-US', noopHandlers(), fake.fetchImpl, {
      chunkIntervalMs: 30,
      silenceMs: 10_000,
    });

    await withManager(manager, async () => {
      manager.write(makeChunk(5000, 20));
      await new Promise((resolve) => setTimeout(resolve, 45));

      assert.equal(fake.calls[0].body.get('language'), 'en');
    });
  });

  it('finalizes the utterance once a run of near-silent chunks crosses the threshold, then resets the buffer', async () => {
    const fake = makeFakeFetch([{ ok: true, text: 'adios' }]);
    const final: string[] = [];
    const interim: string[] = [];
    const manager = new LocalSttStreamManager(
      'es-ES',
      noopHandlers({ onFinal: (t) => final.push(t), onInterim: (t) => interim.push(t) }),
      fake.fetchImpl,
      { chunkIntervalMs: 10_000, silenceMs: 15, silenceRmsThreshold: 500 }, // long interval: isolate the silence path
    );

    await withManager(manager, async () => {
      manager.write(makeChunk(5000, 20)); // loud speech
      manager.write(makeChunk(0, 20)); // silence, crosses the 15ms threshold
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.deepEqual(final, ['adios']);
      assert.deepEqual(interim, []);
      assert.equal(fake.calls.length, 1);

      // Buffer was reset on finalize - a short silent write right after
      // should not immediately re-finalize (fresh silentRunMs, well under
      // the 15ms threshold on its own).
      manager.write(makeChunk(0, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fake.calls.length, 1, 'a short silent chunk right after reset should not immediately re-finalize');
    });
  });

  it('queues a pending finalize while an interim transcription is in flight, and runs it right after', async () => {
    let resolveFirst!: (value: { ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown> }) => void;
    const calls: string[] = [];
    const fetchImpl = (async () => {
      if (calls.length === 0) {
        calls.push('interim');
        return new Promise((resolve) => {
          resolveFirst = resolve as typeof resolveFirst;
        });
      }
      calls.push('final');
      return { ok: true, status: 200, statusText: '', text: async () => '', json: async () => ({ text: 'final text' }) };
    }) as unknown as typeof fetch;

    const final: string[] = [];
    const manager = new LocalSttStreamManager('es-ES', noopHandlers({ onFinal: (t) => final.push(t) }), fetchImpl, {
      chunkIntervalMs: 10,
      silenceMs: 15,
      silenceRmsThreshold: 500,
    });

    await withManager(manager, async () => {
      manager.write(makeChunk(5000, 20)); // loud, keeps the interim timer meaningful
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the interim tick fire and go "in flight"
      assert.equal(calls.length, 1, 'expected the interim transcription to have started');

      manager.write(makeChunk(0, 20)); // silence while busy -> should only set finalizePending, not call fetch again
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(calls.length, 1, 'finalize should be queued, not fired, while the interim call is in flight');

      resolveFirst({ ok: true, status: 200, statusText: '', text: async () => '', json: async () => ({ text: 'interim text' }) });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(calls.length, 2, 'the queued finalize should run right after the in-flight interim resolves');
      assert.deepEqual(final, ['final text']);
    });
  });

  it('surfaces a non-OK server response via onError instead of throwing', async () => {
    const fake = makeFakeFetch([{ ok: false }]);
    const errors: string[] = [];
    const manager = new LocalSttStreamManager('es-ES', noopHandlers({ onError: (e) => errors.push(e.message) }), fake.fetchImpl, {
      chunkIntervalMs: 30,
      silenceMs: 10_000,
    });

    await withManager(manager, async () => {
      manager.write(makeChunk(5000, 20));
      await new Promise((resolve) => setTimeout(resolve, 45));

      assert.equal(errors.length, 1);
      assert.match(errors[0], /Servidor local de STT fallo/);
    });
  });

  it('stop() clears the interval timer and further writes are ignored', async () => {
    const fake = makeFakeFetch([{ ok: true, text: 'hola' }]);
    const manager = new LocalSttStreamManager('es-ES', noopHandlers(), fake.fetchImpl, { chunkIntervalMs: 30, silenceMs: 10_000 });

    manager.stop();
    manager.write(makeChunk(5000, 20));
    await new Promise((resolve) => setTimeout(resolve, 45));

    assert.equal(fake.calls.length, 0);
  });
});
