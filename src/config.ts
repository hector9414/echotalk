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
// src/providers/index.ts) - 'google' (default when PROVIDER=google) reuses
// the same Google Cloud credentials as STT/Translate; 'elevenlabs' needs the
// three ELEVENLABS_* vars below; 'piper' needs PIPER_MODEL_DIR below. When
// PROVIDER=local and TTS_PROVIDER isn't set explicitly, it defaults to
// 'piper' instead of 'google' - otherwise a "fully offline" setup would
// silently still call Google's cloud TTS.
export const TTS_PROVIDER_NAME = (process.env.TTS_PROVIDER ?? (PROVIDER_NAME === 'local' ? 'piper' : 'google')) as
  | 'google'
  | 'elevenlabs'
  | 'piper';

export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || undefined;
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || undefined;
// eleven_multilingual_v2 is the long-stable multilingual model id; ElevenLabs
// has newer/faster models (flash/turbo variants) - check your dashboard or
// GET /v1/models for the exact current model_id string before switching.
export const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

// --- Proveedor local (PROVIDER=local): sin nube, sin costo por uso, pero
// con calidad/latencia menores - ver "Proveedor local" en SPEC.md. Cada pieza
// habla por HTTP/subproceso con un servicio que el usuario corre por su
// cuenta; esta app nunca instala ni administra esos procesos, igual que
// nunca instala el SDK de Google Cloud.

// Servidor compatible con whisper.cpp (examples/server), ej.
// `./server -m ggml-base.bin --port 8178`. POST <url>/inference.
export const LOCAL_STT_URL = process.env.LOCAL_STT_URL || 'http://127.0.0.1:8178';

// Como los motores basados en Whisper no dan resultados parciales nativos
// (no hay streaming real), este intervalo controla cada cuánto se
// re-transcribe el audio acumulado para simular un subtítulo "interino".
export const LOCAL_STT_CHUNK_INTERVAL_MS = Number(process.env.LOCAL_STT_CHUNK_INTERVAL_MS ?? 2000);

// Duración de silencio (ms) antes de considerar que el orador terminó una
// frase y finalizar el segmento (dispara traducción + voz).
export const LOCAL_STT_SILENCE_MS = Number(process.env.LOCAL_STT_SILENCE_MS ?? 800);

// Umbral de energía RMS (sobre PCM16, rango 0-32767) por debajo del cual un
// bloque de audio se considera silencio. Depende del micrófono/ambiente -
// ajustar si el final de frase tarda demasiado o se corta a mitad de palabra.
export const LOCAL_STT_SILENCE_RMS_THRESHOLD = Number(process.env.LOCAL_STT_SILENCE_RMS_THRESHOLD ?? 500);

// Servidor LibreTranslate, ej. `libretranslate --port 5000`. POST <url>/translate.
export const LOCAL_TRANSLATE_URL = process.env.LOCAL_TRANSLATE_URL || 'http://127.0.0.1:5000';

// Binario de Piper (https://github.com/OHF-Voice/piper1-gpl) - por defecto
// se asume que 'piper' esta en el PATH del sistema.
export const PIPER_BINARY_PATH = process.env.PIPER_BINARY_PATH || 'piper';

// Carpeta con un archivo <languageId>.onnx (ej. es-ES.onnx, en-US.onnx) por
// cada idioma de LANGUAGES que se vaya a usar como destino de voz.
export const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || undefined;

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
