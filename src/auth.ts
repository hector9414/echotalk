import { randomInt, randomUUID } from 'crypto';

// PIN + opaque token auth for the presenter control panel. There are no user
// accounts (by design, see SPEC.md) - this only protects the "start/pause/
// stop the session" controls from someone else picking up the same shared
// laptop later. Both the PIN and every issued token live in memory only and
// are gone the moment the server restarts.
export class PresenterAuth {
  readonly pin: string;
  private readonly tokens = new Set<string>();

  constructor(pin: string = PresenterAuth.generatePin()) {
    this.pin = pin;
  }

  static generatePin(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  login(candidatePin: string): string | null {
    if (candidatePin !== this.pin) return null;
    const token = randomUUID();
    this.tokens.add(token);
    return token;
  }

  isValidToken(token: string | undefined | null): boolean {
    return !!token && this.tokens.has(token);
  }
}
