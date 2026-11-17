import { Router } from 'express';
import type { AudioStore } from './audioStore';
import type { PresenterAuth } from './auth';
import { LANGUAGES } from './config';
import type { SessionManager } from './sessionManager';

export interface NetworkInfo {
  listenerUrls: string[];
  qrDataUrl: string | null;
}

export interface ApiRouterDeps {
  auth: PresenterAuth;
  sessionManager: SessionManager;
  audioStore: AudioStore;
  networkInfo: NetworkInfo;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const { auth, sessionManager, audioStore, networkInfo } = deps;
  const router = Router();

  router.get('/languages', (_req, res) => {
    res.json(LANGUAGES.map(({ id, label }) => ({ id, label })));
  });

  router.get('/network', (_req, res) => {
    res.json(networkInfo);
  });

  router.get('/session/status', (_req, res) => {
    res.json(sessionManager.getPublicState());
  });

  router.post('/presenter/login', (req, res) => {
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    const token = auth.login(pin);
    if (!token) {
      res.status(401).json({ error: 'PIN incorrecto' });
      return;
    }
    res.json({ token });
  });

  router.get('/audio/:id', (req, res) => {
    const clip = audioStore.get(req.params.id);
    if (!clip) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', clip.mime);
    res.set('Cache-Control', 'public, max-age=3600, immutable');
    res.send(clip.buffer);
  });

  return router;
}
