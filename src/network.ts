import { networkInterfaces } from 'os';
import QRCode from 'qrcode';

export function getLanIpAddresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

export function buildListenerUrl(ip: string, port: number): string {
  return `http://${ip}:${port}/`;
}

// getUserMedia requires a secure context (HTTPS, or the localhost/127.0.0.1
// special case) - a LAN IP over plain HTTP does not qualify. When the
// presenter is on the SAME machine as the server, this plain-HTTP localhost
// URL is the simplest option (no certificate warning). See SPEC.md
// "Hallazgo tecnico clave: contexto seguro del navegador".
export function buildPresenterUrl(port: number): string {
  return `http://localhost:${port}/presenter`;
}

// When the presenter needs to use a DIFFERENT device (e.g. a phone, because
// the machine running the server has no microphone), localhost is out of
// reach for them - this HTTPS URL is what satisfies the secure-context
// requirement from another device on the LAN instead. The certificate is
// self-signed (see src/tls.ts), so the browser will show a one-time
// "connection not private" warning to click through.
export function buildPresenterHttpsUrl(ip: string, httpsPort: number): string {
  return `https://${ip}:${httpsPort}/presenter`;
}

export async function generateQrTerminal(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true });
}

export async function generateQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url);
}
