import { eq } from 'drizzle-orm';
import type { Database } from './database.js';
import { agentRuns, toolRuns } from './schema.js';

export interface AgentRunStore {
  start(input: { eventId: string; model: string }): Promise<{ id: string }>;
  beginWrite(agentRunId: string, input: {
    toolName: 'createDocument' | 'appendDocument' | 'patchDocument';
    targetIdentifiers: Record<string, string>;
    sanitizedSummary: string;
  }): Promise<{ id: string }>;
  finishWrite(toolRunId: string, input: {
    success: boolean;
    errorCategory?: string;
  }): Promise<void>;
  finish(agentRunId: string, input: {
    inputTokens?: number;
    outputTokens?: number;
    toolCallCount: number;
    outcome: 'completed' | 'failed' | 'aborted';
  }): Promise<void>;
}

export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database) {}

  async start(input: { eventId: string; model: string }): Promise<{ id: string }> {
    const [created] = await this.db.insert(agentRuns).values({
      eventId: input.eventId,
      model: input.model,
      outcome: 'running',
    }).returning({ id: agentRuns.id });
    if (!created) throw new Error('agent_run_not_created');
    return created;
  }

  async beginWrite(
    agentRunId: string,
    input: {
      toolName: 'createDocument' | 'appendDocument' | 'patchDocument';
      targetIdentifiers: Record<string, string>;
      sanitizedSummary: string;
    },
  ): Promise<{ id: string }> {
    const [created] = await this.db.insert(toolRuns).values({
      agentRunId,
      toolName: input.toolName,
      targetIdentifiers: input.targetIdentifiers,
      sanitizedSummary: input.sanitizedSummary,
    }).returning({ id: toolRuns.id });
    if (!created) throw new Error('tool_run_not_created');
    return created;
  }

  async finishWrite(
    toolRunId: string,
    input: { success: boolean; errorCategory?: string },
  ): Promise<void> {
    const [updated] = await this.db.update(toolRuns).set({
      success: input.success,
      errorCategory: input.errorCategory ?? null,
      finishedAt: new Date(),
    }).where(eq(toolRuns.id, toolRunId)).returning({ id: toolRuns.id });
    if (!updated) throw new Error('tool_run_not_found');
  }

  async finish(
    agentRunId: string,
    input: {
      inputTokens?: number;
      outputTokens?: number;
      toolCallCount: number;
      outcome: 'completed' | 'failed' | 'aborted';
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
