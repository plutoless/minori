import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRetentionService } from '../../src/storage/retention.js';

describe('createRetentionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('purges once at startup and then daily until stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const purgeExpired = vi.fn().mockResolvedValue(2);
    const service = createRetentionService({ purgeExpired }, {
      retentionMs: 30 * 24 * 60 * 60 * 1_000,
      intervalMs: 24 * 60 * 60 * 1_000,
      now: () => new Date(Date.now()),
    });

    await service.start();
    expect(purgeExpired).toHaveBeenLastCalledWith(new Date('2026-07-06T12:00:00Z'));

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(purgeExpired).toHaveBeenLastCalledWith(new Date('2026-07-07T12:00:00Z'));
    expect(purgeExpired).toHaveBeenCalledTimes(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
  });

  it('reports failure and keeps the daily retry scheduled after startup fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const purgeExpired = vi.fn()
      .mockRejectedValueOnce(new Error('database_unavailable'))
      .mockResolvedValueOnce(1);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const service = createRetentionService({ purgeExpired }, {
      retentionMs: 30 * 24 * 60 * 60 * 1_000,
      intervalMs: 24 * 60 * 60 * 1_000,
      now: () => new Date(Date.now()),
      onSuccess,
      onError,
    });

    await expect(service.start()).rejects.toThrow('database_unavailable');
    expect(onError).toHaveBeenCalledWith({ errorCode: 'retention_purge_failed' });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);

    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    service.stop();
  });
});
