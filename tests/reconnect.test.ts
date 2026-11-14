import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  classifyError,
  DEFAULT_BACKOFF,
  EResult,
  ReconnectController,
  type BackoffPolicy,
} from '../src/steam/reconnect.js';
import { FakeSteamClient, memoryLogger } from './helpers.js';

const policy: BackoffPolicy = { baseMs: 1000, maxMs: 16_000, replacedMinMs: 60_000, throttledMinMs: 300_000 };

function setup(random = () => 1) {
  const client = new FakeSteamClient();
  const { log, raw } = memoryLogger();
  const events = { onLoggedOn: vi.fn(), onDisconnected: vi.fn(), onFatal: vi.fn() };
  const ctl = new ReconnectController(client, log, events, { getRefreshToken: () => 'tok', policy, random });
  return { client, ctl, events, raw };
}

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const max = (a: number) => backoffDelay(a, policy, () => 1);
    expect([1, 2, 3, 4, 5, 6, 10].map(max)).toEqual([1000, 2000, 4000, 8000, 16_000, 16_000, 16_000]);
  });

  it('applies equal jitter (between half and full delay)', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(2000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(3000);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(4, policy);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('default policy never retries faster than every 2.5 s or slower than 15 min', () => {
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(2500);
    expect(backoffDelay(50, DEFAULT_BACKOFF, () => 1)).toBe(15 * 60_000);
  });
});

describe('classifyError', () => {
  it.each([
    [EResult.AccessDenied, 'fatal'],
    [EResult.Expired, 'fatal'],
    [EResult.Revoked, 'fatal'],
    [EResult.InvalidPassword, 'fatal'],
    [EResult.RateLimitExceeded, 'throttled'],
    [EResult.LoggedInElsewhere, 'replaced'],
    [EResult.LogonSessionReplaced, 'replaced'],
    [2, 'transient'],
    [undefined, 'transient'],
  ])('eresult %s -> %s', (eresult, kind) => {
    expect(classifyError(Object.assign(new Error('x'), { eresult }))).toBe(kind);
  });

  it('treats token errors without an eresult as fatal', () => {
    expect(classifyError(new Error('This refresh token is not valid for use with SteamClient'))).toBe('fatal');
  });
});

describe('ReconnectController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs on once and reports success', () => {
    const { client, ctl, events } = setup();
    expect(ctl.start()).toBe(true);
    expect(ctl.state).toBe('authenticating');
    client.succeed();
    expect(ctl.state).toBe('connected');
    expect(events.onLoggedOn).toHaveBeenCalledOnce();
    expect(client.logOnCalls).toEqual([{ refreshToken: 'tok', }]);
  });

  it('prevents duplicate concurrent logon attempts', () => {
    const { client, ctl } = setup();
    ctl.start();
    expect(ctl.start()).toBe(false);
    client.succeed();
    expect(ctl.start()).toBe(false);
    expect(client.logOnCalls).toHaveLength(1);
  });

  it('leaves non-fatal disconnects to steam-user autoRelogin', () => {
    const { client, ctl, events } = setup();
    ctl.start();
    client.succeed();
    client.emit('disconnected', 3, 'NoConnection');
    expect(ctl.state).toBe('disconnected');
    expect(events.onDisconnected).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3_600_000);
    expect(client.logOnCalls).toHaveLength(1); // we did not interfere
    client.succeed();
    expect(ctl.state).toBe('connected');
    expect(events.onLoggedOn).toHaveBeenCalledTimes(2);
  });

  it('retries transient errors with growing delays and a single timer', () => {
    const { client, ctl } = setup();
    ctl.start();
    client.fail(2); // attempt 1 -> 1000 ms
    client.fail(2); // duplicate error while a retry is scheduled: ignored
    expect(ctl.state).toBe('backoff');
    vi.advanceTimersByTime(999);
    expect(client.logOnCalls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(client.logOnCalls).toHaveLength(2);
    client.fail(2); // attempt 2 -> 2000 ms
    vi.advanceTimersByTime(1999);
    expect(client.logOnCalls).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(client.logOnCalls).toHaveLength(3);
    client.succeed();
    client.fail(2); // connected -> error: attempt counter reset
    vi.advanceTimersByTime(1000);
    expect(client.logOnCalls).toHaveLength(4);
  });

  it('backs off for a long time when rate limited or replaced', () => {
    const { client, ctl } = setup();
    ctl.start();
    client.fail(EResult.RateLimitExceeded);
    vi.advanceTimersByTime(299_999);
    expect(client.logOnCalls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(client.logOnCalls).toHaveLength(2);
    client.fail(EResult.LoggedInElsewhere);
    vi.advanceTimersByTime(59_999);
    expect(client.logOnCalls).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(client.logOnCalls).toHaveLength(3);
  });

  it('stops for good on fatal errors', () => {
    const { client, ctl, events } = setup();
    ctl.start();
    client.fail(EResult.AccessDenied, 'AccessDenied');
    expect(ctl.state).toBe('fatal');
    expect(events.onFatal).toHaveBeenCalledOnce();
    client.fail(2);
    vi.advanceTimersByTime(3_600_000);
    expect(client.logOnCalls).toHaveLength(1);
    expect(ctl.start()).toBe(false);
  });

  it('handles a synchronous logOn throw as an error', () => {
    const { client, ctl, events } = setup();
    client.throwOnLogOn = new Error('Invalid refresh token: audience mismatch');
    ctl.start();
    expect(ctl.state).toBe('fatal');
    expect(events.onFatal).toHaveBeenCalledOnce();
  });

  it('cancels a pending retry on stop and ignores later events', () => {
    const { client, ctl, events } = setup();
    ctl.start();
    client.fail(2);
    ctl.stop();
    vi.advanceTimersByTime(60_000);
    expect(client.logOnCalls).toHaveLength(1);
    client.succeed();
    expect(events.onLoggedOn).not.toHaveBeenCalled();
    expect(() => client.fail(2)).not.toThrow(); // error listener still attached: no crash
  });

  it('does not call logOn while steam-user still holds a session', () => {
    const { client, ctl } = setup();
    ctl.start();
    client.succeed();
    client.emit('error', Object.assign(new Error('x'), { eresult: 2 })); // steamID not cleared yet
    vi.advanceTimersByTime(1000);
    expect(client.logOnCalls).toHaveLength(1);
    expect(ctl.state).toBe('backoff');
    client.steamID = null;
    vi.advanceTimersByTime(2000);
    expect(client.logOnCalls).toHaveLength(2);
  });

  it('dispose removes its listeners', () => {
    const { client, ctl } = setup();
    ctl.dispose();
    expect(client.listenerCount('loggedOn')).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('never logs the refresh token', () => {
    const { client, ctl, raw } = setup();
    ctl.start();
    client.fail(2);
    client.fail(EResult.AccessDenied);
    expect(raw()).not.toContain('tok"');
  });
});
