import { afterEach, describe, expect, it, vi } from 'vitest';

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
    extendLease: vi.fn().mockResolvedValue(true),
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
  const messenger = {
    sendText: vi.fn().mockResolvedValue('om_control'),
    sendRichContent: vi.fn().mockResolvedValue('om_result'),
  };
  return { runs, agent, messenger, worker: createScheduledTaskWorker({
    runs, schedules: { get: vi.fn().mockResolvedValue(task) }, agent,
    agentDependencies: {} as never, messenger, leaseMs: 360_000,
  }) };
}

describe('ScheduledTaskWorker', () => {
  afterEach(() => vi.useRealTimers());
  it('executes and sends one ordinary result with durable ordering and no retry', async () => {
    const { worker, runs, agent, messenger } = fixture();
    await expect(worker.processOne(new Date())).resolves.toBe(true);
    expect(agent.runScheduled).toHaveBeenCalledOnce();
    expect(runs.prepareDelivery).toHaveBeenCalledBefore(messenger.sendRichContent);
    expect(messenger.sendRichContent).toHaveBeenCalledWith(
      'oc_target', 'Done', `s:${run.id}:result`,
    );
    expect(messenger.sendText).not.toHaveBeenCalled();
    expect(runs.finish).toHaveBeenCalledWith(run.id, 1, 'completed', undefined);
  });

  it('records uncertain delivery once and sends one body-free origin fallback', async () => {
    const { worker, runs, messenger } = fixture();
    messenger.sendRichContent.mockRejectedValueOnce(new Error('socket closed Bearer secret'));
    messenger.sendText.mockResolvedValueOnce('om_fallback');
    await worker.processOne(new Date());
    expect(messenger.sendRichContent).toHaveBeenCalledOnce();
    expect(messenger.sendText).toHaveBeenCalledOnce();
    const fallback = messenger.sendText.mock.calls[0]![1] as string;
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

  it('periodically recovers claims that expire after startup', async () => {
    vi.useFakeTimers();
    const { worker, runs } = fixture();
    worker.start(1_000);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(runs.recoverExpired).toHaveBeenCalledTimes(3);
    await worker.stop();
  });

  it('renews the durable lease while the Agent is still running', async () => {
    vi.useFakeTimers();
    const { worker, runs, agent } = fixture();
    let finishAgent!: (value: Awaited<ReturnType<typeof agent.runScheduled>>) => void;
    agent.runScheduled.mockImplementation(() => new Promise((resolve) => {
      finishAgent = resolve;
    }));
    const processing = worker.processOne(new Date());
    await vi.advanceTimersByTimeAsync(30_100);
    expect(runs.extendLease).toHaveBeenCalledWith(run.id, 1, 360_000);
    finishAgent({ text: 'Done', outcome: 'completed', sources: [], usage: {}, writeAttempts: [] });
    await processing;
  });

  it('aborts the Agent and sends nothing after lease ownership is lost', async () => {
    vi.useFakeTimers();
    const { worker, runs, agent, messenger } = fixture();
    runs.extendLease.mockResolvedValue(false);
    agent.runScheduled.mockImplementation((_run, _dependencies, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const processing = worker.processOne(new Date());
    await vi.advanceTimersByTimeAsync(30_100);
    await processing;
    expect(messenger.sendText).not.toHaveBeenCalled();
    expect(messenger.sendRichContent).not.toHaveBeenCalled();
    expect(runs.prepareDelivery).not.toHaveBeenCalled();
  });

  it('waits for a pending renewal and revalidates ownership before delivery', async () => {
    vi.useFakeTimers();
    const { worker, runs, agent, messenger } = fixture();
    let settleRenewal!: (value: boolean) => void;
    runs.extendLease
      .mockImplementationOnce(() => new Promise((resolve) => {
        settleRenewal = resolve;
      }))
      .mockResolvedValue(true);
    let finishAgent!: (value: Awaited<ReturnType<typeof agent.runScheduled>>) => void;
    agent.runScheduled.mockImplementation(() => new Promise((resolve) => {
      finishAgent = resolve;
    }));

    const processing = worker.processOne(new Date());
    await vi.advanceTimersByTimeAsync(30_100);
    finishAgent({ text: 'Done', outcome: 'completed', sources: [], usage: {}, writeAttempts: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(messenger.sendText).not.toHaveBeenCalled();
    expect(messenger.sendRichContent).not.toHaveBeenCalled();
    settleRenewal(true);
    await processing;
    expect(runs.extendLease).toHaveBeenLastCalledWith(run.id, 1, 900_000);
    expect(runs.extendLease).toHaveBeenCalledBefore(runs.prepareDelivery);
    expect(messenger.sendRichContent).toHaveBeenCalledOnce();
  });

  it('includes authenticated Sources in a rich Scheduled result', async () => {
    const { worker, agent, messenger } = fixture();
    agent.runScheduled.mockResolvedValue({
      text: '**Done**', outcome: 'completed', usage: {}, writeAttempts: [],
      sources: [{ id: 1, title: 'Plan', url: 'https://example.com/plan' }],
    });

    await worker.processOne(new Date());

    expect(messenger.sendRichContent).toHaveBeenCalledWith(
      'oc_target',
      '**Done**\n\nSources:\n[1] Plan — https://example.com/plan',
      `s:${run.id}:result`,
    );
  });

  it('keeps a fixed Scheduled Agent failure on the plain Control Reply path', async () => {
    const { worker, agent, messenger } = fixture();
    agent.runScheduled.mockRejectedValue(new Error('provider secret'));

    await worker.processOne(new Date());

    expect(messenger.sendText).toHaveBeenCalledWith(
      'oc_target',
      '定时任务“Daily”执行失败：scheduled_run_failed',
      `s:${run.id}:result`,
    );
    expect(messenger.sendRichContent).not.toHaveBeenCalled();
    expect(JSON.stringify(messenger.sendText.mock.calls)).not.toContain('provider secret');
  });

  it('keeps a returned execution-budget receipt on the rich result path', async () => {
    const { worker, agent, messenger } = fixture();
    agent.runScheduled.mockResolvedValue({
      text: '已达到本次执行时间上限。', outcome: 'timeout_reached',
      sources: [], usage: {}, writeAttempts: [],
    });

    await worker.processOne(new Date());

    expect(messenger.sendRichContent).toHaveBeenCalledOnce();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

});
