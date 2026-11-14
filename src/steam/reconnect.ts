import type { Logger } from '../utils/logger.js';
import { eresultName, type SteamClientLike, type SteamError } from './client.js';

/** EResult codes (steam-user's SteamUser.EResult). Inlined so this module stays testable without the network stack. */
export const EResult = {
  InvalidPassword: 5,
  LoggedInElsewhere: 6,
  AccessDenied: 15,
  Banned: 17,
  Revoked: 26,
  Expired: 27,
  LogonSessionReplaced: 34,
  AccountDisabled: 43,
  AlreadyLoggedInElsewhere: 50,
  RateLimitExceeded: 84,
  AccountLoginDeniedThrottle: 87,
  IPBanned: 105,
  InvalidSignature: 121,
} as const;

/** Errors a retry cannot fix: the token or account needs human attention. */
const FATAL = new Set<number>([
  EResult.InvalidPassword,
  EResult.AccessDenied,
  EResult.Banned,
  EResult.Revoked,
  EResult.Expired,
  EResult.AccountDisabled,
  EResult.IPBanned,
  EResult.InvalidSignature,
]);

/** Steam is throttling us: back off hard. */
const THROTTLED = new Set<number>([EResult.RateLimitExceeded, EResult.AccountLoginDeniedThrottle]);

/** Another logon with the same identity took over. Retrying quickly would kick it back and forth. */
const REPLACED = new Set<number>([
  EResult.LoggedInElsewhere,
  EResult.LogonSessionReplaced,
  EResult.AlreadyLoggedInElsewhere,
]);

/** EventEmitter's own listener type, so handlers can declare their real argument types. */
type Listener = Parameters<SteamClientLike['on']>[1];

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected' // steam-user's autoRelogin is reconnecting
  | 'backoff' // waiting for our own retry timer
  | 'fatal'
  | 'stopped';

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Minimum delay after LoggedInElsewhere / LogonSessionReplaced. */
  replacedMinMs: number;
  /** Minimum delay after RateLimitExceeded. */
  throttledMinMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 5_000,
  maxMs: 15 * 60_000,
  replacedMinMs: 5 * 60_000,
  throttledMinMs: 30 * 60_000,
};

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random.
 * attempt starts at 1.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

export type ErrorClass = 'fatal' | 'throttled' | 'replaced' | 'transient';

export function classifyError(err: SteamError): ErrorClass {
  const code = err.eresult;
  if (code !== undefined && FATAL.has(code)) return 'fatal';
  if (code !== undefined && THROTTLED.has(code)) return 'throttled';
  if (code !== undefined && REPLACED.has(code)) return 'replaced';
  // steam-user throws plain errors (no eresult) for tokens it cannot use at all, e.g. a non-SteamClient token.
  if (code === undefined && /refresh token|access token|jwt|audience/i.test(err.message)) return 'fatal';
  return 'transient';
}

export interface ReconnectEvents {
  onLoggedOn(): void;
  onDisconnected(): void;
  /** Unrecoverable: retries stop. */
  onFatal(err: SteamError): void;
}

export interface ReconnectOptions {
  getRefreshToken(): string;
  policy?: BackoffPolicy;
  random?: () => number;
  machineName?: string;
}

/**
 * Owns logon attempts. steam-user handles reconnects after non-fatal disconnects ('disconnected'
 * followed by 'loggedOn'); this class only steps in when steam-user gives up and emits 'error'.
 * At most one logon attempt or retry timer exists at any time.
 */
export class ReconnectController {
  private _state: ConnectionState = 'idle';
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly policy: BackoffPolicy;
  private readonly random: () => number;
  private readonly listeners: Array<[string, Listener]> = [];

  constructor(
    private readonly client: SteamClientLike,
    private readonly log: Logger,
    private readonly events: ReconnectEvents,
    private readonly opts: ReconnectOptions,
  ) {
    this.policy = opts.policy ?? DEFAULT_BACKOFF;
    this.random = opts.random ?? Math.random;
    this.on('loggedOn', () => this.handleLoggedOn());
    this.on('disconnected', (eresult: number, msg?: string) => this.handleDisconnected(eresult, msg));
    this.on('error', (err: SteamError) => this.handleError(err));
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Starts a logon. Ignored when one is already in progress, connected, or scheduled. */
  start(): boolean {
    if (this._state !== 'idle') {
      this.log.debug({ state: this._state }, 'Logon already in progress or scheduled; ignoring start()');
      return false;
    }
    this.logOn();
    return true;
  }

  /** Stops retries and detaches listeners. Does not log off; the caller decides that. */
  stop(): void {
    this.clearTimer();
    this._state = 'stopped';
  }

  dispose(): void {
    this.stop();
    for (const [event, fn] of this.listeners) this.client.off(event, fn);
    this.listeners.length = 0;
  }

  private on(event: string, fn: Listener): void {
    this.client.on(event, fn);
    this.listeners.push([event, fn]);
  }

  private logOn(): void {
    if (this.client.steamID) {
      // steam-user still holds a session; calling logOn now would make it throw asynchronously
      // (an unhandled rejection). Treat it as a transient failure and try again later.
      this.handleError(new Error('steam-user still has an active session; delaying logon'));
      return;
    }
    this._state = 'connecting';
    this.attempt += 1;
    this.log.info({ attempt: this.attempt }, 'Logging on to Steam');
    const details: { refreshToken: string; machineName?: string } = { refreshToken: this.opts.getRefreshToken() };
    if (this.opts.machineName) details.machineName = this.opts.machineName;
    try {
      this.client.logOn(details);
      this._state = 'authenticating';
    } catch (err) {
      // steam-user throws synchronously for invalid logon details (e.g. wrong token type).
      this.handleError(err instanceof Error ? (err as SteamError) : new Error(String(err)));
    }
  }

  private handleLoggedOn(): void {
    if (this._state === 'stopped') return;
    this.clearTimer();
    this._state = 'connected';
    this.attempt = 0;
    this.log.info('Logged on to Steam');
    this.events.onLoggedOn();
  }

  private handleDisconnected(eresult: number, msg?: string): void {
    if (this._state === 'stopped') return;
    this._state = 'disconnected';
    this.log.warn(
      { eresult, eresultName: eresultName(eresult), msg },
      'Disconnected from Steam; steam-user is reconnecting',
    );
    this.events.onDisconnected();
  }

  private handleError(err: SteamError): void {
    if (this._state === 'stopped' || this._state === 'fatal') {
      this.log.debug({ eresult: err.eresult, error: err.message, state: this._state }, 'Steam error after stop; ignored');
      return;
    }
    const wasConnected = this._state === 'connected' || this._state === 'disconnected';
    if (wasConnected) this.events.onDisconnected();

    const kind = classifyError(err);
    const ctx = { eresult: err.eresult, eresultName: eresultName(err.eresult), error: err.message, kind };

    if (kind === 'fatal') {
      this.clearTimer();
      this._state = 'fatal';
      this.log.fatal(ctx, 'Steam rejected the logon; not retrying. Re-authenticate (see README "Recovery").');
      this.events.onFatal(err);
      return;
    }

    if (this.timer) return; // a retry is already scheduled

    let delay = backoffDelay(Math.max(1, this.attempt), this.policy, this.random);
    if (kind === 'throttled') delay = Math.max(delay, this.policy.throttledMinMs);
    if (kind === 'replaced') delay = Math.max(delay, this.policy.replacedMinMs);

    this._state = 'backoff';
    this.log.warn({ ...ctx, retryInMs: delay, attempt: this.attempt }, 'Steam logon failed; retrying later');
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this._state !== 'backoff') return;
      this.logOn();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
