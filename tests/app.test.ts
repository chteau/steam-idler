import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDaemon } from '../src/app.js';
import { ConfigError, type Config } from '../src/config.js';
import { EResult } from '../src/steam/reconnect.js';
import { fingerprint, MemorySessionStore, SessionFileCorruptError, type SessionStore } from '../src/storage/session-store.js';
import { FakeSteamClient, fakeToken, memoryLogger, validToken } from './helpers.js';

const policy = { baseMs: 1000, maxMs: 8000, replacedMinMs: 5000, throttledMinMs: 10_000 };

function config(overrides: Partial<Config> = {}): Config {
  return { refreshToken: validToken(), appId: 2200, logLevel: 'info', sessionFile: undefined, renewRefreshTokens: false, persona: 'online', ...overrides };
}

async function start(cfg = config(), store: SessionStore = new MemorySessionStore()) {
  const client = new FakeSteamClient();
  const mem = memoryLogger();
  const daemon = await startDaemon(cfg, {
    log: mem.log,
    store,
    client,
    policy,
    isInteractive: false,
    logOffWaitMs: 100,
    parkedReminderMs: 1000,
  });
  return { client, daemon, store, ...mem };
}

describe('startDaemon', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fails with an actionable error when no token exists anywhere', async () => {
    await expect(start(config({ refreshToken: undefined }))).rejects.toThrow(/npm run auth/);
  });

  it('refuses unusable tokens before contacting Steam', async () => {
    const expired = fakeToken({ aud: ['client'], exp: 1 });
    await expect(start(config({ refreshToken: expired }))).rejects.toBeInstanceOf(ConfigError);
  });

  it('logs on, sets presence, and restores it after a reconnect', async () => {
    const { client, daemon } = await start();
    expect(client.logOnCalls).toHaveLength(1);
    client.succeed();
    expect(client.personaCalls).toEqual([1]); // Online, set before the game
    expect(client.gamesPlayedCalls).toEqual([[2200]]);
    client.emit('playingState', false, 2200);
    expect(daemon.presence.state).toBe('playing');
    client.emit('disconnected', 0);
    client.succeed();
    expect(client.gamesPlayedCalls).toEqual([[2200], [2200]]);
  });

  it('saves rotated refresh tokens with the env fingerprint', async () => {
    const env = validToken();
    const store = new MemorySessionStore();
    const { client } = await start(config({ refreshToken: env }), store);
    const rotated = validToken(200);
    client.emit('refreshToken', rotated);
    await vi.runOnlyPendingTimersAsync();
    expect(await store.load()).toMatchObject({ refreshToken: rotated, envFingerprint: fingerprint(env) });
    // The next logon uses the rotated token.
    client.fail(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.logOnCalls.at(-1)).toEqual({ refreshToken: rotated, machineName: 'steam-idler' });
  });

  it('reports (does not swallow) a failed save of a rotated token', async () => {
    const store: SessionStore = {
      description: 'broken',
      load: async () => null,
      save: async () => {
        throw new Error('EROFS');
      },
    };
    const { client, lines, raw } = await start(config(), store);
    const rotated = validToken(200);
    client.emit('refreshToken', rotated);
    await vi.runOnlyPendingTimersAsync();
    const err = lines().find((l) => l.level === 50);
    expect(String(err?.msg)).toContain('saving it FAILED');
    expect(raw()).not.toContain(rotated);
  });

  it('falls back to the env token when the session file is corrupt', async () => {
    const store: SessionStore = {
      description: 'file x',
      load: async () => {
        throw new SessionFileCorruptError('x', 'x.corrupt-1', new Error('bad'));
      },
      save: async () => {},
    };
    const { client } = await start(config(), store);
    expect(client.logOnCalls).toHaveLength(1);
  });

  it('parks after a fatal logon error: no further attempts, process kept alive', async () => {
    const { client, daemon } = await start();
    client.fail(EResult.AccessDenied, 'AccessDenied');
    expect(daemon.parked).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.logOnCalls).toHaveLength(1);
    await daemon.stop();
  });

  it('parks when Steam Guard is required on a headless worker', async () => {
    const { client, daemon } = await start();
    client.emit('steamGuard', null, () => {}, false);
    expect(daemon.parked).toBe(true);
    expect(client.logOffCalls).toBe(1);
    await daemon.stop();
  });

  it('stop clears the game and logs off, waiting for the disconnect', async () => {
    const { client, daemon } = await start();
    client.succeed();
    client.emit('playingState', false, 2200);
    const p = daemon.stop();
    expect(client.gamesPlayedCalls.at(-1)).toEqual([]);
    expect(client.logOffCalls).toBe(1);
    client.emit('disconnected', 0, 'Logged off');
    await p;
    expect(daemon.connection.state).toBe('stopped');
  });

  it('stop does not hang if Steam never confirms the logoff', async () => {
    const { client, daemon } = await start();
    client.succeed();
    const p = daemon.stop();
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
  });

  it('stop during a pending retry cancels it', async () => {
    const { client, daemon } = await start();
    client.fail(2);
    await daemon.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.logOnCalls).toHaveLength(1);
  });

  it('never writes the refresh token to the logs', async () => {
    const token = validToken();
    const { client, raw } = await start(config({ refreshToken: token }));
    client.succeed();
    client.fail(EResult.Expired, 'Expired');
    expect(raw()).not.toContain(token);
  });
});
