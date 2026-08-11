import type { WebSocket, WebSocketServer } from 'ws';
import { LISTENER_COUNT_DEBOUNCE_MS } from '../config';
import type { SessionManager } from '../sessionManager';
import type { ServerToListenerMessage } from '../types';

// Tracks connected listener sockets and broadcasts session/segment updates
// to all of them. Listeners are unauthenticated by design (see SPEC.md) -
// anyone reachable on the LAN can connect. A listener that joins mid-session
// only gets the current session_state, never prior segments: the server
// keeps no per-client history, and each browser's own scroll-back starts
// fresh on connect.
export class ListenerHub {
  private readonly clients = new Set<WebSocket>();
  private countTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sessionManager: SessionManager) {}

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      this.send(ws, { type: 'session_state', session: this.sessionManager.getPublicState() });
      this.scheduleListenerCountUpdate();

      ws.on('close', () => {
        this.clients.delete(ws);
        this.scheduleListenerCountUpdate();
      });
      ws.on('error', () => {
        this.clients.delete(ws);
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
