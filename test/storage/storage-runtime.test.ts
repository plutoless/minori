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
    expect(runtime.retentionStatus()).toBe('degraded');

    await runtime.start();

    expect(await runtime.databaseStatus()).toBe('ok');
    expect(runtime.retentionStatus()).toBe('ok');

    await runtime.stop();
    expect(await runtime.databaseStatus()).toBe('degraded');
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

    await runtime.stop();
  });
});
