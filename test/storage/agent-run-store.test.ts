import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import { PostgresAgentRunStore } from '../../src/storage/agent-run-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
import { PostgresScheduleStore } from '../../src/storage/schedule-store.js';
import { PostgresScheduledRunStore } from '../../src/storage/scheduled-run-store.js';
import { agentRuns, processedEvents, scheduledRuns, toolRuns } from '../../src/storage/schema.js';

describe('PostgresAgentRunStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresAgentRunStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresAgentRunStore(database.db);
  }, 180_000);

  beforeEach(async () => {
    await database.pool.query('truncate table processed_events cascade');
    await database.pool.query('truncate table scheduled_runs, scheduled_task_revisions, scheduled_tasks cascade');
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

  it('marks and fences persistent writes against the current scheduled claim', async () => {
    const schedules = new PostgresScheduleStore(database.db);
    const runs = new PostgresScheduledRunStore(database.db);
    const created = await schedules.create({
      name: 'Once', creatorOpenId: 'ou_creator', actorOpenId: 'ou_creator',
      origin: { chatId: 'oc_origin', displayName: 'Origin', chatType: 'p2p' },
      instruction: 'Create a status document',
      schedule: { kind: 'once', at: new Date('2026-08-11T01:00:00Z'), timezone: 'UTC' },
      resultTarget: { chatId: 'oc_target', displayName: 'Target', chatType: 'group' },
      nextDueAt: new Date('2026-08-11T01:00:00Z'),
    });
    if (created.status !== 'created') throw new Error('fixture_not_created');
    const due = await runs.createDue({
      scheduleId: created.task.id,
      expectedDueAt: created.task.nextDueAt!,
      scheduledFor: created.task.nextDueAt!,
    });
    if (due.status !== 'created') throw new Error('fixture_run_not_created');
    const claim = await runs.claim(due.run.id, new Date('2026-08-11T01:00:00Z'), 60_000);
    if (!claim) throw new Error('fixture_run_not_claimed');
    const agentRun = await store.start({
      scheduledRunId: claim.id,
      claimAttempt: claim.claimAttempt,
      model: '5.6-terra',
    });
    await store.beginWrite(agentRun.id, {
      toolName: 'createDocument', targetIdentifiers: {},
      sanitizedSummary: 'created one document',
    });
    const [marked] = await database.db.select().from(scheduledRuns)
      .where(eq(scheduledRuns.id, claim.id));
    expect(marked?.writeStartedAt).toBeInstanceOf(Date);
    await expect(store.listScheduledWriteAttempts(claim.id)).resolves.toEqual([{
      toolName: 'createDocument', outcome: 'unknown', targetIdentifiers: {},
      sanitizedSummary: 'created one document',
    }]);

    await database.db.update(scheduledRuns).set({ claimAttempt: claim.claimAttempt + 1 })
      .where(eq(scheduledRuns.id, claim.id));
    const staleAgentRun = await store.start({
      scheduledRunId: claim.id, claimAttempt: claim.claimAttempt, model: '5.6-terra',
    });
    await expect(store.beginWrite(staleAgentRun.id, {
      toolName: 'appendDocument', targetIdentifiers: { doc: 'dox_1' },
      sanitizedSummary: 'appended content to one document',
    })).rejects.toThrow('write_replay_boundary_not_marked');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('records search completeness without crossing the write replay boundary', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });

    await store.recordKnowledgeSearch(run.id, {
      success: true,
      rawCount: 10,
      validCount: 8,
      omittedCount: 2,
    });
    await store.recordKnowledgeSearch(run.id, {
      success: false,
      errorCategory: 'knowledge_search_contract_error',
      rawCount: 3,
      validCount: 0,
      omittedCount: 3,
    });

    const rows = await database.db.select().from(toolRuns)
      .where(eq(toolRuns.agentRunId, run.id));
    expect(rows).toEqual([
      expect.objectContaining({
        toolName: 'searchKnowledge',
        success: true,
        errorCategory: null,
        sanitizedSummary: 'raw=10 valid=8 omitted=2',
        targetIdentifiers: null,
        resultIdentifiers: null,
      }),
      expect.objectContaining({
        toolName: 'searchKnowledge',
        success: false,
        errorCategory: 'knowledge_search_contract_error',
        sanitizedSummary: 'raw=3 valid=0 omitted=3',
        targetIdentifiers: null,
        resultIdentifiers: null,
      }),
    ]);
    const [event] = await database.db.select().from(processedEvents)
      .where(eq(processedEvents.eventId, 'evt_1'));
    expect(event?.writeStartedAt).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(
      /search query|document title|https?:|wiki token|document body|open[_ ]?id|oauth/iu,
    );
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

  it('persists only sanitized Team Context load metadata on the Agent run', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    await store.recordTeamContext(run.id, {
      status: 'stale',
      content: '# Team Context\nsecret body\n',
      sourceRevision: 8,
      estimatedTokens: 33,
      fetchedAt: new Date('2026-08-10T12:00:00Z'),
      errorCategory: 'team_context_stale',
    });

    const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(row).toMatchObject({
      teamContextStatus: 'stale',
      teamContextRevision: 8,
      teamContextTokenCount: 33,
      teamContextFetchedAt: new Date('2026-08-10T12:00:00Z'),
      teamContextErrorCategory: 'team_context_stale',
    });
    expect(JSON.stringify(row)).not.toContain('secret body');
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

  it('atomically stores the terminal outcome and failure detail', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });

    await store.finish(run.id, {
      toolCallCount: 2,
      outcome: 'failed',
      errorMessage: 'provider request failed',
    });

    const result = await database.pool.query<{
      outcome: string;
      errorMessage: string | null;
    }>(`select outcome, error_message as "errorMessage" from agent_runs where id = $1`, [run.id]);
    expect(result.rows).toEqual([{
      outcome: 'failed',
      errorMessage: 'provider request failed',
    }]);
  });

  it('keeps a separate failure detail for each Agent retry', async () => {
    const first = await store.start({ eventId: 'evt_1', claimAttempt: 1, model: '5.6-terra' });
    const second = await store.start({ eventId: 'evt_1', claimAttempt: 2, model: '5.6-terra' });
    await store.finish(first.id, {
      toolCallCount: 0, outcome: 'failed', errorMessage: 'first failure',
    });
    await store.finish(second.id, {
      toolCallCount: 0, outcome: 'failed', errorMessage: 'second failure',
    });

    const result = await database.pool.query<{
      claimAttempt: number;
      errorMessage: string | null;
    }>(`
      select claim_attempt as "claimAttempt", error_message as "errorMessage"
      from agent_runs where id in ($1, $2) order by claim_attempt
    `, [first.id, second.id]);
    expect(result.rows).toEqual([
      { claimAttempt: 1, errorMessage: 'first failure' },
      { claimAttempt: 2, errorMessage: 'second failure' },
    ]);
  });

  it('clears only expired failure details while retaining Agent Run audits', async () => {
    await database.pool.query(`
      insert into processed_events (
        event_id, message_id, payload, conversation_key, status
      ) values (
        'evt_2', 'om_2',
        '{"eventId":"evt_2","messageId":"om_2","chatId":"oc_2","conversationKey":"oc_2","senderOpenId":"ou_2","chatType":"p2p","content":{"kind":"text","text":"hello","feishuLinks":[]},"occurredAt":"2026-08-01T00:00:00.000Z"}'::jsonb,
        'oc_2', 'processing'
      )
    `);
    const expired = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: 'old' });
    const retained = await store.start({ eventId: 'evt_2', claimAttempt: 0, model: 'new' });
    await store.finish(expired.id, {
      toolCallCount: 1, outcome: 'failed', errorMessage: 'old detail',
    });
    await store.finish(retained.id, {
      toolCallCount: 1, outcome: 'failed', errorMessage: 'new detail',
    });
    await database.pool.query(
      `update agent_runs
       set finished_at = case when id = $1 then $3::timestamptz else $4::timestamptz end
       where id in ($1, $2)`,
      [
        expired.id,
        retained.id,
        new Date('2026-07-01T00:00:00Z'),
        new Date('2026-08-01T00:00:00Z'),
      ],
    );

    await expect(store.purgeFailureDetails(new Date('2026-07-15T00:00:00Z'))).resolves.toBe(1);
    const result = await database.pool.query<{
      id: string;
      outcome: string;
      errorMessage: string | null;
    }>(`select id, outcome, error_message as "errorMessage"
        from agent_runs where id in ($1, $2)`, [expired.id, retained.id]);
    expect(result.rows).toEqual(expect.arrayContaining([
      { id: expired.id, outcome: 'failed', errorMessage: null },
      { id: retained.id, outcome: 'failed', errorMessage: 'new detail' },
    ]));
  });

  it('uses the same replay fence and sanitized receipt for a Team Context mutation', async () => {
    const run = await store.start({ eventId: 'evt_1', claimAttempt: 0, model: '5.6-terra' });
    const write = await store.beginWrite(run.id, {
      toolName: 'updateTeamContext',
      targetIdentifiers: { documentToken: 'dox_team' },
      sanitizedSummary: 'updated Team Context',
    });
    await store.finishWrite(write.id, {
      outcome: 'succeeded',
      resultIdentifiers: { documentToken: 'dox_team', revisionId: '8' },
    });

    await expect(store.listWriteAttempts('evt_1')).resolves.toEqual([{
      toolName: 'updateTeamContext',
      outcome: 'succeeded',
      targetIdentifiers: { documentToken: 'dox_team' },
      sanitizedSummary: 'updated Team Context',
      resultIdentifiers: { documentToken: 'dox_team', revisionId: '8' },
    }]);
    const [event] = await database.db.select().from(processedEvents)
      .where(eq(processedEvents.eventId, 'evt_1'));
    expect(event?.writeStartedAt).toBeInstanceOf(Date);
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
