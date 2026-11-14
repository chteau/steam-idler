import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceManager } from '../src/steam/presence.js';
import { FakeSteamClient, memoryLogger } from './helpers.js';

const APP = 2200;

function setup(opts: { confirmTimeoutMs?: number; maxUnconfirmedAttempts?: number } = {}) {
  const client = new FakeSteamClient();
  const { log, lines } = memoryLogger();
  const presence = new PresenceManager(client, log, { appId: APP, ...opts });
  return { client, presence, lines };
}

describe('PresenceManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing before logon', () => {
    const { client, presence } = setup();
    presence.onPlayingState(false, 0);
    expect(client.gamesPlayedCalls).toEqual([]);
    expect(presence.state).toBe('offline');
  });

  it('activates presence after logon and confirms it from playingState', () => {
    const { client, presence } = setup();
    presence.onLoggedOn();
    expect(client.gamesPlayedCalls).toEqual([[APP]]);
    expect(presence.state).toBe('pending');
    presence.onPlayingState(false, APP);
    expect(presence.state).toBe('playing');
  });

  it('does not resend while pending or playing', () => {
    const { client, presence } = setup();
    presence.onLoggedOn();
    presence.onLoggedOn(); // duplicate event
    presence.onPlayingState(false, APP);
    presence.onPlayingState(false, APP);
    expect(client.gamesPlayedCalls).toHaveLength(1);
  });

  it('restores presence after a disconnect and new logon', () => {
    const { client, presence } = setup();
    presence.onLoggedOn();
    presence.onPlayingState(false, APP);
    presence.onDisconnected();
    expect(presence.state).toBe('offline');
    presence.onLoggedOn();
    expect(client.gamesPlayedCalls).toEqual([[APP], [APP]]);
  });

  it('waits while blocked, never forces, and restores when the other session stops', () => {
    const { client, presence, lines } = setup();
    presence.onLoggedOn();
    presence.onPlayingState(false, APP);
    // The user starts a game on their PC: our session is blocked.
    presence.onPlayingState(true, 730);
    expect(presence.state).toBe('blocked');
    presence.onPlayingState(true, 730);
    expect(lines().filter((l) => String(l.msg).includes('another session'))).toHaveLength(1);
    expect(client.gamesPlayedCalls).toEqual([[APP]]);
    // They quit the game.
    presence.onPlayingState(false, 0);
    expect(client.gamesPlayedCalls).toEqual([[APP], [APP]]);
    expect(presence.state).toBe('pending');
  });

  it('does not set presence when blocked right after logon', () => {
    const { client, presence } = setup();
    presence.onLoggedOn(); // sends once
    presence.onPlayingState(true, 440);
    vi.advanceTimersByTime(60_000);
    expect(client.gamesPlayedCalls).toHaveLength(1);
  });

  it('retries an unconfirmed request, then gives up for the session', () => {
    const { client, presence, lines } = setup({ confirmTimeoutMs: 1000, maxUnconfirmedAttempts: 3 });
    presence.onLoggedOn();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10_000);
    expect(client.gamesPlayedCalls).toHaveLength(3);
    expect(presence.state).toBe('failed');
    expect(lines().some((l) => l.level === 50)).toBe(true);
    // A new logon session gets a fresh budget.
    presence.onDisconnected();
    presence.onLoggedOn();
    expect(client.gamesPlayedCalls).toHaveLength(4);
  });

  it('ignores a stale echo while pending instead of resending', () => {
    const { client, presence } = setup({ confirmTimeoutMs: 1000 });
    presence.onLoggedOn();
    presence.onPlayingState(false, 0); // Steam echoes the old state
    expect(client.gamesPlayedCalls).toHaveLength(1);
    presence.onPlayingState(false, APP);
    expect(presence.state).toBe('playing');
    vi.advanceTimersByTime(10_000);
    expect(client.gamesPlayedCalls).toHaveLength(1);
  });

  it('is bounded when Steam keeps answering with another app id', () => {
    const { client, presence } = setup({ confirmTimeoutMs: 1000, maxUnconfirmedAttempts: 3 });
    presence.onLoggedOn();
    for (let i = 0; i < 10; i++) {
      presence.onPlayingState(false, 0);
      vi.advanceTimersByTime(1000);
    }
    expect(client.gamesPlayedCalls).toHaveLength(3);
    expect(presence.state).toBe('failed');
  });

  it('restores presence when the game is cleared while playing', () => {
    const { client, presence } = setup();
    presence.onLoggedOn();
    presence.onPlayingState(false, APP);
    presence.onPlayingState(false, 0);
    expect(client.gamesPlayedCalls).toEqual([[APP], [APP]]);
  });

  it('clears the game on stop only when it was set', () => {
    const { client, presence } = setup();
    expect(presence.stop()).toBe(false);
    presence.onLoggedOn();
    presence.onPlayingState(false, APP);
    expect(presence.stop()).toBe(true);
    expect(client.gamesPlayedCalls.at(-1)).toEqual([]);
    // Late events after stop are ignored.
    presence.onPlayingState(false, 0);
    expect(client.gamesPlayedCalls.at(-1)).toEqual([]);
  });
});
