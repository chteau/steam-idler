import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileSessionStore,
  fingerprint,
  MemorySessionStore,
  resolveRefreshToken,
  SessionFileCorruptError,
  type StoredSession,
} from '../src/storage/session-store.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-idler-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const session = (token: string, extra: Partial<StoredSession> = {}): StoredSession => ({
  version: 1,
  refreshToken: token,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('FileSessionStore', () => {
  it('returns null when the file does not exist', async () => {
    expect(await new FileSessionStore(path.join(dir, 'missing.json')).load()).toBeNull();
  });

  it('round-trips a session and creates private files', async () => {
    const file = path.join(dir, 'nested', 'session.json');
    const store = new FileSessionStore(file);
    await store.save(session('a.b.c'));
    expect(await store.load()).toEqual(session('a.b.c'));
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });

  it('writes atomically: no temp files left, old content replaced in one step', async () => {
    const file = path.join(dir, 'session.json');
    const store = new FileSessionStore(file);
    await store.save(session('old.token.x'));
    await store.save(session('new.token.y'));
    expect((await store.load())?.refreshToken).toBe('new.token.y');
    expect(await fs.readdir(dir)).toEqual(['session.json']);
  });

  it('keeps the previous file intact when the rename fails', async () => {
    const file = path.join(dir, 'session.json');
    const store = new FileSessionStore(file);
    await store.save(session('old.token.x'));
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    await expect(store.save(session('new.token.y'))).rejects.toThrow('EXDEV');
    spy.mockRestore();
    expect((await store.load())?.refreshToken).toBe('old.token.x');
    expect(await fs.readdir(dir)).toEqual(['session.json']);
  });

  it('quarantines a corrupt file instead of deleting it', async () => {
    const file = path.join(dir, 'session.json');
    await fs.writeFile(file, '{ not json');
    const store = new FileSessionStore(file);
    const err = await store.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionFileCorruptError);
    const moved = (err as SessionFileCorruptError).movedTo;
    expect(moved).toMatch(/session\.json\.corrupt-\d+$/);
    expect(await fs.readFile(moved!, 'utf8')).toBe('{ not json');
    expect(await store.load()).toBeNull();
  });

  it('rejects valid JSON with the wrong shape', async () => {
    const file = path.join(dir, 'session.json');
    await fs.writeFile(file, JSON.stringify({ version: 2, refreshToken: 42 }));
    await expect(new FileSessionStore(file).load()).rejects.toBeInstanceOf(SessionFileCorruptError);
  });
});

describe('MemorySessionStore', () => {
  it('keeps the last saved session', async () => {
    const store = new MemorySessionStore();
    expect(await store.load()).toBeNull();
    await store.save(session('m.e.m'));
    expect((await store.load())?.refreshToken).toBe('m.e.m');
  });
});

describe('resolveRefreshToken', () => {
  it('reports none when nothing is available', () => {
    expect(resolveRefreshToken(null, undefined)).toEqual({ token: undefined, source: 'none' });
  });

  it('uses the env token when there is no file', () => {
    expect(resolveRefreshToken(null, 'env.t.k')).toEqual({ token: 'env.t.k', source: 'env' });
  });

  it('uses the file when there is no env token', () => {
    expect(resolveRefreshToken(session('file.t.k'), undefined)).toEqual({ token: 'file.t.k', source: 'file' });
  });

  it('prefers a rotated token bootstrapped from the same env token', () => {
    const stored = session('rotated.t.k', { envFingerprint: fingerprint('env.t.k') });
    expect(resolveRefreshToken(stored, 'env.t.k')).toEqual({ token: 'rotated.t.k', source: 'file' });
  });

  it('prefers a new env token over a file rotated from an older one (manual recovery)', () => {
    const stored = session('rotated.t.k', { envFingerprint: fingerprint('old.env.tok') });
    expect(resolveRefreshToken(stored, 'new.env.tok')).toEqual({ token: 'new.env.tok', source: 'env' });
  });

  it('prefers a file written by `npm run auth`', () => {
    expect(resolveRefreshToken(session('fresh.t.k'), 'old.env.tok')).toEqual({ token: 'fresh.t.k', source: 'file' });
  });

  it('fingerprints are short and do not contain the token', () => {
    const fp = fingerprint('abc.def.ghi');
    expect(fp).toHaveLength(16);
    expect(fp).not.toContain('abc');
  });
});
