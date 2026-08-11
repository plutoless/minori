import type { AgentInvocationRunner, ScheduledInvocationDependencies } from '../agent/invocation-runner.js';
import type { ScheduledResultMessenger } from '../feishu/client.js';
import type { PostgresScheduleStore } from '../storage/schedule-store.js';
import type { PostgresScheduledRunStore } from '../storage/scheduled-run-store.js';
import { deliverScheduledText, scheduledFailureNotice } from './delivery.js';

const DELIVERY_LEASE_MS = 900_000;

export type ScheduledTaskWorkerDependencies = {
  runs: Pick<PostgresScheduledRunStore,
    | 'claimNext' | 'extendLease' | 'prepareDelivery' | 'markDelivered' | 'beginFallback'
    | 'finishFallback' | 'finish' | 'recoverExpired'>;
  schedules: Pick<PostgresScheduleStore, 'get'>;
  agent: AgentInvocationRunner;
  agentDependencies: ScheduledInvocationDependencies;
  messenger: ScheduledResultMessenger;
  leaseMs: number;
};

export interface ScheduledTaskWorker {
  processOne(now: Date): Promise<boolean>;
  recover(now: Date): Promise<number>;
  start(recoveryIntervalMs: number): void;
  stop(): Promise<void>;
}

function deliveryCategory(error: unknown) {
  return error instanceof Error && error.message === 'scheduled_delivery_rejected'
    ? 'scheduled_delivery_rejected'
    : 'delivery_uncertain';
}

export function createScheduledTaskWorker(
  dependencies: ScheduledTaskWorkerDependencies,
): ScheduledTaskWorker {
  let recoveryTimer: NodeJS.Timeout | undefined;
  let recovery: Promise<unknown> | undefined;
  return {
    async processOne(now) {
      const run = await dependencies.runs.claimNext(now, dependencies.leaseMs);
      if (!run) return false;
      const leaseController = new AbortController();
      let leaseRenewal: Promise<unknown> | undefined;
      const renewLease = () => {
        if (leaseRenewal) return;
        leaseRenewal = dependencies.runs.extendLease(
          run.id,
          run.claimAttempt,
          dependencies.leaseMs,
        ).then((extended) => {
          if (!extended) leaseController.abort('scheduled_run_lease_unavailable');
        }).catch(() => {
          leaseController.abort('scheduled_run_lease_unavailable');
        }).finally(() => {
          leaseRenewal = undefined;
        });
      };
      const heartbeat = setInterval(
        renewLease,
        Math.max(1_000, Math.min(30_000, Math.floor(dependencies.leaseMs / 3))),
      );
      heartbeat.unref?.();
      try {
        const task = await dependencies.schedules.get(run.scheduleId);
        if (!task) {
          await dependencies.runs.finish(
            run.id,
            run.claimAttempt,
            'failed',
            'scheduled_task_missing',
          );
          return true;
        }
        if (leaseController.signal.aborted) return true;

        let text: string;
        let runOutcome: 'completed' | 'failed' = 'completed';
        try {
          const reply = await dependencies.agent.runScheduled(
            run,
            dependencies.agentDependencies,
            leaseController.signal,
          );
          text = reply.text;
          if (reply.outcome !== 'completed') runOutcome = 'failed';
        } catch {
          if (leaseController.signal.aborted) return true;
          text = `定时任务“${task.name}”执行失败：scheduled_run_failed`;
          runOutcome = 'failed';
        }
        if (leaseController.signal.aborted) return true;

        clearInterval(heartbeat);
        await leaseRenewal;
        if (leaseController.signal.aborted) return true;
        try {
          const deliveryOwned = await dependencies.runs.extendLease(
            run.id,
            run.claimAttempt,
            Math.max(dependencies.leaseMs, DELIVERY_LEASE_MS),
          );
          if (!deliveryOwned) return true;
        } catch {
          return true;
        }

        try {
          const messageId = await deliverScheduledText(
            dependencies.messenger,
            run.resultTarget.chatId,
            text,
            await dependencies.runs.prepareDelivery(run.id, run.claimAttempt, text),
          );
          await dependencies.runs.markDelivered(run.id, run.claimAttempt, messageId);
          await dependencies.runs.finish(
            run.id,
            run.claimAttempt,
            runOutcome,
            runOutcome === 'failed' ? 'scheduled_run_failed' : undefined,
          );
        } catch (error) {
          const category = deliveryCategory(error);
          try {
            const fallbackKey = await dependencies.runs.beginFallback(run.id, run.claimAttempt);
            const messageId = await deliverScheduledText(
              dependencies.messenger,
              task.origin.chatId,
              scheduledFailureNotice(task, run, category),
              fallbackKey,
            );
            await dependencies.runs.finishFallback(run.id, messageId);
          } catch {
            await dependencies.runs.finishFallback(run.id, undefined, 'schedule_origin_delivery_failed');
          }
          await dependencies.runs.finish(
            run.id,
            run.claimAttempt,
            category === 'delivery_uncertain' ? 'delivery_uncertain' : 'failed',
            category,
          );
        }
        return true;
      } finally {
        clearInterval(heartbeat);
        await leaseRenewal;
      }
    },

    recover(now) {
      return dependencies.runs.recoverExpired(now);
    },
    start(recoveryIntervalMs) {
      if (recoveryTimer) return;
      const tick = () => {
        if (recovery) return;
        recovery = dependencies.runs.recoverExpired(new Date())
          .catch(() => undefined)
          .finally(() => {
            recovery = undefined;
          });
      };
      tick();
      recoveryTimer = setInterval(tick, recoveryIntervalMs);
      recoveryTimer.unref?.();
    },
    async stop() {
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = undefined;
      await recovery;
      recovery = undefined;
    },
  };
}
