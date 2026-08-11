import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createApiRouter, type NetworkInfo } from './routes';
import { SessionManager } from './sessionManager';
import { AudioStore } from './audioStore';
import { TranslationPipeline } from './pipeline';
import { PresenterAuth } from './auth';
import { PresenterHub } from './ws/presenterSocket';
import { ListenerHub } from './ws/listenerSocket';
import type { TranslationProvider } from './providers/types';

export interface BuiltApp {
  server: http.Server;
  auth: PresenterAuth;
  sessionManager: SessionManager;
  audioStore: AudioStore;
  pipeline: TranslationPipeline;
}

// Pure composition: wires the whole app (Express routes, static files, the
// two WebSocket hubs and the translation pipeline) around a given provider,
// and returns an http.Server that nothing has called listen() on yet. Kept
// separate from server.ts's listen()/banner-printing side effects so tests
// can build a real, fully-wired server on an ephemeral port without needing
// real Google Cloud credentials (just pass a fake TranslationProvider).
export function buildApp(provider: TranslationProvider, networkInfo: NetworkInfo): BuiltApp {
  const auth = new PresenterAuth();
  const audioStore = new AudioStore();
  const sessionManager = new SessionManager();

  const presenterHub = new PresenterHub();
  const listenerHub = new ListenerHub(sessionManager);

  sessionManager.onSessionChange((session) => {
    presenterHub.broadcast({ type: 'session_state', session });
    listenerHub.broadcast({ type: 'session_state', session: sessionManager.getPublicState() });
  });
  sessionManager.onSegmentUpdate((segment) => {
    listenerHub.broadcast({ type: 'segment_update', segment });
    presenterHub.broadcast({ type: 'segment_update', segment });
  });
  sessionManager.onSegmentFinal((segment) => {
    listenerHub.broadcast({ type: 'segment_final', segment });
    presenterHub.broadcast({ type: 'segment_final', segment });
  });
  sessionManager.onSessionEnded(() => {
    audioStore.clear();
    listenerHub.broadcast({ type: 'session_ended' });
  });

  const pipeline = new TranslationPipeline(sessionManager, audioStore, provider, {
    onSttStatus: (status) => presenterHub.broadcast({ type: 'stt_status', status }),
  });

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ auth, sessionManager, audioStore, networkInfo }));
  app.use('/shared', express.static(path.join(__dirname, '../public/shared')));
  app.use('/presenter', express.static(path.join(__dirname, '../public/presenter')));
  app.use('/', express.static(path.join(__dirname, '../public/listen')));

  const server = http.createServer(app);

  // Two WebSocketServer instances share this one http.Server. They're
  // created with `noServer: true` and dispatched manually by pathname below
  // rather than each given its own `path` option: ws's automatic per-instance
  // 'upgrade' listener calls abortHandshake(socket, 400) as soon as a request
  // doesn't match ITS OWN path, which kills the connection before a second
  // WebSocketServer on the same http.Server ever gets a chance to look at it.
  const presenterWss = new WebSocketServer({ noServer: true });
  const listenerWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '', 'http://internal').pathname;
    if (pathname === '/ws/presenter') {
      presenterWss.handleUpgrade(request, socket, head, (ws) => {
        presenterWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/listen') {
      listenerWss.handleUpgrade(request, socket, head, (ws) => {
        listenerWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  presenterHub.attach(presenterWss, { auth, sessionManager, pipeline });
  listenerHub.attach(listenerWss);

  return { server, auth, sessionManager, audioStore, pipeline };
}
