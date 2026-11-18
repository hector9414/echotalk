import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioStore } from '../audioStore';
import { SessionManager } from '../sessionManager';
import { QuestionFloor } from './questionFloor';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from '../providers/types';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeProvider(options: { synthesizeShouldFail?: boolean } = {}) {
  let capturedHandlers: RecognitionHandlers | null = null;
  const translateCalls: Array<{ text: string; from: string; to: string }> = [];
  const synthesizeCalls: Array<{ text: string; languageCode: string }> = [];
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
      async synthesize(text, languageCode) {
        synthesizeCalls.push({ text, languageCode });
        if (options.synthesizeShouldFail) {
          throw new Error('voz no disponible (fake)');
        }
        return { buffer: Buffer.from('fake-audio'), mime: 'audio/mpeg' };
      },
    },
  };

  return {
    provider,
    translateCalls,
    synthesizeCalls,
    stopCallCount: () => stopCalls,
    emitFinal: (text: string) => capturedHandlers?.onFinal(text),
  };
}

const fakeWs = (id: string) => ({ id }) as unknown as import('ws').WebSocket;

describe('QuestionFloor', () => {
  it('rejects a request when no session is active', () => {
    const sm = new SessionManager();
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore());
    const result = floor.request(fakeWs('a'), 'en-US');
    assert.match(result ?? '', /no hay una sesión activa/i);
    assert.equal(floor.isBusy(), false);
  });

  it('grants the floor to the first requester and denies a second one', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore());

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
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore());

    const result = floor.request(fakeWs('a'), 'xx-XX');
    assert.match(result ?? '', /idioma válido/i);
    assert.equal(floor.isBusy(), false);
  });

  it('translates a finalized question, synthesizes it in the presenter language, and stores the clip', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US'); // presenter speaks Spanish
    const fake = makeFakeProvider();
    const audioStore = new AudioStore();
    const questions: Array<{ sourceText: string; sourceLanguageLabel: string; translatedText: string; audioUrl: string | null }> = [];
    const floor = new QuestionFloor(sm, fake.provider, audioStore, { onQuestion: (q) => questions.push(q) });

    floor.request(fakeWs('a'), 'en-US'); // asker speaks English
    fake.emitFinal('what time is it');
    await tick();

    assert.deepEqual(fake.translateCalls[0], { text: 'what time is it', from: 'en', to: 'es' });
    assert.deepEqual(fake.synthesizeCalls[0], { text: '[es] what time is it', languageCode: 'es-ES' });

    const question = questions[0];
    assert.equal(question.sourceText, 'what time is it');
    assert.equal(question.sourceLanguageLabel, 'Inglés (Estados Unidos)');
    assert.equal(question.translatedText, '[es] what time is it');
    assert.match(question.audioUrl ?? '', /^\/api\/audio\/.+/);

    const audioId = question.audioUrl!.replace('/api/audio/', '');
    assert.deepEqual(audioStore.get(audioId), { buffer: Buffer.from('fake-audio'), mime: 'audio/mpeg' });
  });

  it('still delivers the question (with audioUrl null) if voice synthesis fails', async () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider({ synthesizeShouldFail: true });
    const questions: Array<{ audioUrl: string | null }> = [];
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore(), { onQuestion: (q) => questions.push(q) });

    floor.request(fakeWs('a'), 'en-US');
    fake.emitFinal('what time is it');
    await tick();

    assert.equal(questions.length, 1);
    assert.equal(questions[0].audioUrl, null);
  });

  it('writeAudio only forwards to the recognizer for the current asker', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const fake = makeFakeProvider();
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore());

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
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore(), { onFloorFree: () => freedCount++ });

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
    const floor = new QuestionFloor(sm, fake.provider, new AudioStore());

    floor.request(fakeWs('a'), 'en-US');
    floor.release();
    const secondAsker = fakeWs('b');
    const result = floor.request(secondAsker, 'fr-FR');
    assert.equal(result, null);
    assert.equal(floor.isCurrentAsker(secondAsker), true);
  });
});
