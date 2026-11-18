import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type https from 'node:https';
import { WebSocket } from 'ws';
import { buildApp } from './app';
import type { RecognitionHandlers, SpeechRecognizer, TranslationProvider } from './providers/types';

// This file exercises the real WS wiring end to end (both hubs sharing the
// http AND https servers, auth, and the session lifecycle broadcasting to
// both presenter and listener) using a no-op fake provider - it caught a
// real bug during development: two WebSocketServer instances attached to the
// same http.Server via {server, path} silently abort any request that
// doesn't match the FIRST one's path, before the second ever gets a chance.
// See the comment in app.ts above the upgrade dispatch for the fix.
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

// Captures the handlers passed to the LAST createRecognizer() call so a test
// can manually fire onFinal(text) to simulate a finished utterance/question -
// used by the audience-question tests below, which need to control exactly
// when a "question" finishes being spoken.
function makeControllableProvider() {
  let lastHandlers: RecognitionHandlers | null = null;
  const provider: TranslationProvider = {
    createRecognizer(_languageCode, handlers) {
      lastHandlers = handlers;
      return { write() {}, stop() {} };
    },
    translator: {
      async translate(text, _from, to) {
        return `[${to}] ${text}`;
      },
    },
    synthesizer: {
      async synthesize() {
        return { buffer: Buffer.from(''), mime: 'audio/mpeg' };
      },
    },
  };
  return {
    provider,
    emitFinal: (text: string) => lastHandlers?.onFinal(text),
  };
}

interface TestServer {
  server: http.Server;
  httpsServer: https.Server | null;
  auth: { pin: string };
  baseUrl: string;
  wsBaseUrl: string;
  wssBaseUrl: string | null;
}

async function startTestServer(provider: TranslationProvider = makeNoopProvider()): Promise<TestServer> {
  const built = buildApp(provider, { listenerUrls: [], qrDataUrl: null }, ['127.0.0.1']);
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  const { port } = built.server.address() as AddressInfo;

  let wssBaseUrl: string | null = null;
  if (built.httpsServer) {
    await new Promise<void>((resolve) => built.httpsServer!.listen(0, resolve));
    const httpsPort = (built.httpsServer.address() as AddressInfo).port;
    wssBaseUrl = `wss://localhost:${httpsPort}`;
  }

  return {
    ...built,
    baseUrl: `http://localhost:${port}`,
    wsBaseUrl: `ws://localhost:${port}`,
    wssBaseUrl,
  };
}

function stopTestServer(test: TestServer): Promise<void> {
  return Promise.all([
    new Promise<void>((resolve) => test.server.close(() => resolve())),
    test.httpsServer ? new Promise<void>((resolve) => test.httpsServer!.close(() => resolve())) : Promise.resolve(),
  ]).then(() => undefined);
}

function connect(url: string, options?: { rejectUnauthorized?: boolean }) {
  const ws = new WebSocket(url, options as ConstructorParameters<typeof WebSocket>[1]);
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, opened };
}

