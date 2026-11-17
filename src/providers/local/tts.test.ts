import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LocalSpeechSynthesizer, type ProcessRunner } from './tts';

function makeFakeRunner(result: Buffer | Error) {
  const calls: Array<{ binaryPath: string; args: string[]; input: string }> = [];
  const runProcess: ProcessRunner = async (binaryPath, args, input) => {
    calls.push({ binaryPath, args, input });
    if (result instanceof Error) throw result;
    return result;
  };
  return { runProcess, calls };
}

describe('LocalSpeechSynthesizer', () => {
  it('spawns the configured piper binary with --model <modelDir>/<languageCode>.onnx and --output_file -', async () => {
    const fakeWav = Buffer.from([1, 2, 3]);
    const fake = makeFakeRunner(fakeWav);
    const synth = new LocalSpeechSynthesizer('piper', '/opt/piper-voices', fake.runProcess);

    const result = await synth.synthesize('hola mundo', 'es-ES');

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].binaryPath, 'piper');
    assert.deepEqual(fake.calls[0].args, ['--model', join('/opt/piper-voices', 'es-ES.onnx'), '--output_file', '-']);
    assert.equal(fake.calls[0].input, 'hola mundo');
    assert.equal(result.mime, 'audio/wav');
    assert.deepEqual([...result.buffer], [1, 2, 3]);
  });

  it('propagates an error from the process runner (e.g. missing binary or model file)', async () => {
    const fake = makeFakeRunner(new Error('piper salio con codigo 1: no voice model found'));
    const synth = new LocalSpeechSynthesizer('piper', '/opt/piper-voices', fake.runProcess);

    await assert.rejects(() => synth.synthesize('hola', 'es-ES'), /no voice model found/);
  });
});
