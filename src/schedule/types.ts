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
