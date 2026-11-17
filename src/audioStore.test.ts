import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioStore } from './audioStore';

describe('AudioStore', () => {
  it('stores and retrieves a clip by id', () => {
    const store = new AudioStore();
    store.set('seg-1', { buffer: Buffer.from('abc'), mime: 'audio/mpeg' });
    const clip = store.get('seg-1');
    assert.equal(clip?.mime, 'audio/mpeg');
    assert.equal(clip?.buffer.toString(), 'abc');
  });

  it('returns undefined for a missing id', () => {
    const store = new AudioStore();
    assert.equal(store.get('missing'), undefined);
  });

  it('delete() removes a single clip', () => {
    const store = new AudioStore();
    store.set('a', { buffer: Buffer.from('a'), mime: 'audio/mpeg' });
    store.set('b', { buffer: Buffer.from('b'), mime: 'audio/mpeg' });
    store.delete('a');
    assert.equal(store.get('a'), undefined);
    assert.ok(store.get('b'));
  });

  it('clear() removes every stored clip', () => {
    const store = new AudioStore();
    store.set('a', { buffer: Buffer.from('a'), mime: 'audio/mpeg' });
    store.set('b', { buffer: Buffer.from('b'), mime: 'audio/mpeg' });
    store.clear();
    assert.equal(store.get('a'), undefined);
    assert.equal(store.get('b'), undefined);
  });
});
