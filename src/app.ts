import type { Config } from './config.js';
import { ConfigError, PERSONA_STATES } from './config.js';
import { checkRefreshToken, attachSteamGuardHandler } from './steam/auth.js';
import type { SteamClientLike } from './steam/client.js';
import { PresenceManager } from './steam/presence.js';
import { ReconnectController, type BackoffPolicy } from './steam/reconnect.js';
import {
  fingerprint,
  resolveRefreshToken,
  SessionFileCorruptError,
  type SessionStore,
  type StoredSession,
} from './storage/session-store.js';
import type { Logger } from './utils/logger.js';

export interface DaemonDeps {
  log: Logger;
  store: SessionStore;
  client: SteamClientLike;
  policy?: BackoffPolicy;
  isInteractive?: boolean;
  now?: () => Date;
  /** How long to wait for Steam to acknowledge logOff during shutdown. */
  logOffWaitMs?: number;
  /** Interval of the reminder logged while parked after a fatal error. */
  parkedReminderMs?: number;
}

export interface Daemon {
  readonly presence: PresenceManager;
  readonly connection: ReconnectController;
  /** True after an unrecoverable error: the process stays up (no restart loop) but does nothing. */
  readonly parked: boolean;
  stop(): Promise<void>;
}

const EXPIRY_WARNING_DAYS = 30;

/** Wires storage, Steam client, reconnect logic and presence together, then starts the logon. */
export async function startDaemon(config: Config, deps: DaemonDeps): Promise<Daemon> {
  const { log, store, client } = deps;
  const now = deps.now ?? (() => new Date());

  let stored: StoredSession | null = null;
  try {
    stored = await store.load();
  } catch (err) {
    if (!(err instanceof SessionFileCorruptError)) throw err;
    log.error(
      { file: err.file, movedTo: err.movedTo },
      'Session file is corrupt; it was kept aside for inspection. Falling back to STEAM_REFRESH_TOKEN.',
    );
  }

  const resolved = resolveRefreshToken(stored, config.refreshToken);
  if (resolved.token === undefined) {
    throw new ConfigError([
      `No refresh token found in STEAM_REFRESH_TOKEN or ${store.description}. ` +
        'Run `npm run auth` on your computer, then set STEAM_REFRESH_TOKEN (see README "Authentication").',
    ]);
  }
  const check = checkRefreshToken(resolved.token, now());
  if (!check.ok) {
    throw new ConfigError([
      `The refresh token from ${resolved.source === 'env' ? 'STEAM_REFRESH_TOKEN' : store.description} is unusable: ${check.reason}.`,
    ]);
  }
  log.info(
    {
      tokenSource: resolved.source,
      tokenExpiresAt: check.info.expiresAt?.toISOString(),
      appId: config.appId,
      sessionStore: store.description,
      renewRefreshTokens: config.renewRefreshTokens,
    },
    'Starting Steam idler',
  );
  if (check.expiresInDays !== undefined && check.expiresInDays < EXPIRY_WARNING_DAYS) {
    log.warn({ expiresInDays: check.expiresInDays }, 'Refresh token expires soon; run `npm run auth` and update STEAM_REFRESH_TOKEN');
  }

  let currentToken = resolved.token;
  let parked = false;
  let parkTimer: NodeJS.Timeout | undefined;
  let stopping = false;

  client.on('refreshToken', (token: string) => {
    currentToken = token;
    const session: StoredSession = { version: 1, refreshToken: token, updatedAt: now().toISOString() };
    if (config.refreshToken !== undefined) session.envFingerprint = fingerprint(config.refreshToken);
    store.save(session).then(
      () => log.info({ sessionStore: store.description }, 'Steam issued a new refresh token; saved it'),
      (err: unknown) =>
        log.error(
          { sessionStore: store.description, error: err instanceof Error ? err.message : String(err) },
          'Steam issued a new refresh token but saving it FAILED. The previous token may now be invalid: ' +
            'the process keeps working with the new token in memory, but run `npm run auth` and update ' +
            'STEAM_REFRESH_TOKEN before the next restart.',
        ),
    );
  });

  const presence = new PresenceManager(client, log, { appId: config.appId });

  const park = (): void => {
    if (parked) return;
    parked = true;
    presence.onDisconnected();
    connection.stop();
    const every = deps.parkedReminderMs ?? 60 * 60_000;
    // Keeps the process alive without retrying, so a crash-restart loop cannot hammer Steam's logon servers.
    parkTimer = setInterval(
      () => log.error('Still stopped after a fatal Steam error; fix the token and restart the service'),
      every,
    );
  };

  const connection = new ReconnectController(
    client,
    log,
    {
      onLoggedOn: () => {
        const rssMb = Math.round(process.memoryUsage().rss / 1_048_576);
        log.info({ rssMb, persona: config.persona }, 'Session ready');
        // Without this the session counts as offline, and friends/profile don't see the game.
        client.setPersona(PERSONA_STATES[config.persona]);
        presence.onLoggedOn();
      },
      onDisconnected: () => presence.onDisconnected(),
      onFatal: () => park(),
    },
    {
      getRefreshToken: () => currentToken,
      machineName: 'steam-idler',
      ...(deps.policy ? { policy: deps.policy } : {}),
    },
  );

  client.on('playingState', (blocked: boolean, playingApp: number) => {
    if (!stopping) presence.onPlayingState(blocked, playingApp);
  });

  attachSteamGuardHandler(
    client,
    log,
    () => {
      park();
      client.logOff();
    },
    deps.isInteractive,
  );

  connection.start();

  return {
    presence,
    connection,
    get parked() {
      return parked;
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (parkTimer) clearInterval(parkTimer);
      const wasOnline = connection.state === 'connected';
      connection.stop();
      presence.stop();
      if (!wasOnline) {
        client.logOff(); // cancels any connection attempt in flight
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, deps.logOffWaitMs ?? 3_000);
        function done(): void {
          clearTimeout(timer);
          client.off('disconnected', done);
          resolve();
        }
        client.once('disconnected', done);
        client.logOff();
      });
    },
  };
}
