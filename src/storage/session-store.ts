import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StoredSession {
  version: 1;
  refreshToken: string;
  /** Fingerprint of the STEAM_REFRESH_TOKEN this file was bootstrapped from (see resolveRefreshToken). */
  envFingerprint?: string;
  updatedAt: string;
}

export interface SessionStore {
  /** Human-readable location, safe to log. */
  readonly description: string;
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
}

export class SessionFileCorruptError extends Error {
  constructor(
    public readonly file: string,
    public readonly movedTo: string | undefined,
    cause: unknown,
  ) {
    super(`Session file ${file} is unreadable or malformed${movedTo ? `; moved to ${movedTo}` : ''}`, { cause });
    this.name = 'SessionFileCorruptError';
  }
}

/** Short, non-reversible fingerprint used to tell tokens apart without storing or logging them twice. */
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isStoredSession(v: unknown): v is StoredSession {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.refreshToken === 'string' &&
    o.refreshToken.length > 0 &&
    typeof o.updatedAt === 'string' &&
    (o.envFingerprint === undefined || typeof o.envFingerprint === 'string')
  );
}

/**
 * JSON file store. Writes are atomic (temp file + fsync + rename) and the file is
 * created with mode 0600 inside a 0700 directory.
 */
export class FileSessionStore implements SessionStore {
  readonly description: string;

  constructor(private readonly file: string) {
    this.description = `file ${file}`;
  }

  async load(): Promise<StoredSession | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SessionFileCorruptError(this.file, await this.quarantine(), err);
    }
    if (!isStoredSession(parsed)) {
      throw new SessionFileCorruptError(this.file, await this.quarantine(), new Error('unexpected shape'));
    }
    return parsed;
  }

  async save(session: StoredSession): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (err) {
      await handle.close();
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    try {
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    // Make the rename itself durable. Not supported everywhere (e.g. Windows), so best effort.
    try {
      const dirHandle = await fs.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* directory fsync is unsupported on this platform; the rename is still atomic */
    }
  }

  /** Keeps a corrupt file for inspection instead of deleting it (it may hold the only copy of a token). */
  private async quarantine(): Promise<string | undefined> {
    const target = `${this.file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.file, target);
      return target;
    } catch {
      return undefined;
    }
  }
}

/** Used when SESSION_FILE is disabled: keeps the latest token for the life of the process only. */
export class MemorySessionStore implements SessionStore {
  readonly description = 'memory (not persisted)';
  private session: StoredSession | null = null;

  async load(): Promise<StoredSession | null> {
    return this.session;
  }

  async save(session: StoredSession): Promise<void> {
    this.session = { ...session };
  }
}

export type TokenSource = 'env' | 'file' | 'none';

export interface ResolvedToken {
  token: string | undefined;
  source: TokenSource;
}

/**
 * Picks the token to log on with.
 * - The file wins when it was bootstrapped from the current env token: it may hold a rotated, newer token.
 * - A file written by `npm run auth` (no env fingerprint) wins: it is the most recent login on this machine.
 * - The env wins when it differs from what the file was bootstrapped from: the operator re-authenticated
 *   and updated STEAM_REFRESH_TOKEN, which is the manual recovery procedure.
 */
export function resolveRefreshToken(stored: StoredSession | null, envToken: string | undefined): ResolvedToken {
  if (envToken === undefined) {
    return stored ? { token: stored.refreshToken, source: 'file' } : { token: undefined, source: 'none' };
  }
  if (stored && stored.envFingerprint === fingerprint(envToken)) {
    return { token: stored.refreshToken, source: 'file' };
  }
  if (stored && stored.envFingerprint === undefined) {
    // Written by `npm run auth` on this machine: that is the freshest token available.
    return { token: stored.refreshToken, source: 'file' };
  }
  return { token: envToken, source: 'env' };
}
