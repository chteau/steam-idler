import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextSlot, startRenewReminder } from '../src/utils/reminder.js';
import { memoryLogger } from './helpers.js';

const HOUR = 3_600_000;
const WEBHOOK = 'https://discord.com/api/webhooks/1/secret-token';

describe('nextSlot', () => {
  it('aligns to the epoch so restarts keep the same schedule', () => {
    expect(nextSlot(0, 72 * HOUR)).toBe(72 * HOUR);
    expect(nextSlot(72 * HOUR - 1, 72 * HOUR)).toBe(72 * HOUR);
    expect(nextSlot(72 * HOUR, 72 * HOUR)).toBe(144 * HOUR);
  });
});

describe('startRenewReminder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * HOUR);
  });
  afterEach(() => vi.useRealTimers());

  function setup(responses: Array<number | Error> = []) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const r = responses.shift() ?? 204;
      if (r instanceof Error) throw r;
      return new Response(null, { status: r });
    });
    const mem = memoryLogger();
    const reminder = startRenewReminder({
      webhookUrl: WEBHOOK,
      userId: '123456789012345678',
      intervalMs: 72 * HOUR,
      log: mem.log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [1000, 2000],
    });
    return { calls, reminder, ...mem };
  }

  it('mentions only the configured user, every interval', async () => {
    const { calls, reminder } = setup();
    expect(reminder.nextAt).toBe(72 * HOUR);
    await vi.advanceTimersByTimeAsync(62 * HOUR - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      content: expect.stringMatching(/^<@123456789012345678> /),
      allowed_mentions: { parse: [], users: ['123456789012345678'] },
    });
    await vi.advanceTimersByTimeAsync(72 * HOUR);
    expect(calls).toHaveLength(2);
    reminder.stop();
  });

  it('retries failed deliveries a bounded number of times, never logging the URL', async () => {
    const { calls, reminder, raw } = setup([500, new Error('network down'), 429]);
    await vi.advanceTimersByTimeAsync(62 * HOUR);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
    expect(raw()).toContain('giving up until the next one');
    expect(raw()).not.toContain('secret-token');
    reminder.stop();
  });

  it('stop cancels the schedule', async () => {
    const { calls, reminder } = setup();
    reminder.stop();
    await vi.advanceTimersByTimeAsync(200 * HOUR);
    expect(calls).toHaveLength(0);
  });
});
