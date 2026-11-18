import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { TTS_SPEAKING_RATE } from '../../config';
import type { SpeechSynthesizer, SynthesizedAudio } from '../types';

let sharedClient: TextToSpeechClient | undefined;
function getTtsClient(): TextToSpeechClient {
  if (!sharedClient) sharedClient = new TextToSpeechClient();
  return sharedClient;
}

export class GoogleSpeechSynthesizer implements SpeechSynthesizer {
  constructor(
    private readonly client: TextToSpeechClient = getTtsClient(),
    // Google accepts 0.25-4.0 (1.0 = normal) - see TTS_SPEAKING_RATE in
    // config.ts for why the default isn't 1.0.
    private readonly speakingRate: number = TTS_SPEAKING_RATE,
  ) {}

  async synthesize(text: string, languageCode: string, voiceName?: string): Promise<SynthesizedAudio> {
    const [response] = await this.client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
        ssmlGender: voiceName ? undefined : 'NEUTRAL',
      },
      audioConfig: { audioEncoding: 'MP3', speakingRate: this.speakingRate },
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
