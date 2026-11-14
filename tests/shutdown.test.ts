import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installShutdown } from '../src/utils/shutdown.js';
import { memoryLogger } from './helpers.js';

function setup(cleanup: () => Promise<void>, timeoutMs = 1000) {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const { log } = memoryLogger();
  const handle = installShutdown({ log, cleanup, timeoutMs, proc: proc as unknown as NodeJS.Process, exit });
  return { proc, exit, handle };
}

describe('installShutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['SIGTERM', 'SIGINT'])('runs cleanup once and exits 0 on %s', async (signal) => {
    const cleanup = vi.fn(async () => {});
    const { proc, exit, handle } = setup(cleanup);
    proc.emit(signal);
    await handle.shutdown('again');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when cleanup throws', async () => {
    const { exit, handle } = setup(async () => {
      throw new Error('boom');
    });
    await handle.shutdown('test');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits after the deadline when cleanup hangs', async () => {
    const { exit, handle } = setup(() => new Promise<void>(() => {}), 500);
    const p = handle.shutdown('test');
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit on a second signal', () => {
    const { proc, exit } = setup(() => new Promise<void>(() => {}));
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('dispose removes the signal listeners', () => {
    const { proc, handle } = setup(async () => {});
    handle.dispose();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});
