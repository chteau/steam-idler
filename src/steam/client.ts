import type { EventEmitter } from 'node:events';
import SteamUser from 'steam-user';

/**
 * The subset of steam-user this app depends on. Tests provide an EventEmitter-based fake.
 * Events used: loggedOn, disconnected, error, playingState, refreshToken, steamGuard.
 */
export interface SteamClientLike extends EventEmitter {
  logOn(details: { refreshToken: string; machineName?: string }): void;
  logOff(): void;
  gamesPlayed(apps: number[]): void;
  readonly steamID: unknown;
}

/** Error shape emitted by steam-user: a regular Error with an optional EResult code. */
export interface SteamError extends Error {
  eresult?: number | undefined;
}

export interface ClientOptions {
  renewRefreshTokens: boolean;
}

export function createSteamClient(opts: ClientOptions): SteamClientLike {
  const client = new SteamUser({
    // steam-user reconnects by itself after non-fatal disconnects (Steam down, connection dropped).
    autoRelogin: true,
    // The app/package metadata cache is the biggest memory consumer and is not needed to play a game.
    enablePicsCache: false,
    // Nothing on disk: the CM server list is re-fetched at startup and refresh-token logins need no machine auth file.
    dataDirectory: null,
    renewRefreshTokens: opts.renewRefreshTokens,
  });
  return client as unknown as SteamClientLike;
}

export function eresultName(code: number | undefined): string {
  if (code === undefined) return 'unknown';
  const name = (SteamUser.EResult as unknown as Record<number, string>)[code];
  return typeof name === 'string' ? name : String(code);
}
