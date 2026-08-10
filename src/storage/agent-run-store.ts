import { asc, eq, sql } from 'drizzle-orm';
import type { AgentRunOutcome, WriteAttemptReceipt } from '../agent/run-outcome.js';
import type { PersistentWriteName } from '../agent/tools.js';
import type { GroupHistoryAudit } from '../feishu/group-context.js';
import type { Database } from './database.js';
import { agentRuns, toolRuns } from './schema.js';

const WRITE_RESULT_UNKNOWN = 'write_result_unknown';

export interface AgentRunStore {
  start(input: { eventId: string; claimAttempt: number; model: string }): Promise<{ id: string }>;
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
  recordGroupHistory(agentRunId: string, audit: GroupHistoryAudit): Promise<void>;
  finish(agentRunId: string, input: {
    inputTokens?: number;
    outputTokens?: number;
    toolCallCount: number;
    outcome: Exclude<AgentRunOutcome, 'running'>;
  }): Promise<void>;
}

export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database) {}

  async start(input: {
    eventId: string;
    claimAttempt: number;
    model: string;
  }): Promise<{ id: string }> {
    const [created] = await this.db.insert(agentRuns).values({
      eventId: input.eventId,
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
        update processed_events event
        set write_started_at = coalesce(event.write_started_at, now()),
            updated_at = now()
        from agent_runs run
        where run.id = ${agentRunId}
          and event.event_id = run.event_id
          and event.status = 'processing'
          and event.attempts = run.claim_attempt
        returning event.event_id
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
    const rows = await this.db.select({
      toolName: toolRuns.toolName,
      targetIdentifiers: toolRuns.targetIdentifiers,
      success: toolRuns.success,
      errorCategory: toolRuns.errorCategory,
      sanitizedSummary: toolRuns.sanitizedSummary,
      resultIdentifiers: toolRuns.resultIdentifiers,
    }).from(toolRuns)
      .innerJoin(agentRuns, eq(toolRuns.agentRunId, agentRuns.id))
      .where(eq(agentRuns.eventId, eventId))
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

  async finish(
    agentRunId: string,
    input: {
      inputTokens?: number;
      outputTokens?: number;
      toolCallCount: number;
      outcome: Exclude<AgentRunOutcome, 'running'>;
    },
  ): Promise<void> {
    const [updated] = await this.db.update(agentRuns).set({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      toolCallCount: input.toolCallCount,
      outcome: input.outcome,
      finishedAt: new Date(),
    }).where(eq(agentRuns.id, agentRunId)).returning({ id: agentRuns.id });
    if (!updated) throw new Error('agent_run_not_found');
  }
}
