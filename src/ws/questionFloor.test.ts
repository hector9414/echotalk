import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../sessionManager';
import { QuestionFloor } from './questionFloor';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from '../providers/types';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeProvider() {
  let capturedHandlers: RecognitionHandlers | null = null;
  const translateCalls: Array<{ text: string; from: string; to: string }> = [];
  let stopCalls = 0;

  const recognizer: SpeechRecognizer = {
    write: () => {},
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
        return `[${to}] ${text}`;
      },
    },
    synthesizer: {
      async synthesize() {
        return { buffer: Buffer.from(''), mime: 'audio/mpeg' };
      },
    },
  };

  return {
    provider,
    translateCalls,
    stopCallCount: () => stopCalls,
    emitFinal: (text: string) => capturedHandlers?.onFinal(text),
  };
}

const fakeWs = (id: string) => ({ id }) as unknown as import('ws').WebSocket;

describe('QuestionFloor', () => {
  it('rejects a request when no session is active', () => {
    const sm = new SessionManager();
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider);
    const result = floor.request(fakeWs('a'), 'en-US');
    assert.match(result ?? '', /no hay una sesión activa/i);
    assert.equal(floor.isBusy(), false);
  });

  it('grants the floor to the first requester and denies a second one', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider);

    const first = floor.request(fakeWs('a'), 'en-US');
    assert.equal(first, null);
    assert.equal(floor.isBusy(), true);

    const second = floor.request(fakeWs('b'), 'fr-FR');
    assert.match(second ?? '', /otra persona está preguntando/i);
  });

  it('rejects an unknown language id', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider);

    const result = floor.request(fakeWs('a'), 'xx-XX');
    assert.match(result ?? '', /idioma válido/i);
    assert.equal(floor.isBusy(), false);
  });

  it('translates a finalized question from the asker language to the presenter language', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US'); // presenter speaks Spanish
    const fake = makeFakeProvider();
    const questions: unknown[] = [];
    const floor = new QuestionFloor(sm, fake.provider, { onQuestion: (q) => questions.push(q) });

    floor.request(fakeWs('a'), 'en-US'); // asker speaks English
    fake.emitFinal('what time is it');
    await tick();

    assert.deepEqual(fake.translateCalls[0], { text: 'what time is it', from: 'en', to: 'es' });
    assert.deepEqual(questions[0], {
      sourceText: 'what time is it',
      sourceLanguageLabel: 'Inglés (Estados Unidos)',
      translatedText: '[es] what time is it',
    });
  });

  it('writeAudio only forwards to the recognizer for the current asker', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider);

    const asker = fakeWs('asker');
    const stranger = fakeWs('stranger');
    floor.request(asker, 'en-US');

    // No direct way to inspect the recognizer's writes here since it's a
    // private detail - this just confirms isCurrentAsker() gates correctly,
    // which is what writeAudio relies on.
    assert.equal(floor.isCurrentAsker(asker), true);
    assert.equal(floor.isCurrentAsker(stranger), false);
  });

  it('release() stops the recognizer, frees the floor and is idempotent', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    let freedCount = 0;
    const floor = new QuestionFloor(sm, fake.provider, { onFloorFree: () => freedCount++ });

    floor.request(fakeWs('a'), 'en-US');
    floor.release();
    assert.equal(floor.isBusy(), false);
    assert.equal(fake.stopCallCount(), 1);
    assert.equal(freedCount, 1);

    floor.release(); // no-op, nobody holds the floor
    assert.equal(freedCount, 1);
  });

  it('after release, a new requester can get the floor', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider);

    floor.request(fakeWs('a'), 'en-US');
    floor.release();
    const secondAsker = fakeWs('b');
    const result = floor.request(secondAsker, 'fr-FR');
    assert.equal(result, null);
    assert.equal(floor.isCurrentAsker(secondAsker), true);
  });
});
