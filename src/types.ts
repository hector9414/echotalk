export type SessionStatus = 'idle' | 'live' | 'paused';

export interface LanguageOption {
  id: string; // e.g. 'es-ES' - used everywhere in the app and over the wire
  label: string; // human-readable, shown in dropdowns
  sttCode: string; // BCP-47 code for Speech-to-Text
  translateCode: string; // ISO 639-1 (or Google-specific) code for Cloud Translation
  ttsLanguageCode: string; // BCP-47 code for Text-to-Speech
  ttsVoiceName?: string; // optional specific voice; Google picks a default when omitted
}

export interface Session {
  id: string;
  status: SessionStatus;
  sourceLanguage: string; // LanguageOption id
  targetLanguage: string; // LanguageOption id
  startedAt: number | null;
  listenerCount: number;
}

export type SessionPublicState = Pick<
  Session,
  'status' | 'sourceLanguage' | 'targetLanguage' | 'listenerCount'
>;

export interface TranscriptSegment {
  id: string;
  seq: number;
  sourceText: string; // mutates while isFinal=false
  translatedText: string | null; // set only once finalized
  audioUrl: string | null; // set only once finalized
  isFinal: boolean;
  updatedAt: number;
}

// Presenter -> Server control messages (JSON, text WS frames).
// Microphone audio is sent separately as raw binary WS frames on the same socket.
export type PresenterToServerMessage =
  | { type: 'auth'; token: string }
  | { type: 'start_session'; sourceLanguage: string; targetLanguage: string }
  | { type: 'pause_session' }
  | { type: 'resume_session' }
  | { type: 'stop_session' };

export interface AudienceQuestion {
  sourceText: string;
  sourceLanguageLabel: string;
  translatedText: string;
}

// Server -> Presenter
// Segment updates are echoed to the presenter too (same shape as sent to
// listeners) so they can see their own live transcript + translation.
export type ServerToPresenterMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_failed' }
  | { type: 'session_state'; session: Session }
  | { type: 'segment_update'; segment: TranscriptSegment }
  | { type: 'segment_final'; segment: TranscriptSegment }
  | { type: 'stt_status'; status: 'connected' | 'reconnecting' | 'error' }
  | { type: 'audience_question'; question: AudienceQuestion }
  | { type: 'error'; message: string };

// Listener -> Server (JSON control messages; the asker's mic audio is sent
// separately as raw binary WS frames on the same socket, only while they
// hold the question floor - see src/ws/questionFloor.ts).
export type ListenerToServerMessage =
  | { type: 'request_question'; language: string }
  | { type: 'end_question' };

// Server -> Listener
export type ServerToListenerMessage =
  | { type: 'session_state'; session: SessionPublicState }
  | { type: 'segment_update'; segment: TranscriptSegment }
  | { type: 'segment_final'; segment: TranscriptSegment }
  | { type: 'session_ended' }
  | { type: 'question_granted' }
  | { type: 'question_denied'; reason: string }
  | { type: 'question_floor_busy' }
  | { type: 'question_floor_free' };
