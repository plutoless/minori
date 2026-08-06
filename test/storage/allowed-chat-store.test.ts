import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAllowedChatStore } from '../../src/storage/allowed-chat-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { allowedChats } from '../../src/storage/schema.js';

describe('PostgresAllowedChatStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresAllowedChatStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresAllowedChatStore(database.db);
  });

  beforeEach(async () => {
    await database.pool.query('truncate table allowed_chats');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('allows only explicitly enabled Feishu group entry points', async () => {
    await database.db.insert(allowedChats).values([
      { chatId: 'oc_enabled', enabled: true },
      { chatId: 'oc_disabled', enabled: false },
    ]);

    expect(await store.isAllowed('oc_enabled')).toBe(true);
    expect(await store.isAllowed('oc_disabled')).toBe(false);
    expect(await store.isAllowed('oc_missing')).toBe(false);
  });
});
