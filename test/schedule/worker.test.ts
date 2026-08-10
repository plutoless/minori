import { describe, expect, it, vi } from 'vitest';

import { createScheduledTaskWorker } from '../../src/schedule/worker.js';

const run = {
  id: '00000000-0000-4000-8000-000000000001', scheduleId: 'task_1',
  scheduledFor: new Date('2026-08-11T01:00:00Z'), taskVersion: 1,
  instruction: 'Summarize',
  resultTarget: { chatId: 'oc_target', displayName: 'Product', chatType: 'group' as const },
  status: 'processing' as const, claimAttempt: 1,
  createdAt: new Date(), updatedAt: new Date(),
};
const task = {
  id: 'task_1', name: 'Daily', creatorOpenId: 'ou_1',
  origin: { chatId: 'oc_origin', displayName: 'Origin', chatType: 'p2p' as const },
  instruction: 'Summarize', version: 1,
  schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'UTC' },
  resultTarget: run.resultTarget, state: 'active' as const, nameReserved: true,
  createdAt: new Date(), updatedAt: new Date(),
};

function fixture() {
  const runs = {
    claimNext: vi.fn().mockResolvedValue(run),
    prepareDelivery: vi.fn().mockResolvedValue(`s:${run.id}:result`),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    beginFallback: vi.fn().mockResolvedValue(`s:${run.id}:fallback`),
    finishFallback: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    recoverExpired: vi.fn().mockResolvedValue(1),
  };
  const agent = { runScheduled: vi.fn().mockResolvedValue({
    text: 'Done', outcome: 'completed', sources: [], usage: {}, writeAttempts: [],
  }) };
  const messenger = { sendText: vi.fn().mockResolvedValue('om_result') };
  return { runs, agent, messenger, worker: createScheduledTaskWorker({
    runs, schedules: { get: vi.fn().mockResolvedValue(task) }, agent,
    agentDependencies: {} as never, messenger, leaseMs: 360_000,
  }) };
}

describe('ScheduledTaskWorker', () => {
  it('executes and sends one ordinary result with durable ordering and no retry', async () => {
    const { worker, runs, agent, messenger } = fixture();
    await expect(worker.processOne(new Date())).resolves.toBe(true);
    expect(agent.runScheduled).toHaveBeenCalledOnce();
    expect(runs.prepareDelivery).toHaveBeenCalledBefore(messenger.sendText);
    expect(messenger.sendText).toHaveBeenCalledWith(
      'oc_target', 'Done', `s:${run.id}:result`,
    );
    expect(runs.finish).toHaveBeenCalledWith(run.id, 1, 'completed', undefined);
  });

  it('records uncertain delivery once and sends one body-free origin fallback', async () => {
    const { worker, runs, messenger } = fixture();
    messenger.sendText
      .mockRejectedValueOnce(new Error('socket closed Bearer secret'))
      .mockResolvedValueOnce('om_fallback');
    await worker.processOne(new Date());
    expect(messenger.sendText).toHaveBeenCalledTimes(2);
    const fallback = messenger.sendText.mock.calls[1]![1] as string;
    expect(fallback).toContain('Daily');
    expect(fallback).toContain('Product');
    expect(fallback).not.toMatch(/Summarize|Bearer|Done|ou_1/iu);
    expect(runs.finish).toHaveBeenCalledWith(run.id, 1, 'delivery_uncertain', 'delivery_uncertain');
  });

  it('terminally recovers expired claims without invoking the Agent', async () => {
    const { worker, runs, agent } = fixture();
    await expect(worker.recover(new Date())).resolves.toBe(1);
    expect(runs.recoverExpired).toHaveBeenCalledOnce();
    expect(agent.runScheduled).not.toHaveBeenCalled();
  });
});
