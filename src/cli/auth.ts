import path from 'node:path';
import { loadConfig, ConfigError } from '../config.js';
import { AuthError, checkRefreshToken, runQrLogin } from '../steam/auth.js';
import { FileSessionStore } from '../storage/session-store.js';
import { createLogger } from '../utils/logger.js';

const TIMEOUT_MS = 3 * 60_000;

/**
 * `npm run auth`: interactive QR login. Saves the SteamClient refresh token to SESSION_FILE
 * (mode 0600). The token is never printed.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig({ ...process.env, STEAM_REFRESH_TOKEN: '' });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78);
    }
    throw err;
  }
  if (!config.sessionFile) {
    process.stderr.write('SESSION_FILE is disabled; set it to a local path (e.g. ./data/session.json) to run auth.\n');
    process.exit(78);
  }
  const log = createLogger(config.logLevel === 'silent' ? 'info' : config.logLevel);
  const store = new FileSessionStore(config.sessionFile);

  process.stdout.write(
    '\nScan this QR code with the Steam mobile app (Steam Guard > scan icon), then approve the login.\n' +
      `It expires in ${TIMEOUT_MS / 60_000} minutes. Do not screenshot or share it.\n\n`,
  );

  const token = await runQrLogin({ timeoutMs: TIMEOUT_MS, log });
  const check = checkRefreshToken(token);
  if (!check.ok) throw new AuthError(`Steam returned an unusable token: ${check.reason}`);

  await store.save({ version: 1, refreshToken: token, updatedAt: new Date().toISOString() });
  const rel = path.relative(process.cwd(), config.sessionFile) || config.sessionFile;
  process.stdout.write(
    `\nLogged in${check.info.steamId ? ` as SteamID ${check.info.steamId}` : ''}.\n` +
      `Refresh token saved to ${rel} (permissions 0600)` +
      `${check.info.expiresAt ? `, valid until ${check.info.expiresAt.toISOString().slice(0, 10)}` : ''}.\n` +
      'For DIGITALY Cloud: open that file yourself and copy the "refreshToken" value into the\n' +
      'STEAM_REFRESH_TOKEN environment variable. Never commit or paste it anywhere else.\n',
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nAuthentication failed: ${msg}\n`);
  process.exit(1);
});
