import type { WebSocket } from 'ws';
import { getLanguageOption } from '../config';
import type { SessionManager } from '../sessionManager';
import type { LanguageOption } from '../types';
import type { AudienceQuestion } from '../types';
import type { SpeechRecognizer, TranslationProvider } from '../providers/types';

export interface QuestionFloorEvents {
  onFloorBusy?: () => void;
  onFloorFree?: () => void;
  onQuestion?: (question: AudienceQuestion) => void;
}

// At most one audience member can hold the floor (be actively asking a
// question with their mic) at a time - see SPEC.md "Preguntas del público".
// Keeps its own short-lived SpeechRecognizer, separate from the main
// presenter pipeline and from SessionManager's transcript segments: a
// question is a one-off side-channel to the presenter, not part of the
// broadcast transcript, and never needs the presenter pipeline's segment
// bookkeeping.
export class QuestionFloor {
  private asker: WebSocket | null = null;
  private recognizer: SpeechRecognizer | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly provider: TranslationProvider,
    private readonly events: QuestionFloorEvents = {},
  ) {}

  isBusy(): boolean {
    return this.asker !== null;
  }

  isCurrentAsker(ws: WebSocket): boolean {
    return this.asker === ws;
  }

  // Returns an error message if the request is rejected, or null once granted.
  request(ws: WebSocket, languageId: string): string | null {
    const session = this.sessionManager.getSession();
    if (session.status === 'idle') {
      return 'No hay una sesión activa en este momento.';
    }
    if (this.isBusy()) {
      return 'Otra persona está preguntando ahora mismo - espera a que termine.';
    }

    const askerLang = getLanguageOption(languageId);
    const presenterLang = getLanguageOption(session.sourceLanguage);
    if (!askerLang) {
      return 'Elige un idioma válido antes de preguntar.';
    }
    if (!presenterLang) {
      return 'No se pudo determinar el idioma del presentador.';
    }

    this.asker = ws;
    this.recognizer = this.provider.createRecognizer(askerLang.sttCode, {
      onInterim: () => {},
      onFinal: (text) => this.handleFinal(askerLang, presenterLang, text),
      onError: (err) => console.error('Error de reconocimiento en pregunta del público:', err.message),
    });
    this.events.onFloorBusy?.();
    return null;
  }

  writeAudio(ws: WebSocket, chunk: Buffer): void {
    if (this.isCurrentAsker(ws)) {
      this.recognizer?.write(chunk);
    }
  }

  // Safe to call from anyone (explicit "end_question", disconnect, or the
  // session itself ending) - a no-op if nobody currently holds the floor.
  release(): void {
    if (!this.asker) return;
    this.recognizer?.stop();
    this.recognizer = null;
    this.asker = null;
    this.events.onFloorFree?.();
  }

  private handleFinal(askerLang: LanguageOption, presenterLang: LanguageOption, text: string): void {
    if (!text.trim()) return;
    this.provider.translator
      .translate(text, askerLang.translateCode, presenterLang.translateCode)
      .then((translatedText) => {
        this.events.onQuestion?.({
          sourceText: text,
          sourceLanguageLabel: askerLang.label,
          translatedText,
        });
      })
      .catch((err: Error) => {
        console.error('Error traduciendo pregunta del público:', err.message);
      });
  }
}
