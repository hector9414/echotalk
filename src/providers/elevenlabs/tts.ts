import { TTS_SPEAKING_RATE } from '../../config';
import type { SpeechSynthesizer, SynthesizedAudio } from '../types';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  // ElevenLabs documents ~0.7-1.2 as the supported range (1.0 = normal) -
  // see TTS_SPEAKING_RATE in config.ts. Values outside that range are
  // rejected by their API, not clamped here.
  speed?: number;
}

// ElevenLabs' multilingual models infer the spoken language from the text
// itself and speak it with a single configured voice - unlike Google, there
// is no per-language voice table here. languageCode/voiceName from the
// SpeechSynthesizer interface are accepted (to satisfy the shared contract
// the pipeline calls through) but intentionally unused.
export class ElevenLabsSpeechSynthesizer implements SpeechSynthesizer {
  constructor(
    private readonly config: ElevenLabsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const url = `${ELEVENLABS_API_BASE}/text-to-speech/${this.config.voiceId}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: this.config.modelId,
        voice_settings: { speed: this.config.speed ?? TTS_SPEAKING_RATE },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `ElevenLabs Text-to-Speech fallo (HTTP ${response.status}): ${detail || response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, mime: 'audio/mpeg' };
  }
}
