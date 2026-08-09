import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import { PostgresAgentRunStore } from '../../src/storage/agent-run-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
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
      conversationKey: 'oc_1',
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
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'patchDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'replaced one exact text range',
    });
    const [eventRow] = await database.db.select().from(processedEvents)
      .where(eq(processedEvents.eventId, 'evt_1'));
    expect(eventRow?.writeStartedAt).toBeInstanceOf(Date);

    await store.finishWrite(write.id, {
      outcome: 'succeeded',
      resultIdentifiers: {
        token: 'dox_1',
        title: 'Release plan',
        url: 'https://acme.feishu.cn/docx/dox_1',
        revisionId: '4',
      },
    });
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
      claimAttempt: 0,
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
      resultIdentifiers: {
        token: 'dox_1',
        title: 'Release plan',
        url: 'https://acme.feishu.cn/docx/dox_1',
        revisionId: '4',
      },
    });
    expect(writeRow?.startedAt).toBeInstanceOf(Date);
    expect(writeRow?.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(writeRow)).not.toMatch(
      /document body|replacement text|oauth|prompt|model output/iu,
    );
    await expect(store.listWriteAttempts('evt_1')).resolves.toEqual([{
      toolName: 'patchDocument',
      outcome: 'succeeded',
      sanitizedSummary: 'replaced one exact text range',
      targetIdentifiers: { doc: 'dox_1' },
      resultIdentifiers: {
        token: 'dox_1',
        title: 'Release plan',
        url: 'https://acme.feishu.cn/docx/dox_1',
        revisionId: '4',
      },
    }]);
  });

  it('persists and replaces only sanitized live group-history audit metadata', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    const cutoff = new Date('2026-08-08T10:00:00.000Z');

    await store.recordGroupHistory(run.id, {
      status: 'loaded',
      messageCount: 17,
      pageCallCount: 2,
      cutoff,
    });

    const [loadedRow] = await database.db.select().from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    expect(loadedRow).toMatchObject({
      groupHistoryStatus: 'loaded',
      groupHistoryMessageCount: 17,
      groupHistoryPageCount: 2,
      groupHistoryCutoff: cutoff,
      groupHistoryErrorCategory: null,
    });
    expect(Object.keys(loadedRow ?? {}).filter((key) => key.startsWith('groupHistory'))).toEqual([
      'groupHistoryStatus',
      'groupHistoryMessageCount',
      'groupHistoryPageCount',
      'groupHistoryCutoff',
      'groupHistoryErrorCategory',
    ]);
    expect(JSON.stringify(loadedRow)).not.toMatch(
      /message body|member name|open[_ ]?id|message[_ ]?id|provider token|raw error/iu,
    );

    await store.recordGroupHistory(run.id, {
      status: 'unavailable',
      messageCount: 0,
      pageCallCount: 1,
      cutoff,
      errorCategory: 'group_history_unavailable',
    });

    const [unavailableRow] = await database.db.select().from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    expect(unavailableRow).toMatchObject({
      groupHistoryStatus: 'unavailable',
      groupHistoryMessageCount: 0,
      groupHistoryPageCount: 1,
      groupHistoryCutoff: cutoff,
      groupHistoryErrorCategory: 'group_history_unavailable',
    });
    expect(JSON.stringify(unavailableRow)).not.toMatch(
      /message body|member name|open[_ ]?id|message[_ ]?id|provider token|raw error/iu,
    );
  });

  it('rejects group-history audit for a missing Agent run', async () => {
    await expect(store.recordGroupHistory('00000000-0000-0000-0000-000000000000', {
      status: 'unavailable',
      messageCount: 0,
      pageCallCount: 0,
      cutoff: new Date('2026-08-08T10:00:00.000Z'),
      errorCategory: 'group_history_unavailable',
    })).rejects.toThrow('agent_run_not_found');
  });

  it('persists a stable failure category for a conflicted write', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'patchDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'replaced one exact text range',
    });

    await store.finishWrite(write.id, {
      outcome: 'failed',
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

  it('returns an unfinished write as an unknown sanitized receipt', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    await store.beginWrite(run.id, {
      toolName: 'createDocument',
      targetIdentifiers: { parentToken: 'fldcnParent' },
      sanitizedSummary: 'created one document',
    });

    const receipts = await store.listWriteAttempts('evt_1');

    expect(receipts).toEqual([{
      toolName: 'createDocument',
      outcome: 'unknown',
      sanitizedSummary: 'created one document',
      targetIdentifiers: { parentToken: 'fldcnParent' },
    }]);
    expect(JSON.stringify(receipts)).not.toMatch(/document body|secret content|oauth/iu);
  });

  it('persists a stable category when a finished write result is unknown', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'appendDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'appended content to one document',
    });

    await store.finishWrite(write.id, { outcome: 'unknown' });

    await expect(store.listWriteAttempts('evt_1')).resolves.toEqual([{
      toolName: 'appendDocument',
      outcome: 'unknown',
      sanitizedSummary: 'appended content to one document',
      targetIdentifiers: { doc: 'dox_1' },
      errorCategory: 'write_result_unknown',
    }]);
  });

  it('rolls back the pending audit when the event cannot be marked processing', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    await database.db.update(processedEvents).set({ status: 'queued' })
      .where(eq(processedEvents.eventId, 'evt_1'));

    await expect(store.beginWrite(run.id, {
      toolName: 'appendDocument',
      targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'appended content to one document',
    })).rejects.toThrow('write_replay_boundary_not_marked');

    const rows = await database.db.select().from(toolRuns)
      .where(eq(toolRuns.agentRunId, run.id));
    expect(rows).toEqual([]);
  });

  it('fences a stale lease holder after a replacement claim is admitted', async () => {
    const events = new PostgresEventStore(database.db, {
      minRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    await database.db.update(processedEvents).set({
      status: 'queued',
      attempts: 0,
      leasedUntil: null,
      writeStartedAt: null,
    }).where(eq(processedEvents.eventId, 'evt_1'));

    const [attempt1] = await events.claimReady(1, new Date(Date.now() - 1));
    const run1 = await store.start({
      eventId: 'evt_1', model: '5.6-terra', claimAttempt: attempt1!.attempts,
    });
    expect(await events.recoverExpiredLeases(new Date(), 1)).toBe(1);
    const [attempt2] = await events.claimReady(1, new Date(Date.now() + 60_000));
    const run2 = await store.start({
      eventId: 'evt_1', model: '5.6-terra', claimAttempt: attempt2!.attempts,
    });
    const larkWrite = vi.fn(async () => undefined);
    const invokeWrite = async (agentRunId: string) => {
      await store.beginWrite(agentRunId, {
        toolName: 'createDocument',
        targetIdentifiers: {},
        sanitizedSummary: 'created one document',
      });
      await larkWrite();
    };

    await expect(invokeWrite(run1.id)).rejects.toThrow('write_replay_boundary_not_marked');
    expect(larkWrite).not.toHaveBeenCalled();
    const [afterStale] = await database.db.select().from(processedEvents)
      .where(eq(processedEvents.eventId, 'evt_1'));
    expect(afterStale?.writeStartedAt).toBeNull();
    await expect(invokeWrite(run2.id)).resolves.toBeUndefined();

    expect(larkWrite).toHaveBeenCalledOnce();
    const writes = await database.db.select().from(toolRuns);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.agentRunId).toBe(run2.id);
  });

  it.each(['step_limit_reached', 'timeout_reached'] as const)(
    'persists the explicit %s run outcome',
    async (outcome) => {
      const run = await store.start({
        eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra',
      });

      await store.finish(run.id, { toolCallCount: 1, outcome });

      const [runRow] = await database.db.select().from(agentRuns)
        .where(eq(agentRuns.id, run.id));
      expect(runRow?.outcome).toBe(outcome);
    },
  );
});