// The listener is attached synchronously when this is called - if the
// message you're waiting for is a direct, synchronous consequence of
// something a DIFFERENT socket just did (e.g. a broadcast with no async gap
// on the server first), call this BEFORE triggering that action (store the
// promise, trigger the action, then await it) rather than after, or the
// message can arrive and be dropped before this is ever listening for it.
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
      await stopTestServer(test);
    }
  });

  it('destroys the connection for an unknown WS path', async () => {
    const test = await startTestServer();
    try {
      const unknown = connect(`${test.wsBaseUrl}/ws/unknown`);
      await assert.rejects(() => unknown.opened);
    } finally {
      await stopTestServer(test);
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
      await stopTestServer(test);
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
      await stopTestServer(test);
    }
  });

  // This is the server-side half of "use your phone as the presenter when
  // this machine has no microphone" (see SPEC.md): the phone needs HTTPS to
  // satisfy getUserMedia's secure-context requirement, which a browser can't
  // get from a LAN IP over plain HTTP. rejectUnauthorized: false here stands
  // in for a person clicking through the self-signed certificate warning.
  it('accepts presenter auth and session control over HTTPS (wss), for use from another device', async () => {
    const test = await startTestServer();
    assert.ok(test.wssBaseUrl, 'expected HTTPS to be enabled by default for this test');
    try {
      const loginRes = await fetch(`${test.baseUrl}/api/presenter/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: test.auth.pin }),
      });
      const { token } = await loginRes.json();

      const presenter = connect(`${test.wssBaseUrl}/ws/presenter`, { rejectUnauthorized: false });
      await presenter.opened;

      presenter.ws.send(JSON.stringify({ type: 'auth', token }));
      await waitForMessage(presenter.ws, (m) => m.type === 'auth_ok');

      presenter.ws.send(
        JSON.stringify({ type: 'start_session', sourceLanguage: 'es-ES', targetLanguage: 'en-US' }),
      );
      const state = await waitForMessage(presenter.ws, (m) => m.type === 'session_state' && m.session.status === 'live');
      assert.equal(state.session.sourceLanguage, 'es-ES');

      presenter.ws.close();
    } finally {
      await stopTestServer(test);
    }
  });
});

describe('audience questions', () => {
  async function startLiveSession(test: TestServer) {
    const loginRes = await fetch(`${test.baseUrl}/api/presenter/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: test.auth.pin }),
    });
    const { token } = await loginRes.json();
    const presenter = connect(`${test.wsBaseUrl}/ws/presenter`);
    await presenter.opened;
    presenter.ws.send(JSON.stringify({ type: 'auth', token }));
    await waitForMessage(presenter.ws, (m) => m.type === 'auth_ok');
    presenter.ws.send(
      JSON.stringify({ type: 'start_session', sourceLanguage: 'es-ES', targetLanguage: 'en-US' }),
    );
    await waitForMessage(presenter.ws, (m) => m.type === 'session_state' && m.session.status === 'live');
    return presenter;
  }

  it('grants a listener the floor (notifying the presenter), delivers their translated question, then frees it', async () => {
    const fake = makeControllableProvider();
    const test = await startTestServer(fake.provider);
    try {
      const presenter = await startLiveSession(test);
      const asker = connect(`${test.wsBaseUrl}/ws/listen`);
      await asker.opened;

      // Registered before triggering the request, same reason as the
      // comment on waitForMessage: a broadcast fired synchronously by
      // another socket's action can be missed if the listener is attached
      // after the fact.
      const presenterSeesAskingStarted = waitForMessage(presenter.ws, (m) => m.type === 'question_asking_started');
      asker.ws.send(JSON.stringify({ type: 'request_question', language: 'en-US' }));
      await waitForMessage(asker.ws, (m) => m.type === 'question_granted');
      await presenterSeesAskingStarted;

      fake.emitFinal('what time is it');
      const received = await waitForMessage(presenter.ws, (m) => m.type === 'audience_question');
      assert.equal(received.question.sourceText, 'what time is it');
      assert.equal(received.question.translatedText, '[es] what time is it');
      assert.equal(received.question.sourceLanguageLabel, 'Inglés (Estados Unidos)');
      assert.match(received.question.audioUrl ?? '', /^\/api\/audio\/.+/);

      const presenterSeesAskingEnded = waitForMessage(presenter.ws, (m) => m.type === 'question_asking_ended');
      asker.ws.send(JSON.stringify({ type: 'end_question' }));
      await waitForMessage(asker.ws, (m) => m.type === 'question_floor_free');
      await presenterSeesAskingEnded;

      presenter.ws.close();
      asker.ws.close();
    } finally {
      await stopTestServer(test);
    }
  });

  it('denies a second asker while one is active, and broadcasts floor state to everyone', async () => {
    const fake = makeControllableProvider();
    const test = await startTestServer(fake.provider);
    try {
      const presenter = await startLiveSession(test);
      const bystander = connect(`${test.wsBaseUrl}/ws/listen`);
      await bystander.opened;

      // Registered before triggering the request below: question_floor_busy is
      // a plain broadcast (no async gap on the server side before it fires),
      // so attaching this listener after the request could lose the race and
      // miss the message entirely - see the comment on waitForMessage.
      const bystanderSeesBusy = waitForMessage(bystander.ws, (m) => m.type === 'question_floor_busy');

      const asker = connect(`${test.wsBaseUrl}/ws/listen`);
      await asker.opened;
      asker.ws.send(JSON.stringify({ type: 'request_question', language: 'en-US' }));
      await waitForMessage(asker.ws, (m) => m.type === 'question_granted');

      // A listener who was already connected (not asking) should see the floor go busy.
      await bystanderSeesBusy;

      const second = connect(`${test.wsBaseUrl}/ws/listen`);
      await second.opened;
      second.ws.send(JSON.stringify({ type: 'request_question', language: 'fr-FR' }));
      const denial = await waitForMessage(second.ws, (m) => m.type === 'question_denied');
      assert.match(denial.reason, /otra persona/i);

      asker.ws.send(JSON.stringify({ type: 'end_question' }));
      await waitForMessage(bystander.ws, (m) => m.type === 'question_floor_free');

      presenter.ws.close();
      asker.ws.close();
      second.ws.close();
      bystander.ws.close();
    } finally {
      await stopTestServer(test);
    }
  });

  it('releases the floor automatically if the session ends while someone is asking', async () => {
    const fake = makeControllableProvider();
    const test = await startTestServer(fake.provider);
    try {
      const presenter = await startLiveSession(test);
      const asker = connect(`${test.wsBaseUrl}/ws/listen`);
      await asker.opened;
      asker.ws.send(JSON.stringify({ type: 'request_question', language: 'en-US' }));
      await waitForMessage(asker.ws, (m) => m.type === 'question_granted');

      presenter.ws.send(JSON.stringify({ type: 'stop_session' }));
      await waitForMessage(asker.ws, (m) => m.type === 'question_floor_free');

      presenter.ws.close();
      asker.ws.close();
    } finally {
      await stopTestServer(test);
    }
  });
});
