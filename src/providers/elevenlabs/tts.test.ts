import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsSpeechSynthesizer } from './tts';

function makeFakeFetch(response: { ok: boolean; status?: number; statusText?: string; body?: Uint8Array; text?: string }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 401),
      statusText: response.statusText ?? '',
      arrayBuffer: async () => (response.body ?? new Uint8Array()).buffer,
      text: async () => response.text ?? '',
    };
  }) as unknown as typeof fetch;
  return { fetchImpl: fakeFetch, calls };
}

describe('ElevenLabsSpeechSynthesizer', () => {
  it('posts to the voice-specific endpoint with the xi-api-key header and model_id', async () => {
    const audioBytes = new Uint8Array([1, 2, 3]);
    const fake = makeFakeFetch({ ok: true, body: audioBytes });
    const synth = new ElevenLabsSpeechSynthesizer(
      { apiKey: 'test-key', voiceId: 'voice-123', modelId: 'eleven_multilingual_v2', speed: 1.15 },
      fake.fetchImpl,
    );

    const result = await synth.synthesize('hola mundo', 'es-ES');

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-123');
    assert.equal(fake.calls[0].init.headers['xi-api-key'], 'test-key');
    const body = JSON.parse(fake.calls[0].init.body);
    assert.deepEqual(body, {
      text: 'hola mundo',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { speed: 1.15 },
    });

    assert.equal(result.mime, 'audio/mpeg');
    assert.deepEqual([...result.buffer], [1, 2, 3]);
  });

  it('defaults voice_settings.speed to TTS_SPEAKING_RATE when no speed is configured', async () => {
    const fake = makeFakeFetch({ ok: true });
    const synth = new ElevenLabsSpeechSynthesizer(
      { apiKey: 'test-key', voiceId: 'voice-123', modelId: 'eleven_multilingual_v2' },
      fake.fetchImpl,
    );

    await synth.synthesize('hola', 'es-ES');

    const body = JSON.parse(fake.calls[0].init.body);
    assert.equal(typeof body.voice_settings.speed, 'number');
  });

  it('throws a descriptive error when ElevenLabs responds with a non-OK status', async () => {
    const fake = makeFakeFetch({ ok: false, status: 401, statusText: 'Unauthorized', text: 'invalid api key' });
    const synth = new ElevenLabsSpeechSynthesizer(
      { apiKey: 'bad-key', voiceId: 'voice-123', modelId: 'eleven_multilingual_v2' },
      fake.fetchImpl,
    );

    await assert.rejects(() => synth.synthesize('hola', 'es-ES'), /HTTP 401/);
  });
});
