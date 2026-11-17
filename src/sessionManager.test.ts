import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from './sessionManager';

describe('SessionManager lifecycle', () => {
  it('starts idle', () => {
    const sm = new SessionManager();
    assert.equal(sm.getSession().status, 'idle');
    assert.equal(sm.isLive(), false);
  });

  it('start() moves to live and assigns an id', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const session = sm.getSession();
    assert.equal(session.status, 'live');
    assert.equal(session.sourceLanguage, 'es-ES');
    assert.equal(session.targetLanguage, 'en-US');
    assert.ok(session.id);
    assert.ok(session.startedAt);
    assert.equal(sm.isLive(), true);
  });

  it('start() rejects an unknown source or target language', () => {
    const sm = new SessionManager();
    assert.throws(() => sm.start('xx-XX', 'en-US'));
    assert.throws(() => sm.start('es-ES', 'xx-XX'));
  });

  it('start() rejects starting a second session while one is already live', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    assert.throws(() => sm.start('en-US', 'es-ES'));
  });

  it('pause()/resume() toggle status without clearing the session id or segments', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const segment = sm.createSegment('hola');
    const idBeforePause = sm.getSession().id;

    sm.pause();
    assert.equal(sm.getSession().status, 'paused');
    assert.equal(sm.isLive(), false);

    sm.resume();
    assert.equal(sm.getSession().status, 'live');
    assert.equal(sm.getSession().id, idBeforePause);
    assert.equal(sm.getSegments().length, 1);
    assert.equal(sm.getSegments()[0].id, segment.id);
  });

  it('pause() rejects when not live; resume() rejects when not paused', () => {
    const sm = new SessionManager();
    assert.throws(() => sm.pause()); // idle
    sm.start('es-ES', 'en-US');
    assert.throws(() => sm.resume()); // live, not paused
    sm.pause();
    assert.throws(() => sm.pause()); // already paused
  });

  it('stop() resets to idle and clears segments, and is idempotent when already idle', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    sm.createSegment('hola');
    sm.stop();

    const session = sm.getSession();
    assert.equal(session.status, 'idle');
    assert.equal(session.sourceLanguage, '');
    assert.equal(sm.getSegments().length, 0);
    assert.doesNotThrow(() => sm.stop());
  });

  it('stop() preserves listenerCount across the reset', () => {
    const sm = new SessionManager();
    sm.setListenerCount(3);
    sm.start('es-ES', 'en-US');
    sm.stop();
    assert.equal(sm.getSession().listenerCount, 3);
  });
});

describe('SessionManager transcript segments', () => {
  it('createSegment assigns increasing seq numbers and emits segmentUpdate', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const events: string[] = [];
    sm.onSegmentUpdate((segment) => events.push(`update:${segment.seq}`));

    const first = sm.createSegment('uno');
    const second = sm.createSegment('dos');
    assert.equal(first.seq, 0);
    assert.equal(second.seq, 1);
    assert.deepEqual(events, ['update:0', 'update:1']);
  });

  it('updateSegmentInterim mutates an existing non-final segment in place', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const segment = sm.createSegment('ho');
    sm.updateSegmentInterim(segment.id, 'hola');
    assert.equal(sm.getSegments().length, 1);
    assert.equal(sm.getSegments()[0].sourceText, 'hola');
  });

  it('updateSegmentInterim is a no-op once the segment is already final', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const segment = sm.createSegment('hola');
    sm.finalizeSegment(segment.id, 'hello', '/api/audio/x');
    sm.updateSegmentInterim(segment.id, 'hola mundo');
    assert.equal(sm.getSegments()[0].sourceText, 'hola');
  });

  it('finalizeSegment sets translatedText/audioUrl/isFinal and emits segmentFinal', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const segment = sm.createSegment('hola');
    let finalized: unknown = null;
    sm.onSegmentFinal((s) => (finalized = s));

    sm.finalizeSegment(segment.id, 'hello', '/api/audio/abc');
    const stored = sm.getSegments()[0];
    assert.equal(stored.isFinal, true);
    assert.equal(stored.translatedText, 'hello');
    assert.equal(stored.audioUrl, '/api/audio/abc');
    assert.deepEqual(finalized, stored);
  });
});

describe('SessionManager listener count and public state', () => {
  it('setListenerCount only emits a change when the count actually differs', () => {
    const sm = new SessionManager();
    let changes = 0;
    sm.onSessionChange(() => changes++);
    sm.setListenerCount(2);
    sm.setListenerCount(2);
    sm.setListenerCount(5);
    assert.equal(changes, 2);
    assert.equal(sm.getPublicState().listenerCount, 5);
  });

  it('getPublicState exposes only status/languages/listenerCount, never the internal id', () => {
    const sm = new SessionManager();
    sm.start('es-ES', 'en-US');
    const publicState = sm.getPublicState();
    assert.deepEqual(Object.keys(publicState).sort(), [
      'listenerCount',
      'sourceLanguage',
      'status',
      'targetLanguage',
    ]);
  });
});
