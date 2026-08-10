import type { AgentInvocationRunner, ScheduledInvocationDependencies } from '../agent/invocation-runner.js';
import type { ScheduledResultMessenger } from '../feishu/client.js';
import type { PostgresScheduleStore } from '../storage/schedule-store.js';
import type { PostgresScheduledRunStore } from '../storage/scheduled-run-store.js';
import { deliverScheduledText, scheduledFailureNotice } from './delivery.js';

export type ScheduledTaskWorkerDependencies = {
  runs: Pick<PostgresScheduledRunStore,
    | 'claimNext' | 'prepareDelivery' | 'markDelivered' | 'beginFallback'
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
}

function deliveryCategory(error: unknown) {
  return error instanceof Error && error.message === 'scheduled_delivery_rejected'
    ? 'scheduled_delivery_rejected'
    : 'delivery_uncertain';
}

export function createScheduledTaskWorker(
  dependencies: ScheduledTaskWorkerDependencies,
): ScheduledTaskWorker {
  return {
    async processOne(now) {
      const run = await dependencies.runs.claimNext(now, dependencies.leaseMs);
      if (!run) return false;
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

      let text: string;
      let runOutcome: 'completed' | 'failed' = 'completed';
      try {
        const reply = await dependencies.agent.runScheduled(run, dependencies.agentDependencies);
        text = reply.text;
        if (reply.outcome !== 'completed') runOutcome = 'failed';
      } catch {
        text = `定时任务“${task.name}”执行失败：scheduled_run_failed`;
        runOutcome = 'failed';
      }

      const key = await dependencies.runs.prepareDelivery(run.id, run.claimAttempt, text);
      try {
        const messageId = await deliverScheduledText(
          dependencies.messenger,
          run.resultTarget.chatId,
          text,
          key,
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
    },

    recover(now) {
      return dependencies.runs.recoverExpired(now);
    },
  };
}
