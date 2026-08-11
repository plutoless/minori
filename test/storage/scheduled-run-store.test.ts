import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
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
  }, 180_000);

  beforeEach(async () => {
    await database.pool.query(
      'truncate processed_events, scheduled_runs, scheduled_task_revisions, scheduled_tasks cascade',
    );
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
    await expect(schedules.update(task.id, 1, 'ou_editor', {
      instruction: 'New future instruction',
    })).resolves.toMatchObject({
      status: 'updated', queuedOldVersion: { taskVersion: 1 },
    });

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

  it('claims at most one scheduled run across concurrent store instances', async () => {
    const firstTask = await createTask();
    const second = await schedules.create({
      name: 'Weekly brief', creatorOpenId: 'ou_creator', actorOpenId: 'ou_creator',
      origin: { chatId: 'oc_origin', displayName: 'Origin', chatType: 'p2p' },
      instruction: 'Second instruction',
      schedule: { kind: 'cron', expression: '0 10 * * *', timezone: 'Asia/Shanghai' },
      resultTarget: { chatId: 'oc_other', displayName: 'Other', chatType: 'group' },
      nextDueAt: new Date('2026-08-11T02:00:00Z'),
    });
    if (second.status !== 'created') throw new Error('fixture_not_created');
    await runs.createDue({
      scheduleId: firstTask.id, expectedDueAt: firstTask.nextDueAt!, scheduledFor: firstTask.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    await runs.createDue({
      scheduleId: second.task.id, expectedDueAt: second.task.nextDueAt!, scheduledFor: second.task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T02:00:00Z'),
    });
    const other = new PostgresScheduledRunStore(database.db);
    const claimed = await Promise.all([
      runs.claimNext(new Date(), 60_000), other.claimNext(new Date(), 60_000),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it('serializes a message and scheduled run targeting the same conversation', async () => {
    const task = await createTask();
    await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    const events = new PostgresEventStore(database.db);
    await events.enqueue({
      eventId: 'evt_same_target', messageId: 'om_same_target', chatId: 'oc_target',
      conversationKey: 'oc_target', senderOpenId: 'ou_member', chatType: 'group',
      content: { kind: 'text', text: 'hello', feishuLinks: [] }, occurredAt: new Date(),
    });

    const [scheduled, messages] = await Promise.all([
      runs.claimNext(new Date(), 60_000),
      events.claimReady(1, new Date(Date.now() + 60_000)),
    ]);
    expect(Number(Boolean(scheduled)) + messages.length).toBe(1);
  });

  it('does not exceed global capacity or overtake a ready message', async () => {
    const task = await createTask();
    await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    const events = new PostgresEventStore(database.db);
    for (let index = 0; index < 4; index += 1) {
      await events.enqueue({
        eventId: `evt_${index}`, messageId: `om_${index}`, chatId: `oc_${index}`,
        conversationKey: `oc_${index}`, senderOpenId: 'ou_member', chatType: 'group',
        content: { kind: 'text', text: 'hello', feishuLinks: [] }, occurredAt: new Date(),
      });
    }
    expect(await events.claimReady(4, new Date(Date.now() + 60_000))).toHaveLength(4);
    await expect(runs.claimNext(new Date(), 60_000)).resolves.toBeUndefined();

    await database.pool.query("update processed_events set status = 'completed'");
    await events.enqueue({
      eventId: 'evt_ready', messageId: 'om_ready', chatId: 'oc_ready',
      conversationKey: 'oc_ready', senderOpenId: 'ou_member', chatType: 'group',
      content: { kind: 'text', text: 'hello', feishuLinks: [] }, occurredAt: new Date(),
    });
    await expect(runs.claimNext(new Date(), 60_000)).resolves.toBeUndefined();
    await expect(events.claimReady(1, new Date(Date.now() + 60_000)))
      .resolves.toHaveLength(1);
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

  it('never renews an already expired claim', async () => {
    const task = await createTask();
    const due = await runs.createDue({
      scheduleId: task.id, expectedDueAt: task.nextDueAt!, scheduledFor: task.nextDueAt!,
      nextDueAt: new Date('2026-08-12T01:00:00Z'),
    });
    if (due.status !== 'created') throw new Error('run_not_created');
    const claimed = await runs.claim(due.run.id, new Date(), 60_000);
    if (!claimed) throw new Error('run_not_claimed');
    await database.pool.query(
      "update scheduled_runs set leased_until = clock_timestamp() - interval '1 second' where id = $1",
      [due.run.id],
    );
    await expect(runs.extendLease(due.run.id, claimed.claimAttempt, 60_000)).resolves.toBe(false);
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
