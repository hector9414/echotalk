import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApiRouter } from './routes';
import { SessionManager } from './sessionManager';
import { AudioStore } from './audioStore';
import { PresenterAuth } from './auth';

describe('REST routes', () => {
  let server: http.Server;
  let baseUrl: string;
  let auth: PresenterAuth;
  let audioStore: AudioStore;

  before(async () => {
    auth = new PresenterAuth('654321');
    const sessionManager = new SessionManager();
    audioStore = new AudioStore();

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createApiRouter({
        auth,
        sessionManager,
        audioStore,
        networkInfo: { listenerUrls: ['http://192.168.1.50:3000/'], qrDataUrl: null },
      }),
    );

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/languages returns the curated list with only id+label', async () => {
    const res = await fetch(`${baseUrl}/api/languages`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    assert.deepEqual(Object.keys(body[0]).sort(), ['id', 'label']);
  });

  it('GET /api/session/status reflects the current session public state', async () => {
    const res = await fetch(`${baseUrl}/api/session/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'idle');
  });

  it('GET /api/network returns the injected network info', async () => {
    const res = await fetch(`${baseUrl}/api/network`);
    const body = await res.json();
    assert.deepEqual(body.listenerUrls, ['http://192.168.1.50:3000/']);
    assert.equal(body.qrDataUrl, null);
  });

  it('POST /api/presenter/login rejects a wrong PIN with 401', async () => {
    const res = await fetch(`${baseUrl}/api/presenter/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/presenter/login issues a usable token for the correct PIN', async () => {
    const res = await fetch(`${baseUrl}/api/presenter/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '654321' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token);
    assert.equal(auth.isValidToken(body.token), true);
  });

  it('GET /api/audio/:id returns 404 for an unknown clip', async () => {
    const res = await fetch(`${baseUrl}/api/audio/does-not-exist`);
    assert.equal(res.status, 404);
  });

  it('GET /api/audio/:id returns the stored clip with its mime type', async () => {
    audioStore.set('clip-1', { buffer: Buffer.from('fake-mp3'), mime: 'audio/mpeg' });
    const res = await fetch(`${baseUrl}/api/audio/clip-1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.toString(), 'fake-mp3');
  });
});
