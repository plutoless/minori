import type { CalendarCalculator, ScheduledTask } from './types.js';
import type { PostgresScheduleStore } from '../storage/schedule-store.js';
import type { PostgresScheduledRunStore } from '../storage/scheduled-run-store.js';

export interface ScheduleDispatcher {
  poll(now: Date): Promise<{ created: number; folded: number }>;
  start(): void;
  stop(): void;
  status(): 'ok' | 'degraded' | 'disabled';
}

export type ScheduleDispatcherDependencies = {
  store: Pick<PostgresScheduleStore, 'listDispatchable'>;
  runs: Pick<PostgresScheduledRunStore, 'createDue'>;
  calendar: CalendarCalculator;
  enabled: boolean;
  pollMs: number;
  now?: () => Date;
};

function dueOccurrence(
  task: ScheduledTask,
  now: Date,
  calendar: CalendarCalculator,
) {
  if (!task.nextDueAt) return undefined;
  if (task.latestMissedAt && task.nextDueAt > now) {
    return { scheduledFor: task.latestMissedAt, nextDueAt: task.nextDueAt, folded: true };
  }
  if (task.nextDueAt > now) return undefined;
  if (task.schedule.kind === 'once') {
    return { scheduledFor: task.nextDueAt, nextDueAt: undefined, folded: false };
  }
  const latest = calendar.latestAtOrBefore(
    task.schedule,
    new Date(task.nextDueAt.getTime() - 1),
    now,
  ) ?? task.nextDueAt;
  return {
    scheduledFor: latest,
    nextDueAt: calendar.next(task.schedule, now),
    folded: latest.getTime() !== task.nextDueAt.getTime(),
  };
}

export function createScheduleDispatcher(
  dependencies: ScheduleDispatcherDependencies,
): ScheduleDispatcher {
  let health: 'ok' | 'degraded' | 'disabled' = dependencies.enabled ? 'ok' : 'disabled';
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<unknown> | undefined;

  const poll = async (now: Date) => {
    if (!dependencies.enabled) return { created: 0, folded: 0 };
    try {
      let created = 0;
      let folded = 0;
      for (const task of await dependencies.store.listDispatchable(now)) {
        const due = dueOccurrence(task, now, dependencies.calendar);
        if (!due) continue;
        const result = await dependencies.runs.createDue({
          scheduleId: task.id,
          expectedDueAt: task.nextDueAt!,
          scheduledFor: due.scheduledFor,
          ...(due.nextDueAt ? { nextDueAt: due.nextDueAt } : {}),
        });
        if (result.status === 'created') created += 1;
        if (due.folded || result.status === 'active_run') folded += 1;
      }
      health = 'ok';
      return { created, folded };
    } catch {
      health = 'degraded';
      throw new Error('schedule_dispatch_failed');
    }
  };

  return {
    poll,
    start() {
      if (!dependencies.enabled || timer) return;
      const tick = () => {
        polling = poll(dependencies.now?.() ?? new Date()).catch(() => undefined);
      };
      tick();
      timer = setInterval(tick, dependencies.pollMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      polling = undefined;
    },
    status: () => health,
  };
}
