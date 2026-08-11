import { GoogleSttStreamManager } from './google/speechStream';
import { GoogleTranslator } from './google/translate';
import { GoogleSpeechSynthesizer } from './google/tts';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from './types';

export type { TranslationProvider, RecognitionHandlers, SpeechRecognizer, Translator, SpeechSynthesizer, SynthesizedAudio } from './types';

function createGoogleProvider(): TranslationProvider {
  return {
    createRecognizer(languageCode: string, handlers: RecognitionHandlers): SpeechRecognizer {
      return new GoogleSttStreamManager(languageCode, handlers);
    },
    translator: new GoogleTranslator(),
    synthesizer: new GoogleSpeechSynthesizer(),
  };
}

// The pipeline, session manager and routes only ever depend on the
// TranslationProvider interface (src/providers/types.ts) - never on Google's
// concrete classes directly - so a future 'local' provider (faster-whisper +
// LibreTranslate/Argos + Piper, run as local sidecar processes) can be added
// here without touching anything else.
export function createProvider(name: 'google' | 'local'): TranslationProvider {
  if (name === 'google') return createGoogleProvider();
  throw new Error(
    `Proveedor '${name}' no esta implementado todavia. Solo 'google' esta disponible en esta version ` +
      `(la interfaz en providers/types.ts ya esta lista para agregarlo sin tocar el resto del pipeline).`,
  );
}
