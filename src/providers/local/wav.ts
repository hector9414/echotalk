// Wraps raw LINEAR16 PCM (mono) in a standard 44-byte WAV header so it can be
// uploaded as a normal audio file to a local STT server (e.g. whisper.cpp's
// examples/server, which expects a multipart file upload, not a raw PCM
// stream like Google's gRPC API accepts directly).
export function pcm16ToWav(pcm: Buffer, sampleRateHertz: number): Buffer {
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = sampleRateHertz * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format tag
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRateHertz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
