import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pcm16ToWav } from './wav';

describe('pcm16ToWav', () => {
  it('writes a valid 44-byte RIFF/WAVE/fmt /data header followed by the PCM bytes unchanged', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // 4 fake 16-bit samples
    const wav = pcm16ToWav(pcm, 16000);

    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
    assert.equal(wav.readUInt16LE(20), 1); // PCM
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(wav.readUInt32LE(24), 16000); // sample rate
    assert.equal(wav.readUInt16LE(34), 16); // bits per sample
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual([...wav.subarray(44)], [...pcm]);
  });

  it('scales byteRate/blockAlign with the given sample rate', () => {
    const wav = pcm16ToWav(Buffer.alloc(0), 8000);
    assert.equal(wav.readUInt32LE(24), 8000); // sample rate
    assert.equal(wav.readUInt32LE(28), 8000 * 2); // byte rate = rate * channels * bytesPerSample
    assert.equal(wav.readUInt16LE(32), 2); // block align = channels * bytesPerSample
  });
});
