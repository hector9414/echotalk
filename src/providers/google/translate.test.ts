import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleTranslator } from './translate';

function makeFakeClient(response: string) {
  const calls: Array<{ text: string; options: unknown }> = [];
  return {
    calls,
    client: {
      async translate(text: string, options: unknown) {
        calls.push({ text, options });
        return [response];
      },
    },
  };
}

describe('GoogleTranslator', () => {
  it('translates non-empty text using the injected client', async () => {
    const fake = makeFakeClient('hello world');
    const translator = new GoogleTranslator(fake.client as any);
    const result = await translator.translate('hola mundo', 'es', 'en');
    assert.equal(result, 'hello world');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0], { text: 'hola mundo', options: { from: 'es', to: 'en' } });
  });

  it('short-circuits on blank/whitespace-only text without calling the client', async () => {
    const fake = makeFakeClient('should not be used');
    const translator = new GoogleTranslator(fake.client as any);
    const result = await translator.translate('   ', 'es', 'en');
    assert.equal(result, '');
    assert.equal(fake.calls.length, 0);
  });
});
