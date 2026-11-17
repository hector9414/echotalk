import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { SpeechSynthesizer, SynthesizedAudio } from '../types';

// Runs Piper (https://github.com/OHF-Voice/piper1-gpl) as a one-shot
// subprocess per utterance: text goes in on stdin, a WAV file comes back on
// stdout (`--output_file -` means "write to stdout"). No persistent server,
// no new npm dependency - same "plain child_process/fetch, no SDK" spirit as
// the ElevenLabs integration.
export type ProcessRunner = (binaryPath: string, args: string[], input: string) => Promise<Buffer>;

export function runPiperProcess(binaryPath: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(`piper salio con codigo ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// Piper has one model (.onnx file) per voice/language, unlike Google's single
// client with a languageCode parameter - so the model path is derived from a
// directory convention (<modelDir>/<languageCode>.onnx) rather than passed
// per call. See SPEC.md/README.md for how to name the files.
export class LocalSpeechSynthesizer implements SpeechSynthesizer {
  constructor(
    private readonly binaryPath: string,
    private readonly modelDir: string,
    private readonly runProcess: ProcessRunner = runPiperProcess,
  ) {}

  async synthesize(text: string, languageCode: string): Promise<SynthesizedAudio> {
    const modelPath = join(this.modelDir, `${languageCode}.onnx`);
    const buffer = await this.runProcess(this.binaryPath, ['--model', modelPath, '--output_file', '-'], text);
    return { buffer, mime: 'audio/wav' };
  }
}
