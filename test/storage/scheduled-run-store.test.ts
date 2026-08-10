import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresScheduleStore } from '../../src/storage/schedule-store.js';
import { PostgresScheduledRunStore } from '../../src/storage/scheduled-run-store.js';

describe('PostgresScheduledRunStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let schedules: PostgresScheduleStore;
  let runs: PostgresScheduledRunStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    schedules = new PostgresScheduleStore(database.db);
    runs = new PostgresScheduledRunStore(database.db);
  }, 60_000);

  beforeEach(async () => {
    await database.pool.query('truncate scheduled_runs, scheduled_task_revisions, scheduled_tasks cascade');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  async function createTask(kind: 'once' | 'cron' = 'cron') {
    const result = await schedules.create({
      name: 'Daily brief', creatorOpenId: 'ou_creator', actorOpenId: 'ou_creator',
      origin: { chatId: 'oc_origin', displayName: 'Origin', chatType: 'p2p' },
      instruction: 'Original frozen instruction',
      schedule: kind === 'cron'
        ? { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' }
        : { kind: 'once', at: new Date('2026-08-11T01:00:00Z'), timezone: 'Asia/Shanghai' },
      resultTarget: { chatId: 'oc_target', displayName: 'Product', chatType: 'group' },
      nextDueAt: new Date('2026-08-11T01:00:00Z'),
    });
    if (result.status !== 'created') throw new Error('fixture_not_created');
    return result.task;
  }

  it('atomically creates one frozen run and advances a recurring task once', async () => {
    const task = await createTask();
    const request = {
      scheduleId: task.id,
      expectedDueAt: new Date('2026-08-11T01:00:00Z'),
      scheduledFor: new Date('2026-08-11T01:00:00Z'),
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    };

    const [a, b] = await Promise.all([runs.createDue(request), runs.createDue(request)]);
    expect([a.status, b.status].sort()).toEqual(['created', 'not_due']);
    const created = a.status === 'created' ? a.run : b.status === 'created' ? b.run : undefined;
    expect(created).toMatchObject({
      taskVersion: 1,
      instruction: 'Original frozen instruction',
      scheduledFor: request.scheduledFor,
      resultTarget: task.resultTarget,
    });
    expect((await schedules.get(task.id))?.nextDueAt).toEqual(request.nextDueAt);
  });

  it('prevents overlap and keeps the queued snapshot immutable across task updates', async () => {
    const task = await createTask();
    const first = await runs.createDue({
      scheduleId: task.id,
      expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    if (first.status !== 'created') throw new Error('run_not_created');
    await schedules.update(task.id, 1, 'ou_editor', { instruction: 'New future instruction' });

    await expect(runs.createDue({
      scheduleId: task.id,
      expectedDueAt: new Date('2026-08-12T01:00:00Z'),
      scheduledFor: new Date('2026-08-12T01:00:00Z'),
      nextDueAt: new Date('2026-08-13T01:00:00Z'),
    })).resolves.toMatchObject({ status: 'active_run' });
    expect(await runs.get(first.run.id)).toMatchObject({
      taskVersion: 1, instruction: 'Original frozen instruction', status: 'queued',
    });
  });

  it('moves a one-time task in flight and completes it terminally after processing', async () => {
    const task = await createTask('once');
    const due = await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
    });
    if (due.status !== 'created') throw new Error('run_not_created');
    expect(await schedules.get(task.id)).toMatchObject({ state: 'in_flight', nameReserved: true });

    const claimed = await runs.claim(due.run.id, new Date('2026-08-11T01:00:00Z'), 60_000);
    expect(claimed).toMatchObject({ status: 'processing', claimAttempt: 1 });
    await runs.finish(due.run.id, 1, 'completed');
    expect(await schedules.get(task.id)).toMatchObject({ state: 'completed', nameReserved: false });
  });

  it('cancels only queued runs and never mutates a processing snapshot', async () => {
    const task = await createTask();
    const due = await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    if (due.status !== 'created') throw new Error('run_not_created');
    await runs.claim(due.run.id, new Date('2026-08-11T01:00:00Z'), 60_000);
    await expect(runs.cancelQueuedForTask(task.id)).resolves.toBe(false);
    expect(await runs.get(due.run.id)).toMatchObject({ status: 'processing' });
  });

  it('rebinds the same never-started one-time run after pause, edit, and resume', async () => {
    const task = await createTask('once');
    const due = await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
    });
    if (due.status !== 'created') throw new Error('run_not_created');
    await schedules.pause(task.id, 1, 'ou_editor');
    await schedules.update(task.id, 2, 'ou_editor', { instruction: 'Updated frozen instruction' });
    const resumed = await schedules.resume(
      task.id, 3, 'ou_editor', new Date('2026-08-11T01:00:00Z'),
    );
    expect(resumed).toMatchObject({ status: 'updated', task: { state: 'in_flight', version: 4 } });
    expect(await runs.get(due.run.id)).toMatchObject({
      id: due.run.id, status: 'queued', taskVersion: 4,
      instruction: 'Updated frozen instruction', scheduledFor: task.nextDueAt,
    });
    const rows = await database.pool.query(
      'select id from scheduled_runs where schedule_id = $1', [task.id],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
