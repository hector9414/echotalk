import 'dotenv/config';
import type { LanguageOption } from './types';

export const PORT = Number(process.env.PORT ?? 3000);

// HTTPS is on by default: it's what lets a phone act as the presenter (its
// own mic) when the machine running the server has none, since getUserMedia
// needs a secure context and a LAN IP over plain HTTP never qualifies - see
// src/tls.ts. Listeners keep using plain HTTP on PORT (no certificate
// warning for the audience). Set ENABLE_HTTPS=false to turn it off entirely.
export const ENABLE_HTTPS = process.env.ENABLE_HTTPS !== 'false';
export const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3443);

export const PROVIDER_NAME = (process.env.PROVIDER ?? 'google') as 'google' | 'local';

export const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;

// Voice synthesis can be swapped independently of STT/translation (see
// src/providers/index.ts) - 'google' (default) reuses the same Google Cloud
// credentials as STT/Translate; 'elevenlabs' needs the three vars below.
export const TTS_PROVIDER_NAME = (process.env.TTS_PROVIDER ?? 'google') as 'google' | 'elevenlabs';

export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || undefined;
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || undefined;
// eleven_multilingual_v2 is the long-stable multilingual model id; ElevenLabs
// has newer/faster models (flash/turbo variants) - check your dashboard or
// GET /v1/models for the exact current model_id string before switching.
export const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

// Google Cloud Speech-to-Text caps a single streaming session at 5 minutes.
// Restart comfortably before that so the replacement stream is warmed up
// (via the replay buffer) before the old one would be cut off.
export const STT_RESTART_INTERVAL_MS = 4 * 60 * 1000;
export const STT_REPLAY_BUFFER_MS = 2000;

// Defensive cap so an unusually long session doesn't grow memory forever.
export const MAX_SEGMENTS_IN_MEMORY = 200;

export const LISTENER_COUNT_DEBOUNCE_MS = 500;

// Google Cloud Text-to-Speech rejects requests over 5000 bytes of input.
// Segments are per-utterance and should never get close, but this is the
// threshold used to defensively split text into sentence-sized chunks if one ever does.
export const TTS_SAFE_BYTE_LIMIT = 4500;

export const DEFAULT_SOURCE_LANGUAGE = 'es-ES';
export const DEFAULT_TARGET_LANGUAGE = 'en-US';

// Google Speech-to-Text, Cloud Translation and Text-to-Speech each use their
// own language code format (see SPEC.md), so language selection is driven by
// this curated table rather than free text. Codes below reflect Google Cloud's
// documented language support at time of writing - reconfirm against the
// current Speech-to-Text / Translation / Text-to-Speech supported-languages
// docs before adding a pair whose codes you're not sure of.
export const LANGUAGES: LanguageOption[] = [
  { id: 'es-ES', label: 'Español (España)', sttCode: 'es-ES', translateCode: 'es', ttsLanguageCode: 'es-ES' },
  { id: 'es-US', label: 'Español (Latinoamérica)', sttCode: 'es-US', translateCode: 'es', ttsLanguageCode: 'es-US' },
  { id: 'en-US', label: 'Inglés (Estados Unidos)', sttCode: 'en-US', translateCode: 'en', ttsLanguageCode: 'en-US' },
  { id: 'en-GB', label: 'Inglés (Reino Unido)', sttCode: 'en-GB', translateCode: 'en', ttsLanguageCode: 'en-GB' },
  { id: 'pt-BR', label: 'Portugués (Brasil)', sttCode: 'pt-BR', translateCode: 'pt', ttsLanguageCode: 'pt-BR' },
  { id: 'fr-FR', label: 'Francés (Francia)', sttCode: 'fr-FR', translateCode: 'fr', ttsLanguageCode: 'fr-FR' },
  { id: 'de-DE', label: 'Alemán (Alemania)', sttCode: 'de-DE', translateCode: 'de', ttsLanguageCode: 'de-DE' },
  { id: 'it-IT', label: 'Italiano (Italia)', sttCode: 'it-IT', translateCode: 'it', ttsLanguageCode: 'it-IT' },
  { id: 'zh-CN', label: 'Chino (mandarín simplificado)', sttCode: 'cmn-Hans-CN', translateCode: 'zh-CN', ttsLanguageCode: 'cmn-CN' },
  { id: 'ja-JP', label: 'Japonés', sttCode: 'ja-JP', translateCode: 'ja', ttsLanguageCode: 'ja-JP' },
];

export function getLanguageOption(id: string): LanguageOption | undefined {
  return LANGUAGES.find((option) => option.id === id);
}
