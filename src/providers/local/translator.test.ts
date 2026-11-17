import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalTranslator } from './translator';

function makeFakeFetch(response: { ok: boolean; status?: number; statusText?: string; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: response.statusText ?? '',
      json: async () => response.json ?? {},
      text: async () => response.text ?? '',
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('LocalTranslator', () => {
  it('posts to <baseUrl>/translate with q/source/target and returns translatedText', async () => {
    const fake = makeFakeFetch({ ok: true, json: { translatedText: 'hello world' } });
    const translator = new LocalTranslator('http://127.0.0.1:5000', fake.fetchImpl);

    const result = await translator.translate('hola mundo', 'es', 'en');

    assert.equal(result, 'hello world');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'http://127.0.0.1:5000/translate');
    assert.deepEqual(JSON.parse(fake.calls[0].init.body), {
      q: 'hola mundo',
      source: 'es',
      target: 'en',
      format: 'text',
    });
  });

  it('short-circuits on blank/whitespace-only text without calling fetch', async () => {
    const fake = makeFakeFetch({ ok: true, json: { translatedText: 'should not be used' } });
    const translator = new LocalTranslator('http://127.0.0.1:5000', fake.fetchImpl);

    const result = await translator.translate('   ', 'es', 'en');

    assert.equal(result, '');
    assert.equal(fake.calls.length, 0);
  });

  it('throws a descriptive error on a non-OK response', async () => {
    const fake = makeFakeFetch({ ok: false, status: 503, statusText: 'Service Unavailable', text: 'loading model' });
    const translator = new LocalTranslator('http://127.0.0.1:5000', fake.fetchImpl);

    await assert.rejects(() => translator.translate('hola', 'es', 'en'), /HTTP 503/);
  });
});
