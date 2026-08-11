import { describe, expect, it } from 'vitest';

import { createCalendarCalculator } from '../../src/schedule/calendar.js';

const calendar = createCalendarCalculator();
const now = new Date('2026-08-10T00:00:00.000Z');

describe('CalendarCalculator', () => {
  it('normalizes an explicit UTC timestamp without changing its instant', () => {
    expect(
      calendar.normalize(
        { kind: 'once', localTimestamp: '2026-08-11T09:00:00Z', timezone: 'Asia/Shanghai' },
        now,
      ),
    ).toEqual({ kind: 'once', at: new Date('2026-08-11T09:00:00Z'), timezone: 'Asia/Shanghai' });
  });

  it('interprets a local timestamp in its IANA timezone', () => {
    expect(
      calendar.normalize(
        { kind: 'once', localTimestamp: '2026-08-11T09:00:00', timezone: 'Asia/Shanghai' },
        now,
      ),
    ).toEqual({ kind: 'once', at: new Date('2026-08-11T01:00:00Z'), timezone: 'Asia/Shanghai' });
  });

  it('rejects invalid zones, past instants, and nonexistent local timestamps', () => {
    expect(() =>
      calendar.normalize(
        { kind: 'once', localTimestamp: '2026-08-11T09:00:00', timezone: 'Mars/Olympus' },
        now,
      ),
    ).toThrow('calendar_timezone_invalid');
    expect(() =>
      calendar.normalize(
        { kind: 'once', localTimestamp: '2026-08-09T09:00:00Z', timezone: 'UTC' },
        now,
      ),
    ).toThrow('calendar_once_not_future');
    expect(() =>
      calendar.normalize(
        {
          kind: 'once',
          localTimestamp: '2026-03-08T02:30:00',
          timezone: 'America/Los_Angeles',
        },
        new Date('2026-03-01T00:00:00Z'),
      ),
    ).toThrow('calendar_local_time_nonexistent');
  });

  it('accepts and normalizes only basic five-field cron expressions', () => {
    expect(
      calendar.normalize(
        { kind: 'cron', expression: '  */15   9-17  * * 1-5 ', timezone: 'Asia/Shanghai' },
        now,
      ),
    ).toEqual({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timezone: 'Asia/Shanghai' });

    for (const expression of [
      '0 */15 9-17 * * 1-5',
      '@daily',
      '0 9 L * *',
      '0 9 * * MON',
      '0 9 * * 1#2',
      '0 9 * * *; 0 10 * * *',
      '61 9 * * *',
    ]) {
      expect(() =>
        calendar.normalize({ kind: 'cron', expression, timezone: 'UTC' }, now),
      ).toThrow('calendar_cron_invalid');
    }
  });

  it('calculates next and latest missed occurrences from the original calendar', () => {
    const schedule = { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' } as const;

    expect(calendar.next(schedule, new Date('2026-08-10T01:01:00Z'))).toEqual(
      new Date('2026-08-11T01:00:00Z'),
    );
    expect(
      calendar.latestAtOrBefore(
        schedule,
        new Date('2026-08-10T01:01:00Z'),
        new Date('2026-08-13T02:00:00Z'),
      ),
    ).toEqual(new Date('2026-08-13T01:00:00Z'));
  });

  it('handles one-time occurrence boundaries', () => {
    const schedule = {
      kind: 'once',
      at: new Date('2026-08-11T01:00:00Z'),
      timezone: 'Asia/Shanghai',
    } as const;

    expect(calendar.next(schedule, new Date('2026-08-11T00:59:59Z'))).toEqual(schedule.at);
    expect(calendar.next(schedule, schedule.at)).toBeUndefined();
    expect(
      calendar.latestAtOrBefore(
        schedule,
        new Date('2026-08-10T00:00:00Z'),
        new Date('2026-08-11T01:00:00Z'),
      ),
    ).toEqual(schedule.at);
  });

  it('skips a nonexistent recurring wall time during spring-forward', () => {
    expect(
      calendar.next(
        { kind: 'cron', expression: '30 2 * * *', timezone: 'America/Los_Angeles' },
        new Date('2026-03-08T09:00:00Z'),
      ),
    ).toEqual(new Date('2026-03-09T09:30:00Z'));
  });

  it('emits a repeated fall-back wall time only at its first instant', () => {
    const schedule = {
      kind: 'cron',
      expression: '30 1 * * *',
      timezone: 'America/Los_Angeles',
    } as const;

    expect(calendar.next(schedule, new Date('2026-11-01T07:00:00Z'))).toEqual(
      new Date('2026-11-01T08:30:00Z'),
    );
    expect(calendar.next(schedule, new Date('2026-11-01T08:30:00Z'))).toEqual(
      new Date('2026-11-02T09:30:00Z'),
    );
  });
});
