import { LOCAL_TRANSLATE_URL } from '../../config';
import type { Translator } from '../types';

// Talks to a LibreTranslate-compatible HTTP server (run separately by the
// user - this app never installs/manages it, same as it never installs the
// Google Cloud SDK). POST /translate -> {translatedText}; see SPEC.md for
// setup. Mirrors GoogleTranslator's short-circuit on blank text and
// ElevenLabsSpeechSynthesizer's injected-fetch testing pattern.
export class LocalTranslator implements Translator {
  constructor(
    private readonly baseUrl: string = LOCAL_TRANSLATE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async translate(text: string, fromCode: string, toCode: string): Promise<string> {
    if (!text.trim()) return '';

    const response = await this.fetchImpl(`${this.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: fromCode, target: toCode, format: 'text' }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LibreTranslate fallo (HTTP ${response.status}): ${detail || response.statusText}`);
    }

    const data = (await response.json()) as { translatedText?: string };
    return data.translatedText ?? '';
  }
}
