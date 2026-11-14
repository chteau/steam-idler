import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../src/utils/logger.js';
import type { SteamClientLike } from '../src/steam/client.js';

export class FakeSteamClient extends EventEmitter implements SteamClientLike {
  steamID: unknown = null;
  logOnCalls: Array<{ refreshToken: string }> = [];
  gamesPlayedCalls: number[][] = [];
  logOffCalls = 0;
  throwOnLogOn: Error | undefined;

  logOn(details: { refreshToken: string }): void {
    if (this.throwOnLogOn) throw this.throwOnLogOn;
    this.logOnCalls.push(details);
  }
  logOff(): void {
    this.logOffCalls += 1;
  }
  gamesPlayed(apps: number[]): void {
    this.gamesPlayedCalls.push(apps);
  }

  // Helpers mimicking steam-user events.
  succeed(): void {
    this.steamID = '76561197960265729';
    this.emit('loggedOn', {}, null);
  }
  fail(eresult: number | undefined, message = 'fail'): void {
    const err = Object.assign(new Error(message), eresult === undefined ? {} : { eresult });
    this.emit('error', err);
    this.steamID = null; // steam-user clears steamID right after emitting 'error'
  }
}

/** Logger that keeps JSON lines in memory. */
export function memoryLogger(level: 'trace' | 'info' | 'silent' = 'trace'): { log: Logger; lines: () => Array<Record<string, unknown>>; raw: () => string } {
  let buf = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  const log = createLogger(level, sink);
  return {
    log,
    raw: () => buf,
    lines: () =>
      buf
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Builds an unsigned JWT-shaped token with the given claims (test only). */
export function fakeToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc(claims)}.c2lnbmF0dXJl`;
}

export function validToken(daysFromNow = 180, sub = '76561197960265729'): string {
  return fakeToken({ iss: 'steam', sub, aud: ['client', 'web'], exp: Math.floor(Date.now() / 1000) + daysFromNow * 86_400 });
}
