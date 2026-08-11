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
// special case) - a LAN IP over plain HTTP does not qualify. The presenter
// panel must always be opened this way, never via the LAN IP. See SPEC.md
// "Hallazgo tecnico clave: contexto seguro del navegador".
export function buildPresenterUrl(port: number): string {
  return `http://localhost:${port}/presenter`;
}

export async function generateQrTerminal(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true });
}

export async function generateQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url);
}
