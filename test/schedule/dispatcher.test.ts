import { describe, expect, it, vi } from 'vitest';

import { createScheduleDispatcher } from '../../src/schedule/dispatcher.js';

const task = {
  id: 'task_1', name: 'Daily', creatorOpenId: 'ou_1',
  origin: { chatId: 'oc_1', displayName: 'Origin', chatType: 'p2p' as const },
  instruction: 'Run', version: 1,
  schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  resultTarget: { chatId: 'oc_1', displayName: 'Origin', chatType: 'p2p' as const },
  state: 'active' as const, nameReserved: true,
  nextDueAt: new Date('2026-08-10T01:00:00Z'),
  createdAt: new Date(), updatedAt: new Date(),
};

describe('ScheduleDispatcher', () => {
  it('folds downtime to the latest calendar occurrence and advances from the calendar', async () => {
    const store = { listDispatchable: vi.fn().mockResolvedValue([task]) };
    const runs = { createDue: vi.fn().mockResolvedValue({ status: 'created', run: {} }) };
    const calendar = {
      normalize: vi.fn(),
      latestAtOrBefore: vi.fn().mockReturnValue(new Date('2026-08-13T01:00:00Z')),
      next: vi.fn().mockReturnValue(new Date('2026-08-14T01:00:00Z')),
    };
    const dispatcher = createScheduleDispatcher({ store, runs, calendar, enabled: true, pollMs: 15_000 });

    await expect(dispatcher.poll(new Date('2026-08-13T02:00:00Z'))).resolves.toEqual({
      created: 1, folded: 1,
    });
    expect(runs.createDue).toHaveBeenCalledWith({
      scheduleId: 'task_1', expectedDueAt: task.nextDueAt,
      scheduledFor: new Date('2026-08-13T01:00:00Z'),
      nextDueAt: new Date('2026-08-14T01:00:00Z'),
    });
    expect(dispatcher.status()).toBe('ok');
  });

  it('is disabled without querying and degrades independently after a poll failure', async () => {
    const store = { listDispatchable: vi.fn().mockRejectedValue(new Error('secret')) };
    const runs = { createDue: vi.fn() };
    const calendar = { normalize: vi.fn(), latestAtOrBefore: vi.fn(), next: vi.fn() };
    const disabled = createScheduleDispatcher({ store, runs, calendar, enabled: false, pollMs: 15_000 });
    await expect(disabled.poll(new Date())).resolves.toEqual({ created: 0, folded: 0 });
    expect(disabled.status()).toBe('disabled');
    expect(store.listDispatchable).not.toHaveBeenCalled();

    const enabled = createScheduleDispatcher({ store, runs, calendar, enabled: true, pollMs: 15_000 });
    await expect(enabled.poll(new Date())).rejects.toThrow('schedule_dispatch_failed');
    expect(enabled.status()).toBe('degraded');
  });
});
