import { CronDate, CronExpressionParser } from 'cron-parser';

import type {
  CalendarCalculator,
  CalendarSchedule,
  CalendarScheduleInput,
} from './types.js';

const LOCAL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const BASIC_CRON_FIELD = /^[0-9*,/-]+$/;

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function fail(category: string): never {
  throw new Error(category);
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    fail('calendar_timezone_invalid');
  }
}

function wallParts(date: Date, timezone: string): WallParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function parseLocalTimestamp(value: string, timezone: string): Date {
  const match = LOCAL_TIMESTAMP.exec(value);
  if (!match) fail('calendar_once_invalid');

  const expected: WallParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };

  let date: Date;
  try {
    date = new CronDate(value, timezone).toDate();
  } catch {
    fail('calendar_once_invalid');
  }
  if (
    !Number.isFinite(date.getTime()) ||
    Object.entries(expected).some(
      ([key, expectedValue]) => wallParts(date, timezone)[key as keyof WallParts] !== expectedValue,
    )
  ) {
    fail('calendar_local_time_nonexistent');
  }
  return date;
}

function parseOnce(value: string, timezone: string): Date {
  if (OFFSET_TIMESTAMP.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) fail('calendar_once_invalid');
    return date;
  }
  return parseLocalTimestamp(value, timezone);
}

function normalizeCron(expression: string, timezone: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !BASIC_CRON_FIELD.test(field))) {
    fail('calendar_cron_invalid');
  }
  const normalized = fields.join(' ');
  try {
    return CronExpressionParser.parse(normalized, { tz: timezone }).stringify(false);
  } catch {
    fail('calendar_cron_invalid');
  }
}

function nextCron(schedule: Extract<CalendarSchedule, { kind: 'cron' }>, after: Date): Date {
  const iterator = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  });
  for (let skipped = 0; skipped < 8; skipped += 1) {
    const cronDate = iterator.next();
    if (iterator.includesDate(cronDate)) return cronDate.toDate();
  }
  return fail('calendar_occurrence_unavailable');
}

function latestCronAtOrBefore(
  schedule: Extract<CalendarSchedule, { kind: 'cron' }>,
  after: Date,
  through: Date,
): Date | undefined {
  const iterator = CronExpressionParser.parse(schedule.expression, {
    currentDate: new Date(through.getTime() + 1_000),
    tz: schedule.timezone,
  });
  for (let skipped = 0; skipped < 8; skipped += 1) {
    const cronDate = iterator.prev();
    const candidate = cronDate.toDate();
    if (candidate <= after) return undefined;
    if (candidate <= through && iterator.includesDate(cronDate)) return candidate;
  }
  return undefined;
}

export function createCalendarCalculator(): CalendarCalculator {
  return {
    normalize(input: CalendarScheduleInput, now: Date): CalendarSchedule {
      assertValidTimezone(input.timezone);
      if (input.kind === 'once') {
        const at = parseOnce(input.localTimestamp.trim(), input.timezone);
        if (at <= now) fail('calendar_once_not_future');
        return { kind: 'once', at, timezone: input.timezone };
      }
      return {
        kind: 'cron',
        expression: normalizeCron(input.expression, input.timezone),
        timezone: input.timezone,
      };
    },

    next(schedule: CalendarSchedule, after: Date): Date | undefined {
      assertValidTimezone(schedule.timezone);
      if (schedule.kind === 'once') return schedule.at > after ? new Date(schedule.at) : undefined;
      return nextCron(schedule, after);
    },

    latestAtOrBefore(
      schedule: CalendarSchedule,
      after: Date,
      through: Date,
    ): Date | undefined {
      if (through <= after) return undefined;
      if (schedule.kind === 'once') {
        return schedule.at > after && schedule.at <= through ? new Date(schedule.at) : undefined;
      }
      return latestCronAtOrBefore(schedule, after, through);
    },
  };
}
