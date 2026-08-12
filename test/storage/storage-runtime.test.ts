import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { createStorageRuntime } from '../../src/storage/runtime.js';

describe('createStorageRuntime', () => {
  let container: StartedPostgreSqlContainer;
  let migrationDatabase: DatabaseHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    migrationDatabase = createDatabase(container.getConnectionUri());
    await migrate(migrationDatabase.db, { migrationsFolder: resolve('drizzle') });
  });

  afterAll(async () => {
    await migrationDatabase?.close();
    await container?.stop();
  });

  it('starts the database and retention lifecycle when PostgreSQL is configured', async () => {
    const runtime = createStorageRuntime(loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      MESSAGE_RETENTION_DAYS: '14',
    }), pino({ level: 'silent' }));

    expect(runtime.eventStore).toBeDefined();
    expect(runtime.conversationStore).toBeDefined();
    expect(runtime).not.toHaveProperty('allowedChatStore');
    expect(runtime.agentRunStore).toBeDefined();
    expect(runtime.teamContextStore).toBeDefined();
    expect(runtime.scheduleStore).toBeDefined();
    expect(runtime.scheduledRunStore).toBeDefined();
    expect(runtime.retentionStatus()).toBe('degraded');

    await runtime.start();

    expect(await runtime.databaseStatus()).toBe('ok');
    expect(runtime.retentionStatus()).toBe('ok');

    await runtime.stop();
    expect(await runtime.databaseStatus()).toBe('degraded');
  });

  it('clears expired Agent Failure Details through startup retention', async () => {
    const now = Date.now();
    await migrationDatabase.pool.query(`
      insert into agent_runs (model, outcome, error_message, finished_at)
      values
        ('retention-probe-expired', 'failed', 'expired provider detail', $1),
        ('retention-probe-recent', 'failed', 'recent provider detail', $2)
    `, [
      new Date(now - 31 * 24 * 60 * 60 * 1_000),
      new Date(now - 20 * 24 * 60 * 60 * 1_000),
    ]);
    const runtime = createStorageRuntime(loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      MESSAGE_RETENTION_DAYS: '14',
    }), pino({ level: 'silent' }));

    await runtime.start();

    const retained = await migrationDatabase.pool.query<{
      outcome: string;
      errorMessage: string | null;
    }>(`
      select outcome, error_message as "errorMessage"
      from agent_runs where model like 'retention-probe-%' order by model
    `);
    expect(retained.rows).toEqual([
      { outcome: 'failed', errorMessage: null },
      { outcome: 'failed', errorMessage: 'recent provider detail' },
    ]);
    await runtime.stop();
  });

  it('is a healthy no-op when PostgreSQL is intentionally unconfigured', async () => {
    const runtime = createStorageRuntime(
      loadConfig({ NODE_ENV: 'test' }),
      pino({ level: 'silent' }),
    );

    await runtime.start();

    expect(await runtime.databaseStatus()).toBe('unconfigured');
    expect(runtime.retentionStatus()).toBe('unconfigured');
    expect(runtime.eventStore).toBeUndefined();
    expect(runtime.agentRunStore).toBeUndefined();
    expect(runtime.teamContextStore).toBeUndefined();
    expect(runtime.scheduleStore).toBeUndefined();
    expect(runtime.scheduledRunStore).toBeUndefined();

    await runtime.stop();
  });
});
