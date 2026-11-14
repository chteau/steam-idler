import path from 'node:path';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** Bootstrap refresh token from the environment, if any. */
  refreshToken: string | undefined;
  appId: number;
  logLevel: LogLevel;
  /** Absolute path of the session file, or undefined when file persistence is disabled. */
  sessionFile: string | undefined;
  renewRefreshTokens: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const MAX_APP_ID = 0xffffffff;

function parseBool(name: string, raw: string | undefined, fallback: boolean, problems: string[]): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be "true" or "false" (got "${raw}").`);
  return fallback;
}

/**
 * Reads and validates configuration. Collects every problem before failing so a
 * misconfigured deployment is fixed in one round.
 * Does not require STEAM_REFRESH_TOKEN: a token stored in SESSION_FILE is also valid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const problems: string[] = [];

  const tokenRaw = env.STEAM_REFRESH_TOKEN?.trim();
  const refreshToken = tokenRaw ? tokenRaw : undefined;
  if (refreshToken !== undefined && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(refreshToken)) {
    problems.push(
      'STEAM_REFRESH_TOKEN does not look like a Steam refresh token (expected a JWT: three dot-separated parts). ' +
        'Copy the "refreshToken" value from the session file written by `npm run auth`, without quotes or spaces.',
    );
  }

  const appIdRaw = env.STEAM_APP_ID?.trim() || '2200';
  let appId = Number.NaN;
  if (!/^\d+$/.test(appIdRaw)) {
    problems.push(`STEAM_APP_ID must be a positive integer (got "${appIdRaw}").`);
  } else {
    appId = Number(appIdRaw);
    if (appId <= 0 || appId > MAX_APP_ID) {
      problems.push(`STEAM_APP_ID must be between 1 and ${MAX_APP_ID} (got ${appIdRaw}).`);
    }
  }

  const levelRaw = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  let logLevel: LogLevel = 'info';
  if ((LOG_LEVELS as readonly string[]).includes(levelRaw)) {
    logLevel = levelRaw as LogLevel;
  } else {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${env.LOG_LEVEL}").`);
  }

  // SESSION_FILE unset -> default path; set to "none" or empty-string-by-intent -> disabled.
  const sessionRaw = env.SESSION_FILE;
  let sessionFile: string | undefined;
  if (sessionRaw === undefined) {
    sessionFile = path.resolve(cwd, 'data/session.json');
  } else if (sessionRaw.trim() === '' || sessionRaw.trim().toLowerCase() === 'none') {
    sessionFile = undefined;
  } else {
    sessionFile = path.resolve(cwd, sessionRaw.trim());
  }

  const renewRefreshTokens = parseBool('STEAM_RENEW_REFRESH_TOKENS', env.STEAM_RENEW_REFRESH_TOKENS, false, problems);
  if (renewRefreshTokens && sessionFile === undefined) {
    problems.push(
      'STEAM_RENEW_REFRESH_TOKENS=true requires SESSION_FILE: a renewed token invalidates the old one and must be saved.',
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return { refreshToken, appId, logLevel, sessionFile, renewRefreshTokens };
}
