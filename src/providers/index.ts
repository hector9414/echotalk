import {
  ELEVENLABS_API_KEY,
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_VOICE_ID,
  PIPER_BINARY_PATH,
  PIPER_MODEL_DIR,
} from '../config';
import { GoogleSttStreamManager } from './google/speechStream';
import { GoogleTranslator } from './google/translate';
import { GoogleSpeechSynthesizer } from './google/tts';
import { ElevenLabsSpeechSynthesizer } from './elevenlabs/tts';
import { LocalSttStreamManager } from './local/sttStream';
import { LocalTranslator } from './local/translator';
import { LocalSpeechSynthesizer } from './local/tts';
import type { RecognitionHandlers, SpeechRecognizer, SpeechSynthesizer, TranslationProvider } from './types';

export type { TranslationProvider, RecognitionHandlers, SpeechRecognizer, Translator, SpeechSynthesizer, SynthesizedAudio } from './types';

export type TtsProviderName = 'google' | 'elevenlabs' | 'piper';

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

function createPiperSynthesizer(): SpeechSynthesizer {
  if (!PIPER_MODEL_DIR) {
    throw new Error('Falta PIPER_MODEL_DIR en .env para usar TTS_PROVIDER=piper (o PROVIDER=local).');
  }
  return new LocalSpeechSynthesizer(PIPER_BINARY_PATH, PIPER_MODEL_DIR);
}

function createSynthesizer(ttsProviderName: TtsProviderName): SpeechSynthesizer {
  if (ttsProviderName === 'elevenlabs') return createElevenLabsSynthesizer();
  if (ttsProviderName === 'piper') return createPiperSynthesizer();
  return new GoogleSpeechSynthesizer();
}

// STT + translation come from Google; only voice synthesis is swappable
// today via TTS_PROVIDER, since ElevenLabs' strength is specifically voice
// quality - see SPEC.md.
function createGoogleProvider(ttsProviderName: TtsProviderName): TranslationProvider {
  return {
    createRecognizer(languageCode: string, handlers: RecognitionHandlers): SpeechRecognizer {
      return new GoogleSttStreamManager(languageCode, handlers);
    },
    translator: new GoogleTranslator(),
    synthesizer: createSynthesizer(ttsProviderName),
  };
}

// Free/offline stack: a whisper.cpp-compatible server for STT (chunked, not
// true streaming - see sttStream.ts), LibreTranslate for translation, and
// Piper (default) or any other TTS provider for voice. None of these
// processes are installed/managed by this app - the user runs them
// separately, same as Google Cloud credentials aren't provisioned by this
// app either. See "Proveedor local" in SPEC.md for setup, costs and the
// latency/quality tradeoffs versus the Google provider.
function createLocalProvider(ttsProviderName: TtsProviderName): TranslationProvider {
  return {
    createRecognizer(languageCode: string, handlers: RecognitionHandlers): SpeechRecognizer {
      return new LocalSttStreamManager(languageCode, handlers);
    },
    translator: new LocalTranslator(),
    synthesizer: createSynthesizer(ttsProviderName),
  };
}

// The pipeline, session manager and routes only ever depend on the
// TranslationProvider interface (src/providers/types.ts) - never on a
// provider's concrete classes directly - which is what let 'local' get added
// here without touching anything else.
export function createProvider(
  name: 'google' | 'local',
  ttsProviderName: TtsProviderName = 'google',
): TranslationProvider {
  if (name === 'google') return createGoogleProvider(ttsProviderName);
  return createLocalProvider(ttsProviderName);
}
