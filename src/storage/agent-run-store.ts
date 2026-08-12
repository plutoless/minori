import { and, asc, eq, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type { AgentRunOutcome, WriteAttemptReceipt } from '../agent/run-outcome.js';
import type { PersistentWriteName } from '../agent/tools.js';
import type { TeamContextLoad } from '../team-context/types.js';
import type { GroupHistoryAudit } from '../feishu/group-context.js';
import type { Database } from './database.js';
import { agentRuns, toolRuns } from './schema.js';

const WRITE_RESULT_UNKNOWN = 'write_result_unknown';

export interface AgentRunStore {
  start(input: (
    | { eventId: string; scheduledRunId?: never }
    | { scheduledRunId: string; eventId?: never }
  ) & { claimAttempt: number; model: string }): Promise<{ id: string }>;
  beginWrite(agentRunId: string, input: {
    toolName: PersistentWriteName;
    targetIdentifiers: Record<string, string>;
    sanitizedSummary: string;
  }): Promise<{ id: string }>;
  finishWrite(toolRunId: string, input: {
    outcome: 'succeeded' | 'failed' | 'unknown';
    errorCategory?: string;
    resultIdentifiers?: Record<string, string>;
  }): Promise<void>;
  listWriteAttempts(eventId: string): Promise<WriteAttemptReceipt[]>;
  listScheduledWriteAttempts(scheduledRunId: string): Promise<WriteAttemptReceipt[]>;
  recordGroupHistory(agentRunId: string, audit: GroupHistoryAudit): Promise<void>;
  recordTeamContext(agentRunId: string, context: TeamContextLoad): Promise<void>;
  finish(agentRunId: string, input: {
    inputTokens?: number;
    outputTokens?: number;
    toolCallCount: number;
    outcome: Exclude<AgentRunOutcome, 'running'>;
    errorMessage?: string;
  }): Promise<void>;
  purgeFailureDetails(before: Date): Promise<number>;
}

export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database) {}

  async start(input: (
    | { eventId: string; scheduledRunId?: never }
    | { scheduledRunId: string; eventId?: never }
  ) & {
    claimAttempt: number;
    model: string;
  }): Promise<{ id: string }> {
    const [created] = await this.db.insert(agentRuns).values({
      eventId: input.eventId ?? null,
      scheduledRunId: input.scheduledRunId ?? null,
      claimAttempt: input.claimAttempt,
      model: input.model,
      outcome: 'running',
    }).returning({ id: agentRuns.id });
    if (!created) throw new Error('agent_run_not_created');
    return created;
  }

  async beginWrite(
    agentRunId: string,
    input: {
      toolName: PersistentWriteName;
      targetIdentifiers: Record<string, string>;
      sanitizedSummary: string;
    },
  ): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx.insert(toolRuns).values({
        agentRunId,
        toolName: input.toolName,
        targetIdentifiers: input.targetIdentifiers,
        sanitizedSummary: input.sanitizedSummary,
      }).returning({ id: toolRuns.id });
      if (!created) throw new Error('tool_run_not_created');

      const marked = await tx.execute(sql`
        with message_mark as (
          update processed_events event
          set write_started_at = coalesce(event.write_started_at, now()), updated_at = now()
          from agent_runs run
          where run.id = ${agentRunId} and run.scheduled_run_id is null
            and event.event_id = run.event_id and event.status = 'processing'
            and event.attempts = run.claim_attempt
          returning event.event_id
        ), scheduled_mark as (
          update scheduled_runs scheduled
          set write_started_at = coalesce(scheduled.write_started_at, now()), updated_at = now()
          from agent_runs run
          where run.id = ${agentRunId} and run.event_id is null
            and scheduled.id = run.scheduled_run_id and scheduled.status = 'processing'
            and scheduled.claim_attempt = run.claim_attempt
          returning scheduled.id
        )
        select id::text from scheduled_mark
        union all select event_id as id from message_mark
      `);
      if (marked.rows.length !== 1) throw new Error('write_replay_boundary_not_marked');
      return created;
    });
  }

  async finishWrite(
    toolRunId: string,
    input: {
      outcome: 'succeeded' | 'failed' | 'unknown';
      errorCategory?: string;
      resultIdentifiers?: WriteAttemptReceipt['resultIdentifiers'];
    },
  ): Promise<void> {
    const [updated] = await this.db.update(toolRuns).set({
      success: input.outcome === 'succeeded'
        ? true
        : input.outcome === 'failed' ? false : null,
      errorCategory: input.errorCategory
        ?? (input.outcome === 'unknown' ? WRITE_RESULT_UNKNOWN : null),
      resultIdentifiers: input.resultIdentifiers ?? null,
      finishedAt: new Date(),
    }).where(eq(toolRuns.id, toolRunId)).returning({ id: toolRuns.id });
    if (!updated) throw new Error('tool_run_not_found');
  }

  async listWriteAttempts(eventId: string): Promise<WriteAttemptReceipt[]> {
    return this.listWriteAttemptsWhere(sql`${agentRuns.eventId} = ${eventId}`);
  }

  async listScheduledWriteAttempts(scheduledRunId: string): Promise<WriteAttemptReceipt[]> {
    return this.listWriteAttemptsWhere(sql`${agentRuns.scheduledRunId} = ${scheduledRunId}`);
  }

  private async listWriteAttemptsWhere(condition: SQL): Promise<WriteAttemptReceipt[]> {
    const rows = await this.db.select({
      toolName: toolRuns.toolName,
      targetIdentifiers: toolRuns.targetIdentifiers,
      success: toolRuns.success,
      errorCategory: toolRuns.errorCategory,
      sanitizedSummary: toolRuns.sanitizedSummary,
      resultIdentifiers: toolRuns.resultIdentifiers,
    }).from(toolRuns)
      .innerJoin(agentRuns, eq(toolRuns.agentRunId, agentRuns.id))
      .where(condition)
      .orderBy(asc(toolRuns.startedAt));

    const typedToolNames = new Set<PersistentWriteName>([
      'createDocument', 'appendDocument', 'patchDocument', 'updateTeamContext',
      'createSchedule', 'updateSchedule', 'pauseSchedule', 'resumeSchedule', 'deleteSchedule',
    ]);
    return rows.flatMap((row): WriteAttemptReceipt[] => {
      if (!typedToolNames.has(row.toolName as PersistentWriteName) || !row.sanitizedSummary) return [];
      return [{
        toolName: row.toolName as WriteAttemptReceipt['toolName'],
        outcome: row.success === true ? 'succeeded' : row.success === false ? 'failed' : 'unknown',
        sanitizedSummary: row.sanitizedSummary,
        targetIdentifiers: row.targetIdentifiers ?? {},
        ...(row.resultIdentifiers ? { resultIdentifiers: row.resultIdentifiers } : {}),
        ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}),
      }];
    });
  }

  async recordGroupHistory(agentRunId: string, audit: GroupHistoryAudit): Promise<void> {
    const [updated] = await this.db.update(agentRuns).set({
      groupHistoryStatus: audit.status,
      groupHistoryMessageCount: audit.messageCount,
      groupHistoryPageCount: audit.pageCallCount,
      groupHistoryCutoff: audit.cutoff,
      groupHistoryErrorCategory: audit.errorCategory ?? null,
    }).where(eq(agentRuns.id, agentRunId)).returning({ id: agentRuns.id });
    if (!updated) throw new Error('agent_run_not_found');
  }

  async recordTeamContext(agentRunId: string, context: TeamContextLoad): Promise<void> {
    const [updated] = await this.db.update(agentRuns).set({
      teamContextStatus: context.status,
      teamContextRevision: context.sourceRevision ?? null,
      teamContextTokenCount: context.estimatedTokens ?? null,
      teamContextFetchedAt: context.fetchedAt ?? null,
      teamContextErrorCategory: context.errorCategory ?? null,
    }).where(eq(agentRuns.id, agentRunId)).returning({ id: agentRuns.id });
    if (!updated) throw new Error('agent_run_not_found');
  }

  async finish(
    agentRunId: string,
    input: {
      inputTokens?: number;
      outputTokens?: number;
      toolCallCount: number;
      outcome: Exclude<AgentRunOutcome, 'running'>;
      errorMessage?: string;
    },
  ): Promise<void> {
    const [updated] = await this.db.update(agentRuns).set({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      toolCallCount: input.toolCallCount,
      outcome: input.outcome,
      errorMessage: input.errorMessage ?? null,
      finishedAt: new Date(),
    }).where(eq(agentRuns.id, agentRunId)).returning({ id: agentRuns.id });
    if (!updated) throw new Error('agent_run_not_found');
  }

  async purgeFailureDetails(before: Date): Promise<number> {
    const cleared = await this.db.update(agentRuns).set({
      errorMessage: null,
    }).where(and(
      lt(agentRuns.finishedAt, before),
      isNotNull(agentRuns.errorMessage),
    )).returning({ id: agentRuns.id });
    return cleared.length;
  }
}
