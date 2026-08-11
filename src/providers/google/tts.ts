import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { SpeechSynthesizer, SynthesizedAudio } from '../types';

let sharedClient: TextToSpeechClient | undefined;
function getTtsClient(): TextToSpeechClient {
  if (!sharedClient) sharedClient = new TextToSpeechClient();
  return sharedClient;
}

export class GoogleSpeechSynthesizer implements SpeechSynthesizer {
  private readonly client: TextToSpeechClient;

  constructor(client: TextToSpeechClient = getTtsClient()) {
    this.client = client;
  }

  async synthesize(text: string, languageCode: string, voiceName?: string): Promise<SynthesizedAudio> {
    const [response] = await this.client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
        ssmlGender: voiceName ? undefined : 'NEUTRAL',
      },
      audioConfig: { audioEncoding: 'MP3' },
    });

    if (!response.audioContent) {
      throw new Error('Text-to-Speech no devolvio audio para el segmento');
    }

    const buffer = Buffer.isBuffer(response.audioContent)
      ? response.audioContent
      : Buffer.from(response.audioContent as Uint8Array);

    return { buffer, mime: 'audio/mpeg' };
  }
}
