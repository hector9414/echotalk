import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSelfSignedCert } from './tls';

describe('generateSelfSignedCert', () => {
  it('returns a PEM certificate and private key', () => {
    const { cert, key } = generateSelfSignedCert(['192.168.1.50']);
    assert.match(cert, /^-----BEGIN CERTIFICATE-----/);
    assert.match(key, /^-----BEGIN (RSA )?PRIVATE KEY-----/);
  });

  it('works with no LAN IPs (localhost/127.0.0.1 only)', () => {
    const { cert, key } = generateSelfSignedCert([]);
    assert.ok(cert.length > 0);
    assert.ok(key.length > 0);
  });

  it('produces a usable cert+key pair for an https.Server', async () => {
    const https = await import('node:https');
    const { cert, key } = generateSelfSignedCert(['127.0.0.1']);
    const server = https.createServer({ cert, key }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolve);
    });
    server.close();
  });
});
