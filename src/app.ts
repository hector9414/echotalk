import http from 'http';
import https from 'https';
import path from 'path';
import express from 'express';
import { WebSocketServer, type Server as WSServer } from 'ws';
import { createApiRouter, type NetworkInfo } from './routes';
import { SessionManager } from './sessionManager';
import { AudioStore } from './audioStore';
import { TranslationPipeline } from './pipeline';
import { PresenterAuth } from './auth';
import { PresenterHub } from './ws/presenterSocket';
import { ListenerHub } from './ws/listenerSocket';
import { generateSelfSignedCert } from './tls';
import { ENABLE_HTTPS } from './config';
import type { TranslationProvider } from './providers/types';

export interface BuiltApp {
  server: http.Server;
  httpsServer: https.Server | null;
  auth: PresenterAuth;
  sessionManager: SessionManager;
  audioStore: AudioStore;
  pipeline: TranslationPipeline;
}

// Two WebSocketServer instances can share one http/https server, but only if
// dispatched manually by pathname like this: each instance's own automatic
// 'upgrade' listener calls abortHandshake(socket, 400) as soon as a request
// doesn't match ITS OWN path, which kills the connection before a second
// WebSocketServer on the same server ever gets a chance to look at it. Called
// once per underlying server (http AND https, when both exist) so presenter/
// listener WS connections work the same over either transport.
function attachWsUpgradeDispatch(
  server: http.Server | https.Server,
  presenterWss: WSServer,
  listenerWss: WSServer,
): void {
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
}

// Pure composition: wires the whole app (Express routes, static files, the
// two WebSocket hubs and the translation pipeline) around a given provider,
// and returns server(s) that nothing has called listen() on yet. Kept
// separate from server.ts's listen()/banner-printing side effects so tests
// can build a real, fully-wired server on an ephemeral port without needing
// real Google Cloud credentials (just pass a fake TranslationProvider).
//
// lanIps feeds the HTTPS certificate's subjectAltName (see src/tls.ts) - pass
// [] if unknown/irrelevant (e.g. in tests that only touch localhost).
export function buildApp(provider: TranslationProvider, networkInfo: NetworkInfo, lanIps: string[]): BuiltApp {
  const auth = new PresenterAuth();
  const audioStore = new AudioStore();
  const sessionManager = new SessionManager();

  const presenterHub = new PresenterHub();
  const listenerHub = new ListenerHub(sessionManager, provider, audioStore, {
    onAudienceQuestion: (question) => presenterHub.broadcast({ type: 'audience_question', question }),
  });

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

  const presenterWss = new WebSocketServer({ noServer: true });
  const listenerWss = new WebSocketServer({ noServer: true });
  presenterHub.attach(presenterWss, { auth, sessionManager, pipeline });
  listenerHub.attach(listenerWss);

  // The same Express app instance (it's just a request-handler function)
  // backs both servers - no need for two copies of the routes/static files.
  const server = http.createServer(app);
  attachWsUpgradeDispatch(server, presenterWss, listenerWss);

  let httpsServer: https.Server | null = null;
  if (ENABLE_HTTPS) {
    const { cert, key } = generateSelfSignedCert(lanIps);
    httpsServer = https.createServer({ cert, key }, app);
    attachWsUpgradeDispatch(httpsServer, presenterWss, listenerWss);
  }

  return { server, httpsServer, auth, sessionManager, audioStore, pipeline };
}
