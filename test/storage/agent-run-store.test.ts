import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import { PostgresAgentRunStore } from '../../src/storage/agent-run-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { agentRuns, processedEvents, toolRuns } from '../../src/storage/schema.js';

describe('PostgresAgentRunStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresAgentRunStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresAgentRunStore(database.db);
  }, 60_000);

  beforeEach(async () => {
    await database.pool.query('truncate table processed_events cascade');
    const payload: NormalizedMessage = {
      eventId: 'evt_1',
      messageId: 'om_1',
      chatId: 'oc_1',
      conversationKey: 'oc_1:om_root',
      senderOpenId: 'ou_1',
      chatType: 'group',
      content: { kind: 'text', text: 'hello', feishuLinks: [] },
      occurredAt: new Date('2026-08-05T00:00:00Z'),
    };
    await database.db.insert(processedEvents).values({
      eventId: payload.eventId,
      messageId: payload.messageId,
      payload,
      conversationKey: payload.conversationKey,
      status: 'processing',
    });
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('persists a completed write audit without document or credential content', async () => {
    const run = await store.start({ eventId: 'evt_1', model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'patchDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'replaced one exact text range',
    });
    await store.finishWrite(write.id, { success: true });
    await store.finish(run.id, {
      inputTokens: 120,
      outputTokens: 45,
      toolCallCount: 3,
      outcome: 'completed',
    });

    const [runRow] = await database.db.select().from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    const [writeRow] = await database.db.select().from(toolRuns)
      .where(eq(toolRuns.id, write.id));

    expect(runRow).toMatchObject({
      id: run.id,
      eventId: 'evt_1',
      model: '5.6-terra',
      inputTokens: 120,
      outputTokens: 45,
      toolCallCount: 3,
      outcome: 'completed',
    });
    expect(runRow?.startedAt).toBeInstanceOf(Date);
    expect(runRow?.finishedAt).toBeInstanceOf(Date);
    expect(writeRow).toMatchObject({
      id: write.id,
      agentRunId: run.id,
      toolName: 'patchDocument',
      targetIdentifiers: { doc: 'dox_1' },
      success: true,
      errorCategory: null,
      sanitizedSummary: 'replaced one exact text range',
    });
    expect(writeRow?.startedAt).toBeInstanceOf(Date);
    expect(writeRow?.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(writeRow)).not.toMatch(
      /document body|replacement text|oauth|prompt|model output/iu,
    );
  });

  it('persists a stable failure category for a conflicted write', async () => {
    const run = await store.start({ eventId: 'evt_1', model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'patchDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'replaced one exact text range',
    });

    await store.finishWrite(write.id, {
      success: false,
      errorCategory: 'knowledge_write_conflict',
    });
    await store.finish(run.id, { toolCallCount: 1, outcome: 'failed' });

    const [writeRow] = await database.db.select().from(toolRuns)
      .where(eq(toolRuns.id, write.id));
    expect(writeRow).toMatchObject({
      agentRunId: run.id,
      success: false,
      errorCategory: 'knowledge_write_conflict',
    });
  });

  it.each(['step_limit_reached', 'timeout_reached'] as const)(
    'persists the explicit %s run outcome',
    async (outcome) => {
      const run = await store.start({ eventId: 'evt_1', model: '5.6-terra' });

      await store.finish(run.id, { toolCallCount: 1, outcome });

      const [runRow] = await database.db.select().from(agentRuns)
        .where(eq(agentRuns.id, run.id));
      expect(runRow?.outcome).toBe(outcome);
    },
  );
});
