import pino, { type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

/**
 * Paths that must never reach the log output. Pino replaces them with "[Redacted]".
 * This is a safety net: the code never passes secrets to the logger on purpose.
 */
export const REDACT_PATHS = [
  'refreshToken',
  'accessToken',
  'token',
  'password',
  'qrChallengeUrl',
  'challengeUrl',
  'machineAuthToken',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.password',
  '*.qrChallengeUrl',
  '*.challengeUrl',
  '*.machineAuthToken',
];

export function createLogger(level: LevelWithSilent, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'steam-idler' },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // Synchronous stdout: log volume is tiny and nothing is lost when the process exits.
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
