import type { WebSocket, WebSocketServer } from 'ws';
import { LISTENER_COUNT_DEBOUNCE_MS } from '../config';
import type { SessionManager } from '../sessionManager';
import type { TranslationProvider } from '../providers/types';
import type { AudienceQuestion, ListenerToServerMessage, ServerToListenerMessage } from '../types';
import { QuestionFloor } from './questionFloor';

export interface ListenerHubEvents {
  onAudienceQuestion?: (question: AudienceQuestion) => void;
}

// Tracks connected listener sockets, broadcasts session/segment updates to
// all of them, and arbitrates the single-asker "question floor" (see
// src/ws/questionFloor.ts) so one audience member at a time can ask the
// presenter a question with their own mic, in their own language. Listeners
// are otherwise unauthenticated by design (see SPEC.md) - anyone reachable
// on the LAN can connect. A listener that joins mid-session only gets the
// current session_state, never prior segments: the server keeps no
// per-client history, and each browser's own scroll-back starts fresh on
// connect.
export class ListenerHub {
  private readonly clients = new Set<WebSocket>();
  private readonly questionFloor: QuestionFloor;
  private countTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    provider: TranslationProvider,
    events: ListenerHubEvents = {},
  ) {
    this.questionFloor = new QuestionFloor(sessionManager, provider, {
      onFloorBusy: () => this.broadcast({ type: 'question_floor_busy' }),
      onFloorFree: () => this.broadcast({ type: 'question_floor_free' }),
      onQuestion: (question) => events.onAudienceQuestion?.(question),
    });

    sessionManager.onSessionEnded(() => this.questionFloor.release());
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      this.send(ws, { type: 'session_state', session: this.sessionManager.getPublicState() });
      if (this.questionFloor.isBusy()) {
        this.send(ws, { type: 'question_floor_busy' });
      }
      this.scheduleListenerCountUpdate();

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.questionFloor.writeAudio(ws, data);
          return;
        }
        this.handleMessage(ws, data);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        if (this.questionFloor.isCurrentAsker(ws)) this.questionFloor.release();
        this.scheduleListenerCountUpdate();
      });
      ws.on('error', () => {
        this.clients.delete(ws);
        if (this.questionFloor.isCurrentAsker(ws)) this.questionFloor.release();
        this.scheduleListenerCountUpdate();
      });
    });
  }

  broadcast(message: ServerToListenerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  private handleMessage(ws: WebSocket, data: Buffer): void {
    let message: ListenerToServerMessage;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    switch (message.type) {
      case 'request_question': {
        const denialReason = this.questionFloor.request(ws, message.language);
        if (denialReason) {
          this.send(ws, { type: 'question_denied', reason: denialReason });
        } else {
          this.send(ws, { type: 'question_granted' });
        }
        break;
      }
      case 'end_question':
        if (this.questionFloor.isCurrentAsker(ws)) this.questionFloor.release();
        break;
      default:
        break;
    }
  }

  private send(ws: WebSocket, message: ServerToListenerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private scheduleListenerCountUpdate(): void {
    if (this.countTimer) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.sessionManager.setListenerCount(this.clients.size);
    }, LISTENER_COUNT_DEBOUNCE_MS);
  }
}
