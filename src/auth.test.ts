import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PresenterAuth } from './auth';

describe('PresenterAuth', () => {
  it('generates a 6-digit numeric PIN', () => {
    const pin = PresenterAuth.generatePin();
    assert.match(pin, /^\d{6}$/);
  });

  it('issues a token for the correct PIN', () => {
    const auth = new PresenterAuth('123456');
    const token = auth.login('123456');
    assert.ok(token);
    assert.equal(auth.isValidToken(token), true);
  });

  it('rejects an incorrect PIN', () => {
    const auth = new PresenterAuth('123456');
    assert.equal(auth.login('000000'), null);
  });

  it('treats unknown/missing tokens as invalid', () => {
    const auth = new PresenterAuth('123456');
    assert.equal(auth.isValidToken('not-a-real-token'), false);
    assert.equal(auth.isValidToken(undefined), false);
    assert.equal(auth.isValidToken(null), false);
  });

  it('issues a distinct token on each successful login', () => {
    const auth = new PresenterAuth('123456');
    const first = auth.login('123456');
    const second = auth.login('123456');
    assert.notEqual(first, second);
    assert.equal(auth.isValidToken(first), true);
    assert.equal(auth.isValidToken(second), true);
  });
});
