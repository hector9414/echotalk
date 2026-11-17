import type { WebSocket, WebSocketServer } from 'ws';
import type { PresenterAuth } from '../auth';
import type { SessionManager } from '../sessionManager';
import type { TranslationPipeline } from '../pipeline';
import type { PresenterToServerMessage, ServerToPresenterMessage } from '../types';

export interface PresenterHubDeps {
  auth: PresenterAuth;
  sessionManager: SessionManager;
  pipeline: TranslationPipeline;
}

// Tracks authenticated presenter sockets (there can be more than one tab/
// device logged in with the PIN) and lets the rest of the app broadcast to
// all of them (e.g. stt_status). Only the connection whose start_session
// call created the current session is treated as the accepted audio source -
// see SPEC.md "Control de acceso del presentador": other authenticated
// connections can still send control commands (pause/resume/stop act as a
// kill switch) but their binary audio frames are ignored, so a second open
// tab can't corrupt the recognizer with interleaved audio.
export class PresenterHub {
  private readonly authedSockets = new Set<WebSocket>();

  broadcast(message: ServerToPresenterMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.authedSockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  attach(wss: WebSocketServer, deps: PresenterHubDeps): void {
    const { auth, sessionManager, pipeline } = deps;

    wss.on('connection', (ws: WebSocket) => {
      let authed = false;
      let ownsActiveSession = false;

      const send = (message: ServerToPresenterMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      };

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (authed && ownsActiveSession) pipeline.writeAudio(data);
          return;
        }

        let message: PresenterToServerMessage;
        try {
          message = JSON.parse(data.toString('utf8'));
        } catch {
          send({ type: 'error', message: 'Mensaje invalido' });
          return;
        }

        if (message.type === 'auth') {
          if (auth.isValidToken(message.token)) {
            authed = true;
            this.authedSockets.add(ws);
            send({ type: 'auth_ok' });
            send({ type: 'session_state', session: sessionManager.getSession() });
          } else {
            send({ type: 'auth_failed' });
          }
          return;
        }

        if (!authed) {
          send({ type: 'error', message: 'No autenticado' });
          return;
        }

        try {
          switch (message.type) {
            case 'start_session':
              sessionManager.start(message.sourceLanguage, message.targetLanguage);
              pipeline.start();
              ownsActiveSession = true;
              break;
            case 'pause_session':
              sessionManager.pause();
              pipeline.stop();
              break;
            case 'resume_session':
              sessionManager.resume();
              pipeline.start();
              break;
            case 'stop_session':
              pipeline.stop();
              sessionManager.stop();
              ownsActiveSession = false;
              break;
            default:
              send({ type: 'error', message: 'Comando desconocido' });
          }
        } catch (err) {
          send({ type: 'error', message: (err as Error).message });
        }
      });

      ws.on('close', () => {
        this.authedSockets.delete(ws);
        // Safety net: if the tab that owned the live mic capture drops
        // without sending stop_session, don't leave a stale session that
        // nothing can feed audio into anymore.
        if (ownsActiveSession) {
          pipeline.stop();
          sessionManager.stop();
        }
      });
    });
  }
}
