import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { GoogleSttStreamManager, type SpeechClientLike } from './speechStream';
import type { RecognitionHandlers } from '../types';

// A minimal fake of the Duplex that SpeechClient#streamingRecognize()
// returns: real event emission (so .emit('data'/'error') behaves like the
// real gRPC stream would), but write/end/destroy are just recorded, not
// backed by an actual stream/socket.
function makeFakeStream() {
  const emitter = new EventEmitter() as EventEmitter & Duplex;
  const writes: Buffer[] = [];
  let destroyed = false;
  Object.assign(emitter, {
    write: (chunk: Buffer) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
    destroy: () => {
      destroyed = true;
    },
    get destroyed() {
      return destroyed;
    },
  });
  return { emitter, writes, isDestroyed: () => destroyed };
}

function makeFakeClient() {
  const streams: ReturnType<typeof makeFakeStream>[] = [];
  const requests: unknown[] = [];
  const client: SpeechClientLike = {
    streamingRecognize(request: unknown) {
      requests.push(request);
      const fake = makeFakeStream();
      streams.push(fake);
      return fake.emitter;
    },
  };
  return { client, streams, requests };
}

function noopHandlers(overrides: Partial<RecognitionHandlers> = {}): RecognitionHandlers {
  return { onInterim() {}, onFinal() {}, onError() {}, ...overrides };
}

describe('GoogleSttStreamManager', () => {
  it('opens a streaming request with LINEAR16/16kHz/interimResults and the given language', () => {
    const fake = makeFakeClient();
    const manager = new GoogleSttStreamManager('es-ES', noopHandlers(), fake.client);
    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0] as any;
    assert.equal(request.config.encoding, 'LINEAR16');
    assert.equal(request.config.sampleRateHertz, 16000);
    assert.equal(request.config.languageCode, 'es-ES');
    assert.equal(request.interimResults, true);
    manager.stop();
  });

  it('forwards write() to the current underlying stream', () => {
    const fake = makeFakeClient();
    const manager = new GoogleSttStreamManager('es-ES', noopHandlers(), fake.client);
    manager.write(Buffer.from('audio-chunk'));
    assert.equal(fake.streams[0].writes.length, 1);
    assert.equal(fake.streams[0].writes[0].toString(), 'audio-chunk');
    manager.stop();
  });

  it('routes interim vs. final results to the matching handler', () => {
    const fake = makeFakeClient();
    const interim: string[] = [];
    const final: string[] = [];
    const manager = new GoogleSttStreamManager(
      'es-ES',
      noopHandlers({ onInterim: (t) => interim.push(t), onFinal: (t) => final.push(t) }),
      fake.client,
    );

    fake.streams[0].emitter.emit('data', { results: [{ isFinal: false, alternatives: [{ transcript: 'ho' }] }] });
    fake.streams[0].emitter.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: 'hola' }] }] });

    assert.deepEqual(interim, ['ho']);
    assert.deepEqual(final, ['hola']);
    manager.stop();
  });

  it('ignores data events with no results or no transcript', () => {
    const fake = makeFakeClient();
    const interim: string[] = [];
    const manager = new GoogleSttStreamManager('es-ES', noopHandlers({ onInterim: (t) => interim.push(t) }), fake.client);

    fake.streams[0].emitter.emit('data', { results: [] });
    fake.streams[0].emitter.emit('data', {});
    fake.streams[0].emitter.emit('data', { results: [{ isFinal: false, alternatives: [] }] });

    assert.deepEqual(interim, []);
    manager.stop();
  });

  it('stop() destroys the underlying stream and further writes are dropped', () => {
    const fake = makeFakeClient();
    const manager = new GoogleSttStreamManager('es-ES', noopHandlers(), fake.client);
    manager.stop();
    assert.equal(fake.streams[0].isDestroyed(), true);

    manager.write(Buffer.from('too-late'));
    assert.equal(fake.streams[0].writes.length, 0);
  });

  it('on a stream error: reports it via onError, then opens a replacement stream and replays recent audio', async () => {
    const fake = makeFakeClient();
    const errors: string[] = [];
    const manager = new GoogleSttStreamManager('es-ES', noopHandlers({ onError: (e) => errors.push(e.message) }), fake.client);

    manager.write(Buffer.from('recent-audio'));
    fake.streams[0].emitter.emit('error', new Error('connection reset'));

    assert.deepEqual(errors, ['connection reset']);

    // First reconnect backoff is 500ms (500 * 2^0); wait past it for the
    // replacement stream to open. Not asserting the scheduled (4-minute)
    // restart path here - that's covered by the manual long-session
    // verification step in SPEC.md instead of a real-time test.
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.equal(fake.streams.length, 2);
    const replayed = fake.streams[1].writes.some((chunk) => chunk.toString() === 'recent-audio');
    assert.ok(replayed, 'expected the replay buffer to be re-written into the replacement stream');

    manager.stop();
  });
});
