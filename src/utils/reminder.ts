import type { Logger } from './logger.js';

export interface ReminderOptions {
  webhookUrl: string;
  /** Discord user ID to mention, if any. */
  userId: string | undefined;
  intervalMs: number;
  log: Logger;
  message?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Delays between delivery retries. */
  retryDelaysMs?: number[];
}

export interface Reminder {
  /** Next scheduled send (epoch ms). */
  readonly nextAt: number;
  stop(): void;
}

const DEFAULT_MESSAGE =
  'Time to renew the Steam idler on Bot-Hosting (the free plan needs a manual renewal every 4 days): https://bot-hosting.net';

/**
 * Next reminder time. Slots are aligned to the Unix epoch, so a restart neither resets the
 * countdown nor sends an extra ping: every N hours since 1970, whatever the process uptime.
 */
export function nextSlot(now: number, intervalMs: number): number {
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

/** Sends a renewal reminder to a Discord webhook on a fixed schedule. Never logs the webhook URL. */
export function startRenewReminder(opts: ReminderOptions): Reminder {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const retryDelays = opts.retryDelaysMs ?? [60_000, 5 * 60_000];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let nextAt = nextSlot(now(), opts.intervalMs);

  const content = `${opts.userId ? `<@${opts.userId}> ` : ''}${opts.message ?? DEFAULT_MESSAGE}`;
  const body = JSON.stringify({
    content,
    // Only ping the configured user, never @everyone or roles, whatever the message says.
    allowed_mentions: { parse: [], users: opts.userId ? [opts.userId] : [] },
  });

  const schedule = (at: number, fn: () => void): void => {
    timer = setTimeout(fn, Math.max(0, at - now()));
    timer.unref(); // never keeps the process alive on its own
  };

  const send = async (attempt: number): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetchImpl(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Discord answered HTTP ${res.status}`);
      opts.log.info('Renewal reminder sent to Discord');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const delay = retryDelays[attempt];
      if (delay === undefined || stopped) {
        opts.log.error({ error }, 'Could not send the renewal reminder to Discord; giving up until the next one');
        return;
      }
      opts.log.warn({ error, retryInMs: delay }, 'Renewal reminder failed; retrying');
      schedule(now() + delay, () => void send(attempt + 1));
      return;
    }
  };

  const tick = (): void => {
    void send(0);
    nextAt = nextSlot(now(), opts.intervalMs);
    schedule(nextAt, tick);
  };

  schedule(nextAt, tick);
  opts.log.info({ nextReminderAt: new Date(nextAt).toISOString() }, 'Discord renewal reminder enabled');

  return {
    get nextAt() {
      return nextAt;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
