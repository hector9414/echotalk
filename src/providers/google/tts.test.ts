import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSpeechSynthesizer } from './tts';

function makeFakeClient(audioContent: Buffer | Uint8Array | undefined) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async synthesizeSpeech(request: unknown) {
        calls.push(request);
        return [{ audioContent }];
      },
    },
  };
}

describe('GoogleSpeechSynthesizer', () => {
  it('synthesizes text and returns an audio/mpeg buffer', async () => {
    const fake = makeFakeClient(Buffer.from('fake-mp3-bytes'));
    const synth = new GoogleSpeechSynthesizer(fake.client as any);
    const result = await synth.synthesize('hello world', 'en-US');
    assert.equal(result.mime, 'audio/mpeg');
    assert.equal(result.buffer.toString(), 'fake-mp3-bytes');
    assert.equal(fake.calls.length, 1);
  });

  it('requests MP3 encoding and passes languageCode/voice through to the request', async () => {
    const fake = makeFakeClient(Buffer.from('x'));
    const synth = new GoogleSpeechSynthesizer(fake.client as any);
    await synth.synthesize('hola', 'es-ES', 'es-ES-Standard-A');
    const request = fake.calls[0] as any;
    assert.equal(request.audioConfig.audioEncoding, 'MP3');
    assert.equal(request.voice.languageCode, 'es-ES');
    assert.equal(request.voice.name, 'es-ES-Standard-A');
    assert.equal(request.voice.ssmlGender, undefined);
  });

  it('passes the given speakingRate through to audioConfig, defaulting to TTS_SPEAKING_RATE', async () => {
    const fake = makeFakeClient(Buffer.from('x'));
    const synth = new GoogleSpeechSynthesizer(fake.client as any, 1.3);
    await synth.synthesize('hola', 'es-ES');
    const request = fake.calls[0] as any;
    assert.equal(request.audioConfig.speakingRate, 1.3);
  });

  it('defaults to a NEUTRAL voice gender when no specific voice name is given', async () => {
    const fake = makeFakeClient(Buffer.from('x'));
    const synth = new GoogleSpeechSynthesizer(fake.client as any);
    await synth.synthesize('hola', 'es-ES');
    const request = fake.calls[0] as any;
    assert.equal(request.voice.name, undefined);
    assert.equal(request.voice.ssmlGender, 'NEUTRAL');
  });

  it('converts a non-Buffer Uint8Array audioContent into a real Buffer', async () => {
    const fake = makeFakeClient(new Uint8Array([1, 2, 3]));
    const synth = new GoogleSpeechSynthesizer(fake.client as any);
    const result = await synth.synthesize('hola', 'es-ES');
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.deepEqual([...result.buffer], [1, 2, 3]);
  });

  it('throws when Google returns no audioContent', async () => {
    const fake = makeFakeClient(undefined);
    const synth = new GoogleSpeechSynthesizer(fake.client as any);
    await assert.rejects(() => synth.synthesize('hola', 'es-ES'));
  });
});
