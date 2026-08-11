// Provider-agnostic interface for the speech/translation engine. The only
// implementation built in v1 lives in providers/google/*; a future 'local'
// implementation (faster-whisper + LibreTranslate/Argos + Piper, run as local
// sidecar processes) can be added later without touching the pipeline or the
// session/data model, as long as it implements these same interfaces.

export interface RecognitionHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

export interface SpeechRecognizer {
  write(chunk: Buffer): void;
  stop(): void;
}

export interface Translator {
  translate(text: string, fromCode: string, toCode: string): Promise<string>;
}

export interface SynthesizedAudio {
  buffer: Buffer;
  mime: string;
}

export interface SpeechSynthesizer {
  synthesize(text: string, languageCode: string, voiceName?: string): Promise<SynthesizedAudio>;
}

export interface TranslationProvider {
  createRecognizer(languageCode: string, handlers: RecognitionHandlers): SpeechRecognizer;
  translator: Translator;
  synthesizer: SpeechSynthesizer;
}
