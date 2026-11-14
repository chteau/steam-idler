import { startDaemon } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createSteamClient } from './steam/client.js';
import { FileSessionStore, MemorySessionStore } from './storage/session-store.js';
import { createLogger } from './utils/logger.js';
import { startRenewReminder } from './utils/reminder.js';
import { installShutdown } from './utils/shutdown.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example and README.md.\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const log = createLogger(config.logLevel);

  process.on('uncaughtException', (err) => {
    log.fatal({ error: err.message, stack: err.stack }, 'Uncaught exception; exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ error: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection; exiting');
    process.exit(1);
  });

  const store = config.sessionFile ? new FileSessionStore(config.sessionFile) : new MemorySessionStore();
  const client = createSteamClient({ renewRefreshTokens: config.renewRefreshTokens });

  let daemon;
  try {
    daemon = await startDaemon(config, { log, store, client });
  } catch (err) {
    if (err instanceof ConfigError) {
      log.fatal({ problems: err.problems }, 'Cannot start');
      process.exit(78);
    }
    throw err;
  }

  const reminder = config.reminder
    ? startRenewReminder({
        webhookUrl: config.reminder.webhookUrl,
        userId: config.reminder.userId,
        intervalMs: config.reminder.intervalHours * 3_600_000,
        log,
      })
    : undefined;

  installShutdown({
    log,
    cleanup: async () => {
      reminder?.stop();
      await daemon.stop();
    },
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
