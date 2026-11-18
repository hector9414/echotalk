import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from './sessionManager';
import { AudioStore } from './audioStore';
import { TranslationPipeline, splitForTts } from './pipeline';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from './providers/types';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A fake, manually-advanced clock so the maxInterimDurationMs tests don't
// need real waits - see TranslationPipeline's injectable `now`.
function makeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

function makeFakeProvider() {
  let capturedHandlers: RecognitionHandlers | null = null;
  const writes: Buffer[] = [];
  const translateCalls: Array<{ text: string; from: string; to: string }> = [];
  const synthesizeCalls: Array<{ text: string; languageCode: string }> = [];
  let stopCalls = 0;

  const recognizer: SpeechRecognizer = {
    write: (chunk) => writes.push(chunk),
    stop: () => {
      stopCalls++;
    },
  };

  const provider: TranslationProvider = {
    createRecognizer(_languageCode, handlers) {
      capturedHandlers = handlers;
      return recognizer;
    },
    translator: {
      async translate(text, from, to) {
        translateCalls.push({ text, from, to });
        return `EN:${text}`;
      },
    },
    synthesizer: {
      async synthesize(text, languageCode) {
        synthesizeCalls.push({ text, languageCode });
        return { buffer: Buffer.from(text), mime: 'audio/mpeg' };
      },
    },
  };

  return {
    provider,
    writes,
    translateCalls,
    synthesizeCalls,
    stopCallCount: () => stopCalls,
    emitInterim: (text: string) => capturedHandlers?.onInterim(text),
    emitFinal: (text: string) => capturedHandlers?.onFinal(text),
    emitError: (err: Error) => capturedHandlers?.onError(err),
  };
}

describe('splitForTts', () => {
  it('returns the whole text as a single chunk when under the byte limit', () => {
    assert.deepEqual(splitForTts('hola', 100), ['hola']);
  });

  it('splits long text on sentence boundaries without losing content', () => {
    const text = 'Uno dos tres. Cuatro cinco seis. Siete ocho nueve.';
    const chunks = splitForTts(text, 20);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(' '), text);
  });
});

describe('TranslationPipeline', () => {
  it('interim results create/update a segment but never call translate or synthesize', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider);
    pipeline.start();

    fake.emitInterim('ho');
    fake.emitInterim('hola');
    await tick();

    assert.equal(sm.getSegments().length, 1);
    assert.equal(sm.getSegments()[0].sourceText, 'hola');
    assert.equal(sm.getSegments()[0].isFinal, false);
    assert.equal(fake.translateCalls.length, 0);
    assert.equal(fake.synthesizeCalls.length, 0);
  });

  it('a final result translates, synthesizes, stores audio and finalizes the segment', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const audioStore = new AudioStore();
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, audioStore, fake.provider);
    pipeline.start();

    fake.emitInterim('hola');
    fake.emitFinal('hola mundo');
    await tick();
    await tick();

    assert.equal(fake.translateCalls.length, 1);
    assert.deepEqual(fake.translateCalls[0], { text: 'hola mundo', from: 'es', to: 'en' });
    assert.equal(fake.synthesizeCalls.length, 1);

    const segments = sm.getSegments();
    assert.equal(segments.length, 1);
    assert.equal(segments[0].isFinal, true);
    assert.equal(segments[0].translatedText, 'EN:hola mundo');
    assert.ok(segments[0].audioUrl);
    assert.ok(audioStore.get(segments[0].id));
  });

  it('a final result with no prior interim still creates and finalizes a segment', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider);
    pipeline.start();

    fake.emitFinal('hola');
    await tick();
    await tick();

    const segments = sm.getSegments();
    assert.equal(segments.length, 1);
    assert.equal(segments[0].isFinal, true);
  });

  it('the next interim after a final starts a brand new segment', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider);
    pipeline.start();

    fake.emitFinal('hola');
    await tick();
    await tick();
    fake.emitInterim('adios');
    await tick();

    const segments = sm.getSegments();
    assert.equal(segments.length, 2);
    assert.equal(segments[1].sourceText, 'adios');
    assert.equal(segments[1].isFinal, false);
  });

  it('forces delivery of accumulated interim text once maxInterimDurationMs elapses without a final result', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const clock = makeClock();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider, {
      now: clock.now,
      maxInterimDurationMs: 1000,
    });
    pipeline.start();

    fake.emitInterim('hola');
    clock.advance(1500); // past the threshold, with no final result in between
    fake.emitInterim('hola mundo');
    await tick();
    await tick();

    assert.equal(fake.translateCalls.length, 1);
    assert.deepEqual(fake.translateCalls[0], { text: 'hola mundo', from: 'es', to: 'en' });

    const segments = sm.getSegments();
    assert.equal(segments.length, 1);
    assert.equal(segments[0].isFinal, true);
    assert.equal(segments[0].sourceText, 'hola mundo');

    // The recognizer's cumulative text keeps growing - only the part that
    // wasn't already force-delivered should show up as a new, non-final
    // segment (this is what keeps a very long, pause-free utterance from
    // going completely silent for the audience).
    fake.emitInterim('hola mundo como estas');
    assert.equal(sm.getSegments().length, 2);
    assert.equal(sm.getSegments()[1].sourceText.trim(), 'como estas');
    assert.equal(sm.getSegments()[1].isFinal, false);
  });

  it('does not leave a stray empty segment when the natural final has no new words beyond an already-forced chunk', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const clock = makeClock();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider, {
      now: clock.now,
      maxInterimDurationMs: 1000,
    });
    pipeline.start();

    fake.emitInterim('hola');
    clock.advance(1500);
    fake.emitInterim('hola mundo'); // forces delivery of 'hola mundo'
    await tick();
    await tick();

    fake.emitFinal('hola mundo'); // same cumulative text - no new words
    await tick();
    await tick();

    const segments = sm.getSegments();
    assert.equal(segments.length, 1);
    assert.equal(segments[0].isFinal, true);
    assert.equal(fake.translateCalls.length, 1); // the final did NOT re-translate it
  });

  it('a natural final after a forced chunk only translates the remaining new words', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const clock = makeClock();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider, {
      now: clock.now,
      maxInterimDurationMs: 1000,
    });
    pipeline.start();

    fake.emitInterim('hola');
    clock.advance(1500);
    fake.emitInterim('hola mundo'); // forces delivery of 'hola mundo'
    await tick();
    await tick();

    fake.emitFinal('hola mundo como estas');
    await tick();
    await tick();

    assert.equal(fake.translateCalls.length, 2);
    assert.equal(fake.translateCalls[1].text.trim(), 'como estas');

    const segments = sm.getSegments();
    assert.equal(segments.length, 2);
    assert.equal(segments[1].isFinal, true);
  });

  it('writeAudio forwards to the recognizer while live, and drops audio once paused', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider);
    pipeline.start();

    pipeline.writeAudio(Buffer.from('chunk-1'));
    assert.equal(fake.writes.length, 1);

    sm.pause(); // isolates the isLive() guard from the recognizer-null guard
    pipeline.writeAudio(Buffer.from('chunk-2'));
    assert.equal(fake.writes.length, 1);
  });

  it('stop() tears down the recognizer', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const pipeline = new TranslationPipeline(sm, new AudioStore(), fake.provider);
    pipeline.start();
    pipeline.stop();
    assert.equal(fake.stopCallCount(), 1);
  });
});
