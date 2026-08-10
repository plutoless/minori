export type CalendarSchedule =
  | { kind: 'once'; at: Date; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string };

export type CalendarScheduleInput =
  | { kind: 'once'; localTimestamp: string; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string };

export interface CalendarCalculator {
  normalize(input: CalendarScheduleInput, now: Date): CalendarSchedule;
  next(schedule: CalendarSchedule, after: Date): Date | undefined;
  latestAtOrBefore(
    schedule: CalendarSchedule,
    after: Date,
    through: Date,
  ): Date | undefined;
}

export type ScheduleState = 'active' | 'paused' | 'in_flight' | 'completed' | 'deleted';
export type ScheduledRunStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'delivery_uncertain';

export type ScheduleTarget = {
  chatId: string;
  displayName: string;
  chatType: 'group' | 'p2p';
};

export type ScheduledContext = { chatId: string; displayName: string };

export type ScheduledTask = {
  id: string;
  name: string;
  creatorOpenId: string;
  origin: ScheduleTarget;
  instruction?: string;
  version: number;
  schedule: CalendarSchedule;
  resultTarget: ScheduleTarget;
  scheduledContext?: ScheduledContext;
  state: ScheduleState;
  nameReserved: boolean;
  nextDueAt?: Date;
  latestMissedAt?: Date;
  latestRunStatus?: ScheduledRunStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type FrozenScheduledInvocation = {
  taskVersion: number;
  instruction: string;
  scheduledFor: Date;
  resultTarget: ScheduleTarget;
  scheduledContext?: ScheduledContext;
};

export type ScheduledRun = FrozenScheduledInvocation & {
  id: string;
  scheduleId: string;
  status: ScheduledRunStatus;
  claimAttempt: number;
  leasedUntil?: Date;
  writeStartedAt?: Date;
  outcomeCategory?: string;
  createdAt: Date;
  updatedAt: Date;
};
