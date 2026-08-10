import { describe, expect, it, vi } from 'vitest';

import { createAdmissionCoordinator } from '../../src/worker/admission-coordinator.js';

describe('AdmissionCoordinator', () => {
  it('attempts messages before scheduled work and admits at most one schedule', async () => {
    const order: string[] = [];
    let releaseMessage!: () => void;
    const messageDone = new Promise<void>((resolve) => { releaseMessage = resolve; });
    let releaseSchedule!: () => void;
    const scheduleDone = new Promise<void>((resolve) => { releaseSchedule = resolve; });
    const message = { processNext: vi.fn()
      .mockImplementationOnce(async () => { order.push('message'); await messageDone; return true; })
      .mockImplementation(async () => false) };
    const scheduled = { processOne: vi.fn().mockImplementation(async () => {
      order.push('scheduled');
      await scheduleDone;
      return true;
    }) };
    const coordinator = createAdmissionCoordinator({ message, scheduled, concurrency: 2, pollMs: 5 });
    await coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order[0]).toBe('message');
    expect(scheduled.processOne.mock.calls.length).toBeLessThanOrEqual(1);
    releaseMessage();
    releaseSchedule();
    await coordinator.stop();
  });

  it('does not preempt a processing scheduled run when a message arrives', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scheduled = { processOne: vi.fn().mockImplementation(async () => {
      await blocked;
      return true;
    }) };
    const message = { processNext: vi.fn().mockResolvedValue(false) };
    const coordinator = createAdmissionCoordinator({ message, scheduled, concurrency: 1, pollMs: 5 });
    await coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    coordinator.wake();
    expect(scheduled.processOne).toHaveBeenCalledOnce();
    release();
    await coordinator.stop();
  });
});
