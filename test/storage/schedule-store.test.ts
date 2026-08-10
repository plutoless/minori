import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresScheduleStore } from '../../src/storage/schedule-store.js';

describe('PostgresScheduleStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresScheduleStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresScheduleStore(database.db);
  }, 60_000);

  beforeEach(async () => {
    await database.pool.query('truncate scheduled_runs, scheduled_task_revisions, scheduled_tasks cascade');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  const input = (name = 'Daily brief') => ({
    name,
    creatorOpenId: 'ou_creator',
    actorOpenId: 'ou_creator',
    origin: { chatId: 'oc_origin', displayName: 'Origin', chatType: 'p2p' as const },
    instruction: 'Summarize the latest project notes.',
    schedule: { kind: 'cron' as const, expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    resultTarget: { chatId: 'oc_target', displayName: 'Product', chatType: 'group' as const },
    scheduledContext: { chatId: 'oc_context', displayName: 'Product discussion' },
    nextDueAt: new Date('2026-08-11T01:00:00Z'),
  });

  it('creates one immutable version and enforces case-insensitive reserved names', async () => {
    const created = await store.create(input());
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.task).toMatchObject({ name: 'Daily brief', version: 1, state: 'active' });

    const conflict = await store.create(input('DAILY BRIEF'));
    expect(conflict).toMatchObject({ status: 'name_conflict', task: { id: created.task.id } });

    const revisions = await database.pool.query(
      'select version, instruction, actor_open_id from scheduled_task_revisions where schedule_id = $1',
      [created.task.id],
    );
    expect(revisions.rows).toEqual([{ version: 1, instruction: input().instruction, actor_open_id: 'ou_creator' }]);
  });

  it('uses expected versions and preserves immutable creator and origin', async () => {
    const created = await store.create(input());
    if (created.status !== 'created') throw new Error('fixture_not_created');

    const updated = await store.update(created.task.id, 1, 'ou_editor', {
      instruction: 'Summarize only decisions.',
    });
    expect(updated).toMatchObject({ status: 'updated', task: { version: 2 } });

    const stale = await store.update(created.task.id, 1, 'ou_stale', { name: 'Stale name' });
    expect(stale).toMatchObject({
      status: 'version_conflict',
      task: { version: 2, creatorOpenId: 'ou_creator', origin: input().origin },
    });
  });

  it('pauses, resumes, deletes, and releases a terminal name when no run is active', async () => {
    const created = await store.create(input());
    if (created.status !== 'created') throw new Error('fixture_not_created');

    expect(await store.pause(created.task.id, 1, 'ou_editor')).toMatchObject({
      status: 'updated', task: { state: 'paused', version: 2 },
    });
    expect(
      await store.resume(created.task.id, 2, 'ou_editor', new Date('2026-08-12T01:00:00Z')),
    ).toMatchObject({ status: 'updated', task: { state: 'active', version: 3 } });
    expect(await store.delete(created.task.id, 3, 'ou_editor')).toMatchObject({
      status: 'updated', task: { state: 'deleted', nameReserved: false },
    });
    await expect(store.create(input())).resolves.toMatchObject({ status: 'created' });
  });

  it('purges terminal bodies after 30 days but retains structural audit fields', async () => {
    const created = await store.create(input());
    if (created.status !== 'created') throw new Error('fixture_not_created');
    await store.delete(created.task.id, 1, 'ou_editor');
    await database.pool.query(
      "update scheduled_tasks set deleted_at = '2026-06-01T00:00:00Z' where id = $1",
      [created.task.id],
    );

    await store.purgeTerminalBodies(new Date('2026-08-10T00:00:00Z'));

    const task = await store.get(created.task.id);
    expect(task).toMatchObject({ id: created.task.id, name: 'Daily brief', state: 'deleted' });
    expect(task?.instruction).toBeUndefined();
    const revision = await database.pool.query(
      'select instruction, body_purged_at from scheduled_task_revisions where schedule_id = $1',
      [created.task.id],
    );
    expect(revision.rows[0].instruction).toBeNull();
    expect(revision.rows[0].body_purged_at).toBeInstanceOf(Date);
  });
});
