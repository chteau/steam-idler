import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachSteamGuardHandler, AuthError, checkRefreshToken, runQrLogin, type QrSessionLike } from '../src/steam/auth.js';
import { FakeSteamClient, fakeToken, memoryLogger, validToken } from './helpers.js';

class FakeQrSession extends EventEmitter implements QrSessionLike {
  loginTimeout = 0;
  refreshToken = '';
  cancelled = 0;
  constructor(private readonly start: () => Promise<{ qrChallengeUrl?: string }>) {
    super();
  }
  startWithQR() {
    return this.start();
  }
  cancelLoginAttempt() {
    this.cancelled += 1;
    return true;
  }
}

describe('checkRefreshToken', () => {
  it('accepts a SteamClient token and reports expiry', () => {
    const r = checkRefreshToken(validToken(10));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expiresInDays).toBe(9);
  });

  it('rejects web-only tokens', () => {
    const r = checkRefreshToken(fakeToken({ iss: 'steam', sub: '76561197960265729', aud: ['web', 'renew'], exp: Date.now() / 1000 + 1000 }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('npm run auth');
  });

  it('mirrors steam-user checks: issuer, audience, subject', () => {
    const exp = Date.now() / 1000 + 1000;
    const sub = '76561197960265729';
    expect(checkRefreshToken(fakeToken({ sub, aud: ['client'], exp })).ok).toBe(false); // no iss
    expect(checkRefreshToken(fakeToken({ iss: 'steam', sub, exp })).ok).toBe(false); // no aud
    expect(checkRefreshToken(fakeToken({ iss: 'steam', aud: ['client'], exp })).ok).toBe(false); // no sub
    expect(checkRefreshToken(fakeToken({ iss: 'steam', sub, aud: ['client'], exp })).ok).toBe(true);
  });

  it('rejects expired and unreadable tokens', () => {
    expect(checkRefreshToken(fakeToken({ iss: 'steam', sub: '76561197960265729', aud: ['client'], exp: 1 })).ok).toBe(false);
    expect(checkRefreshToken('a.%%%.c').ok).toBe(false);
    expect(checkRefreshToken('nodots').ok).toBe(false);
  });
});

describe('runQrLogin', () => {
  it('renders the QR challenge and resolves with the token on approval', async () => {
    const { log, raw } = memoryLogger();
    const session = new FakeQrSession(async () => ({ qrChallengeUrl: 'https://s.team/q/1/secret' }));
    const renderQr = vi.fn(() => {
      session.emit('remoteInteraction');
      session.refreshToken = 'the.refresh.token';
      session.emit('authenticated');
    });
    await expect(runQrLogin({ timeoutMs: 1000, log, renderQr, createSession: () => session })).resolves.toBe('the.refresh.token');
    expect(renderQr).toHaveBeenCalledWith('https://s.team/q/1/secret');
    expect(session.loginTimeout).toBe(1000);
    expect(session.cancelled).toBe(1);
    expect(session.listenerCount('authenticated')).toBe(0);
    expect(raw()).not.toContain('secret');
    expect(raw()).not.toContain('the.refresh.token');
  });

  it('fails clearly on timeout', async () => {
    const { log } = memoryLogger();
    const session = new FakeQrSession(async () => ({ qrChallengeUrl: 'u' }));
    const p = runQrLogin({ timeoutMs: 120_000, log, renderQr: () => session.emit('timeout'), createSession: () => session });
    await expect(p).rejects.toThrow(/not approved within 120 s/);
  });

  it('fails clearly on denial / Steam error', async () => {
    const { log } = memoryLogger();
    const session = new FakeQrSession(async () => ({ qrChallengeUrl: 'u' }));
    const p = runQrLogin({
      timeoutMs: 1000,
      log,
      renderQr: () => session.emit('error', new Error('FileNotFound')),
      createSession: () => session,
    });
    await expect(p).rejects.toBeInstanceOf(AuthError);
    await expect(p).rejects.toThrow('Steam login failed: FileNotFound');
  });

  it('fails when the QR session cannot start', async () => {
    const { log } = memoryLogger();
    const session = new FakeQrSession(async () => {
      throw new Error('network down');
    });
    await expect(runQrLogin({ timeoutMs: 1000, log, renderQr: vi.fn(), createSession: () => session })).rejects.toThrow(
      'Could not start QR login: network down',
    );
  });
});

describe('attachSteamGuardHandler', () => {
  it('reports a fatal condition instead of blocking on stdin when headless', () => {
    const client = new FakeSteamClient();
    const { log, lines } = memoryLogger();
    const onUnattended = vi.fn();
    const callback = vi.fn();
    attachSteamGuardHandler(client, log, onUnattended, false);
    client.emit('steamGuard', null, callback, false);
    expect(onUnattended).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    expect(lines().some((l) => l.level === 60)).toBe(true);
  });
});
