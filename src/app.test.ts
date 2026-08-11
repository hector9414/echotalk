import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { WebSocket } from 'ws';
import { buildApp } from './app';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from './providers/types';

// This file exercises the real WS wiring end to end (both hubs sharing one
// http.Server, auth, and the session lifecycle broadcasting to both
// presenter and listener) using a no-op fake provider - it caught a real bug
// during development: two WebSocketServer instances attached to the same
// http.Server via {server, path} silently abort any request that doesn't
// match the FIRST one's path, before the second ever gets a chance. See the
// comment in app.ts above the upgrade dispatch for the fix.
function makeNoopProvider(): TranslationProvider {
  return {
    createRecognizer(_languageCode: string, _handlers: RecognitionHandlers): SpeechRecognizer {
      return { write() {}, stop() {} };
    },
    translator: {
      async translate(text: string) {
        return text;
      },
    },
    synthesizer: {
      async synthesize() {
        return { buffer: Buffer.from(''), mime: 'audio/mpeg' };
      },
    },
  };
}

async function startTestServer() {
  const built = buildApp(makeNoopProvider(), { listenerUrls: [], qrDataUrl: null });
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  const { port } = built.server.address() as AddressInfo;
  return {
    ...built,
    baseUrl: `http://localhost:${port}`,
    wsBaseUrl: `ws://localhost:${port}`,
  };
}

function stopTestServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, opened };
}

function waitForMessage(
  ws: WebSocket,
  predicate: (message: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for expected WS message')), timeoutMs);
    const handler = (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8'));
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(message);
      }
    };
    ws.on('message', handler);
  });
}

describe('app wiring', () => {
  it('accepts connections on both /ws/presenter and /ws/listen sharing one http.Server', async () => {
    const test = await startTestServer();
    try {
      const presenter = connect(`${test.wsBaseUrl}/ws/presenter`);
      const listener = connect(`${test.wsBaseUrl}/ws/listen`);
      await Promise.all([presenter.opened, listener.opened]);
      presenter.ws.close();
      listener.ws.close();
    } finally {
      await stopTestServer(test.server);
    }
  });

  it('destroys the connection for an unknown WS path', async () => {
    const test = await startTestServer();
    try {
      const unknown = connect(`${test.wsBaseUrl}/ws/unknown`);
      await assert.rejects(() => unknown.opened);
    } finally {
      await stopTestServer(test.server);
    }
  });

  it('runs start -> broadcast -> stop over WS, reaching both presenter and listener', async () => {
    const test = await startTestServer();
    try {
      const presenter = connect(`${test.wsBaseUrl}/ws/presenter`);
      const listener = connect(`${test.wsBaseUrl}/ws/listen`);
      await Promise.all([presenter.opened, listener.opened]);

      const loginRes = await fetch(`${test.baseUrl}/api/presenter/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: test.auth.pin }),
      });
      const { token } = await loginRes.json();

      presenter.ws.send(JSON.stringify({ type: 'auth', token }));
      await waitForMessage(presenter.ws, (m) => m.type === 'auth_ok');

      presenter.ws.send(
        JSON.stringify({ type: 'start_session', sourceLanguage: 'es-ES', targetLanguage: 'en-US' }),
      );
      const listenerLive = await waitForMessage(
        listener.ws,
        (m) => m.type === 'session_state' && m.session.status === 'live',
      );
      assert.equal(listenerLive.session.sourceLanguage, 'es-ES');
      assert.equal(listenerLive.session.targetLanguage, 'en-US');

      presenter.ws.send(JSON.stringify({ type: 'stop_session' }));
      await waitForMessage(listener.ws, (m) => m.type === 'session_ended');

      presenter.ws.close();
      listener.ws.close();
    } finally {
      await stopTestServer(test.server);
    }
  });

  it('rejects presenter commands sent before authentication', async () => {
    const test = await startTestServer();
    try {
      const presenter = connect(`${test.wsBaseUrl}/ws/presenter`);
      await presenter.opened;

      presenter.ws.send(
        JSON.stringify({ type: 'start_session', sourceLanguage: 'es-ES', targetLanguage: 'en-US' }),
      );
      const response = await waitForMessage(presenter.ws, (m) => m.type === 'error');
      assert.match(response.message, /no autenticado/i);

      presenter.ws.close();
    } finally {
      await stopTestServer(test.server);
    }
  });
});
