import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getLanguageOption, MAX_SEGMENTS_IN_MEMORY } from './config';
import type { Session, SessionPublicState, TranscriptSegment } from './types';

function freshSession(): Session {
  return { id: '', status: 'idle', sourceLanguage: '', targetLanguage: '', startedAt: null, listenerCount: 0 };
}

// Single in-memory Session for this server process (v1 is intentionally
// single-session/single-room, see SPEC.md "Fuera de alcance"). Owns the
// session lifecycle and the transcript segments for the current session;
// nothing here is persisted. Emits events so the WS hubs can broadcast
// changes without SessionManager needing to know they exist (avoids a
// constructor-time circular dependency between SessionManager and the hubs).
export class SessionManager extends EventEmitter {
  private session: Session = freshSession();
  private segments: TranscriptSegment[] = [];
  private segmentsById = new Map<string, TranscriptSegment>();
  private nextSeq = 0;

  getSession(): Session {
    return { ...this.session };
  }

  getPublicState(): SessionPublicState {
    const { status, sourceLanguage, targetLanguage, listenerCount } = this.session;
    return { status, sourceLanguage, targetLanguage, listenerCount };
  }

  getSegments(): TranscriptSegment[] {
    return [...this.segments];
  }

  isLive(): boolean {
    return this.session.status === 'live';
  }

  start(sourceLanguage: string, targetLanguage: string): void {
    if (this.session.status !== 'idle') {
      throw new Error('Ya hay una sesion activa; deten la sesion actual antes de iniciar otra.');
    }
    if (!getLanguageOption(sourceLanguage)) {
      throw new Error(`Idioma de origen desconocido: ${sourceLanguage}`);
    }
    if (!getLanguageOption(targetLanguage)) {
      throw new Error(`Idioma de destino desconocido: ${targetLanguage}`);
    }

    this.segments = [];
    this.segmentsById.clear();
    this.nextSeq = 0;
    this.session = {
      id: randomUUID(),
      status: 'live',
      sourceLanguage,
      targetLanguage,
      startedAt: Date.now(),
      listenerCount: this.session.listenerCount,
    };
    this.emitSessionChange();
  }

  pause(): void {
    if (this.session.status !== 'live') {
      throw new Error('Solo se puede pausar una sesion en vivo.');
    }
    this.session = { ...this.session, status: 'paused' };
    this.emitSessionChange();
  }

  resume(): void {
    if (this.session.status !== 'paused') {
      throw new Error('Solo se puede reanudar una sesion en pausa.');
    }
    this.session = { ...this.session, status: 'live' };
    this.emitSessionChange();
  }

  // Idempotent by design: stop() is also the panel's "kill switch", and a
  // stray double-click or duplicate WS message shouldn't surface an error.
  stop(): void {
    if (this.session.status === 'idle') return;
    const listenerCount = this.session.listenerCount;
    this.session = { ...freshSession(), listenerCount };
    this.segments = [];
    this.segmentsById.clear();
    this.nextSeq = 0;
    this.emit('sessionEnded');
    this.emitSessionChange();
  }

  setListenerCount(count: number): void {
    if (this.session.listenerCount === count) return;
    this.session = { ...this.session, listenerCount: count };
    this.emitSessionChange();
  }

  // Called by the pipeline on the first interim result of a new utterance.
  createSegment(sourceText: string): TranscriptSegment {
    const segment: TranscriptSegment = {
      id: randomUUID(),
      seq: this.nextSeq++,
      sourceText,
      translatedText: null,
      audioUrl: null,
      isFinal: false,
      updatedAt: Date.now(),
    };
    this.segments.push(segment);
    this.segmentsById.set(segment.id, segment);
    this.trimSegments();
    this.emit('segmentUpdate', segment);
    return segment;
  }

  updateSegmentInterim(id: string, sourceText: string): void {
    const segment = this.segmentsById.get(id);
    if (!segment || segment.isFinal) return;
    segment.sourceText = sourceText;
    segment.updatedAt = Date.now();
    this.emit('segmentUpdate', segment);
  }

  finalizeSegment(id: string, translatedText: string, audioUrl: string): void {
    const segment = this.segmentsById.get(id);
    if (!segment) return;
    segment.translatedText = translatedText;
    segment.audioUrl = audioUrl;
    segment.isFinal = true;
    segment.updatedAt = Date.now();
    this.emit('segmentFinal', segment);
  }

  onSessionChange(listener: (session: Session) => void): this {
    this.on('sessionChange', listener);
    return this;
  }

  onSegmentUpdate(listener: (segment: TranscriptSegment) => void): this {
    this.on('segmentUpdate', listener);
    return this;
  }

  onSegmentFinal(listener: (segment: TranscriptSegment) => void): this {
    this.on('segmentFinal', listener);
    return this;
  }

  onSessionEnded(listener: () => void): this {
    this.on('sessionEnded', listener);
    return this;
  }

  private trimSegments(): void {
    while (this.segments.length > MAX_SEGMENTS_IN_MEMORY) {
      const removed = this.segments.shift();
      if (removed) this.segmentsById.delete(removed.id);
    }
  }

  private emitSessionChange(): void {
    this.emit('sessionChange', this.getSession());
  }
}
