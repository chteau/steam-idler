import { createInterface } from 'node:readline/promises';
import { EAuthTokenPlatformType, LoginSession } from 'steam-session';
import qrcode from 'qrcode-terminal';
import type { Logger } from '../utils/logger.js';
import type { SteamClientLike } from './client.js';

export interface TokenInfo {
  issuer: string | undefined;
  /** Token expiry, if the JWT carries one. */
  expiresAt: Date | undefined;
  audiences: string[];
  steamId: string | undefined;
}

/** Reads the public claims of a refresh token (no signature check; Steam does that). Never logs the token. */
export function decodeRefreshToken(token: string): TokenInfo | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    const aud = Array.isArray(p.aud) ? p.aud.filter((a): a is string => typeof a === 'string') : [];
    return {
      issuer: typeof p.iss === 'string' ? p.iss : undefined,
      expiresAt: typeof p.exp === 'number' ? new Date(p.exp * 1000) : undefined,
      audiences: aud,
      steamId: typeof p.sub === 'string' ? p.sub : undefined,
    };
  } catch {
    return null;
  }
}

export type TokenCheck =
  | { ok: true; info: TokenInfo; expiresInDays: number | undefined }
  | { ok: false; reason: string };

/**
 * Rejects tokens that cannot work before contacting Steam. Mirrors the checks steam-user's logOn()
 * performs asynchronously (iss, aud, sub), whose failures would otherwise surface as unhandled rejections.
 */
export function checkRefreshToken(token: string, now: Date = new Date()): TokenCheck {
  const info = decodeRefreshToken(token);
  if (!info) return { ok: false, reason: 'the token is not a readable JWT' };
  if (info.issuer !== 'steam') {
    return { ok: false, reason: 'the token was not issued by Steam (it is not a Steam refresh token)' };
  }
  if (!info.audiences.includes('client')) {
    return {
      ok: false,
      reason: `the token was issued for "${info.audiences.join(', ') || 'no audience'}", not the Steam client; create one with \`npm run auth\``,
    };
  }
  if (!info.steamId || !/^\d{17}$/.test(info.steamId)) {
    return { ok: false, reason: 'the token does not name a SteamID' };
  }
  if (info.expiresAt && info.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: `the token expired on ${info.expiresAt.toISOString()}` };
  }
  const expiresInDays = info.expiresAt
    ? Math.floor((info.expiresAt.getTime() - now.getTime()) / 86_400_000)
    : undefined;
  return { ok: true, info, expiresInDays };
}

export interface QrLoginOptions {
  timeoutMs: number;
  log: Logger;
  /** Renders the QR challenge. Defaults to a terminal QR code. The URL is a login secret: never log it. */
  renderQr?: (challengeUrl: string) => void;
  /** Factory for tests. */
  createSession?: () => QrSessionLike;
}

/** The subset of steam-session's LoginSession used for QR logins. */
export interface QrSessionLike {
  loginTimeout: number;
  readonly refreshToken: string;
  startWithQR(): Promise<{ qrChallengeUrl?: string }>;
  cancelLoginAttempt(): boolean;
  on(event: 'authenticated' | 'timeout' | 'remoteInteraction', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  removeAllListeners(): unknown;
}

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}

function defaultRenderQr(url: string): void {
  qrcode.generate(url, { small: true }, (art) => process.stdout.write(`${art}\n`));
}

/**
 * Starts a QR login for the SteamClient platform and resolves with the refresh token once the
 * user approves it in the Steam mobile app.
 */
export async function runQrLogin(opts: QrLoginOptions): Promise<string> {
  const session: QrSessionLike =
    opts.createSession?.() ?? (new LoginSession(EAuthTokenPlatformType.SteamClient) as unknown as QrSessionLike);
  session.loginTimeout = opts.timeoutMs;
  const render = opts.renderQr ?? defaultRenderQr;

  try {
    return await new Promise<string>((resolve, reject) => {
      session.on('remoteInteraction', () => opts.log.info('QR code scanned; approve the login in the Steam app'));
      session.on('authenticated', () => {
        const token = session.refreshToken;
        if (!token) reject(new AuthError('Steam reported success but returned no refresh token'));
        else resolve(token);
      });
      session.on('timeout', () =>
        reject(new AuthError(`QR login was not approved within ${Math.round(opts.timeoutMs / 1000)} s`)),
      );
      session.on('error', (err) => reject(new AuthError(`Steam login failed: ${err.message}`, { cause: err })));

      session.startWithQR().then(
        (res) => {
          if (!res.qrChallengeUrl) {
            reject(new AuthError('Steam did not return a QR challenge'));
            return;
          }
          render(res.qrChallengeUrl);
        },
        (err: unknown) =>
          reject(new AuthError(`Could not start QR login: ${err instanceof Error ? err.message : String(err)}`, { cause: err })),
      );
    });
  } finally {
    session.cancelLoginAttempt();
    session.removeAllListeners();
  }
}

/**
 * Steam Guard during a refresh-token logon. Interactive terminals can type the code; a headless
 * worker cannot, so it reports a fatal error instead of letting steam-user block on stdin.
 */
export function attachSteamGuardHandler(
  client: SteamClientLike,
  log: Logger,
  onUnattended: () => void,
  isInteractive: boolean = Boolean(process.stdin.isTTY),
): void {
  client.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
    if (!isInteractive) {
      log.fatal(
        { emailDomain: domain ?? undefined },
        'Steam asked for a Steam Guard code, which a headless worker cannot provide. Run `npm run auth` locally and update STEAM_REFRESH_TOKEN.',
      );
      onUnattended();
      return;
    }
    void (async () => {
      if (lastCodeWrong) {
        log.warn('Last Steam Guard code was wrong; waiting 30 s for a new code');
        await new Promise((r) => setTimeout(r, 30_000));
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const where = domain ? `the email sent to *@${domain}` : 'the Steam mobile app';
        const code = (await rl.question(`Steam Guard code from ${where}: `)).trim();
        callback(code);
      } finally {
        rl.close();
      }
    })().catch((err: unknown) => {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 'Could not read Steam Guard code');
      onUnattended();
    });
  });
}
