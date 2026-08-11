import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresTeamContextStore } from '../../src/storage/team-context-store.js';

describe('PostgresTeamContextStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresTeamContextStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresTeamContextStore(database.db);
  }, 180_000);

  beforeEach(async () => {
    await database.pool.query('truncate table team_context_snapshots');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('stores and replaces only the latest complete accepted revision', async () => {
    await store.accept({
      documentToken: 'dox_team',
      sourceRevision: 7,
      normalizedContent: '# Team Context\n\n- Conclusions first.\n',
      estimatedTokens: 12,
      fetchedAt: new Date('2026-08-10T12:00:00Z'),
    });
    await store.accept({
      documentToken: 'dox_team',
      sourceRevision: 8,
      normalizedContent: '# Team Context\n\n- Sources after conclusions.\n',
      estimatedTokens: 14,
      fetchedAt: new Date('2026-08-10T13:00:00Z'),
    });

    await expect(store.load('dox_team')).resolves.toEqual({
      documentToken: 'dox_team',
      sourceRevision: 8,
      normalizedContent: '# Team Context\n\n- Sources after conclusions.\n',
      estimatedTokens: 14,
      fetchedAt: new Date('2026-08-10T13:00:00Z'),
    });
    await expect(store.accept({
      documentToken: 'dox_team',
      sourceRevision: 6,
      normalizedContent: 'older content',
      estimatedTokens: 3,
      fetchedAt: new Date('2026-08-10T14:00:00Z'),
    })).rejects.toThrow('team_context_snapshot_stale');
  });

  it('keeps document tokens isolated and accepts an idempotent revision refresh', async () => {
    const snapshot = {
      documentToken: 'dox_a',
      sourceRevision: 2,
      normalizedContent: '# A\n',
      estimatedTokens: 2,
      fetchedAt: new Date('2026-08-10T12:00:00Z'),
    };
    await store.accept(snapshot);
    await store.accept({ ...snapshot, fetchedAt: new Date('2026-08-10T12:01:00Z') });

    expect((await store.load('dox_a'))?.fetchedAt).toEqual(new Date('2026-08-10T12:01:00Z'));
    await expect(store.load('dox_b')).resolves.toBeUndefined();
  });

  it('invalidates the accepted body immediately while retaining only a stable category', async () => {
    await store.accept({
      documentToken: 'dox_team',
      sourceRevision: 7,
      normalizedContent: '# Team Context\n\nprivate body\n',
      estimatedTokens: 6,
      fetchedAt: new Date('2026-08-10T12:00:00Z'),
    });

    await store.invalidate('dox_team', 'team_context_forbidden');

    await expect(store.load('dox_team')).resolves.toBeUndefined();
    const result = await database.pool.query('select * from team_context_snapshots');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      document_token: 'dox_team',
      source_revision: null,
      normalized_content: null,
      estimated_tokens: null,
      fetched_at: null,
      invalidation_category: 'team_context_forbidden',
    });
    expect(JSON.stringify(result.rows[0])).not.toMatch(/private body|oauth|provider error/iu);
  });
});
