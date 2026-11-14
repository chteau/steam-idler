import type { Logger } from './logger.js';

export interface ShutdownOptions {
  log: Logger;
  /** Cleanup work; must finish quickly (DIGITALY waits ~10 s after SIGTERM). */
  cleanup: () => Promise<void>;
  timeoutMs?: number;
  proc?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
  exit?: (code: number) => void;
}

export interface ShutdownHandle {
  /** Triggers shutdown programmatically. Resolves once cleanup finished (or timed out). */
  shutdown(reason: string, code?: number): Promise<void>;
  dispose(): void;
}

/**
 * Handles SIGTERM/SIGINT once: runs cleanup with a deadline, then exits.
 * A second signal during cleanup forces an immediate exit.
 */
export function installShutdown(opts: ShutdownOptions): ShutdownHandle {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? 8_000;
  let running: Promise<void> | undefined;

  const shutdown = (reason: string, code = 0): Promise<void> => {
    if (running) return running;
    opts.log.info({ reason }, 'Shutting down');
    running = (async () => {
      let timer: NodeJS.Timeout | undefined;
      let exitCode = code;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const result = await Promise.race([opts.cleanup().then(() => 'done' as const), deadline]);
        if (result === 'timeout') {
          opts.log.warn({ timeoutMs }, 'Cleanup timed out; exiting anyway');
          exitCode = exitCode || 1;
        }
      } catch (err) {
        opts.log.error({ error: err instanceof Error ? err.message : String(err) }, 'Cleanup failed');
        exitCode = exitCode || 1;
      } finally {
        if (timer) clearTimeout(timer);
      }
      opts.log.info({ exitCode }, 'Stopped');
      exit(exitCode);
    })();
    return running;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (running) {
      opts.log.warn({ signal }, 'Second signal received; forcing exit');
      exit(1);
      return;
    }
    void shutdown(signal);
  };

  const onTerm = (): void => onSignal('SIGTERM');
  const onInt = (): void => onSignal('SIGINT');
  proc.on('SIGTERM', onTerm);
  proc.on('SIGINT', onInt);

  return {
    shutdown,
    dispose: () => {
      proc.removeListener('SIGTERM', onTerm);
      proc.removeListener('SIGINT', onInt);
    },
  };
}
