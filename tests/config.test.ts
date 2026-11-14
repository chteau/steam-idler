import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { validToken } from './helpers.js';

const cwd = '/srv/app';

describe('loadConfig', () => {
  it('applies defaults when variables are missing', () => {
    const c = loadConfig({}, cwd);
    expect(c).toEqual({
      refreshToken: undefined,
      appId: 2200,
      logLevel: 'info',
      sessionFile: path.resolve(cwd, 'data/session.json'),
      renewRefreshTokens: false,
    });
  });

  it('accepts a full valid configuration', () => {
    const token = validToken();
    const c = loadConfig(
      { STEAM_REFRESH_TOKEN: ` ${token} `, STEAM_APP_ID: '440', LOG_LEVEL: 'DEBUG', SESSION_FILE: 'state/s.json', STEAM_RENEW_REFRESH_TOKENS: 'true' },
      cwd,
    );
    expect(c.refreshToken).toBe(token);
    expect(c.appId).toBe(440);
    expect(c.logLevel).toBe('debug');
    expect(c.sessionFile).toBe(path.resolve(cwd, 'state/s.json'));
    expect(c.renewRefreshTokens).toBe(true);
  });

  it('treats an empty STEAM_REFRESH_TOKEN as missing', () => {
    expect(loadConfig({ STEAM_REFRESH_TOKEN: '   ' }, cwd).refreshToken).toBeUndefined();
  });

  it('disables file persistence with SESSION_FILE=none or empty', () => {
    expect(loadConfig({ SESSION_FILE: 'none' }, cwd).sessionFile).toBeUndefined();
    expect(loadConfig({ SESSION_FILE: '' }, cwd).sessionFile).toBeUndefined();
  });

  it.each([
    [{ STEAM_APP_ID: 'quake' }, 'STEAM_APP_ID must be a positive integer'],
    [{ STEAM_APP_ID: '0' }, 'STEAM_APP_ID must be between'],
    [{ STEAM_APP_ID: '-5' }, 'STEAM_APP_ID must be a positive integer'],
    [{ STEAM_APP_ID: '99999999999' }, 'STEAM_APP_ID must be between'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL must be one of'],
    [{ STEAM_REFRESH_TOKEN: 'not a token' }, 'does not look like a Steam refresh token'],
    [{ STEAM_RENEW_REFRESH_TOKENS: 'maybe' }, 'STEAM_RENEW_REFRESH_TOKENS must be'],
    [{ STEAM_RENEW_REFRESH_TOKENS: 'true', SESSION_FILE: 'none' }, 'requires SESSION_FILE'],
  ])('rejects %o', (env, message) => {
    expect(() => loadConfig(env, cwd)).toThrow(ConfigError);
    expect(() => loadConfig(env, cwd)).toThrow(message);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ STEAM_APP_ID: 'x', LOG_LEVEL: 'y' }, cwd);
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toHaveLength(2);
    }
  });

  it('never echoes a malformed token back in the error', () => {
    const secret = 'secret-value-with spaces';
    try {
      loadConfig({ STEAM_REFRESH_TOKEN: secret }, cwd);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
