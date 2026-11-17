import { ELEVENLABS_API_KEY, ELEVENLABS_MODEL_ID, ELEVENLABS_VOICE_ID } from '../config';
import { GoogleSttStreamManager } from './google/speechStream';
import { GoogleTranslator } from './google/translate';
import { GoogleSpeechSynthesizer } from './google/tts';
import { ElevenLabsSpeechSynthesizer } from './elevenlabs/tts';
import type { RecognitionHandlers, SpeechRecognizer, SpeechSynthesizer, TranslationProvider } from './types';

export type { TranslationProvider, RecognitionHandlers, SpeechRecognizer, Translator, SpeechSynthesizer, SynthesizedAudio } from './types';

export type TtsProviderName = 'google' | 'elevenlabs';

function createElevenLabsSynthesizer(): SpeechSynthesizer {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('Falta ELEVENLABS_API_KEY en .env para usar TTS_PROVIDER=elevenlabs.');
  }
  if (!ELEVENLABS_VOICE_ID) {
    throw new Error('Falta ELEVENLABS_VOICE_ID en .env para usar TTS_PROVIDER=elevenlabs.');
  }
  return new ElevenLabsSpeechSynthesizer({
    apiKey: ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_VOICE_ID,
    modelId: ELEVENLABS_MODEL_ID,
  });
}

function createSynthesizer(ttsProviderName: TtsProviderName): SpeechSynthesizer {
  if (ttsProviderName === 'elevenlabs') return createElevenLabsSynthesizer();
  return new GoogleSpeechSynthesizer();
}

// STT + translation still come from Google (createRecognizer/translator
// below); only voice synthesis is swappable today via TTS_PROVIDER, since
// ElevenLabs' strength is specifically voice quality - see SPEC.md.
function createGoogleProvider(ttsProviderName: TtsProviderName): TranslationProvider {
  return {
    createRecognizer(languageCode: string, handlers: RecognitionHandlers): SpeechRecognizer {
      return new GoogleSttStreamManager(languageCode, handlers);
    },
    translator: new GoogleTranslator(),
    synthesizer: createSynthesizer(ttsProviderName),
  };
}

// The pipeline, session manager and routes only ever depend on the
// TranslationProvider interface (src/providers/types.ts) - never on a
// provider's concrete classes directly - so a future 'local' provider
// (faster-whisper + LibreTranslate/Argos + Piper, run as local sidecar
// processes) can be added here without touching anything else.
export function createProvider(
  name: 'google' | 'local',
  ttsProviderName: TtsProviderName = 'google',
): TranslationProvider {
  if (name === 'google') return createGoogleProvider(ttsProviderName);
  throw new Error(
    `Proveedor '${name}' no esta implementado todavia. Solo 'google' esta disponible en esta version ` +
      `(la interfaz en providers/types.ts ya esta lista para agregarlo sin tocar el resto del pipeline).`,
  );
}
