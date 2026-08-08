import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
} from 'ai';
import { KnowledgeWriteConflict } from '../lark/errors.js';
import type { KnowledgeService } from '../lark/knowledge-service.js';
import type { AgentRunStore } from '../storage/agent-run-store.js';
import type { ConversationStore } from '../storage/conversation-store.js';
import { selectRecentHistory, type AgentHistoryMessage } from './context-window.js';
import { TEAM_AGENT_INSTRUCTIONS } from './instructions.js';
import { SourceRegistry, type AgentSource } from './sources.js';
import {
  createKnowledgeTools,
  type KnowledgeWriteAudit,
  type ScopedHistoryReader,
} from './tools.js';

export type AgentReply = {
  text: string;
  sources: AgentSource[];
  usage: { inputTokens?: number; outputTokens?: number };
};

export type AgentRunInput = {
  prompt: string;
  history: AgentHistoryMessage[];
  trigger: { kind: 'feishu_member'; senderOpenId: string; chatId: string };
};

export interface KnowledgeAgent {
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentReply>;
}

export type TeamAgentDependencies = {
  model: LanguageModel;
  service: KnowledgeService;
  history: ScopedHistoryReader;
  sources: SourceRegistry;
  writeAudit: KnowledgeWriteAudit;
};

export function createTeamAgent(dependencies: TeamAgentDependencies, maxSteps: number) {
  return new ToolLoopAgent({
    id: 'minori-team-agent',
    model: dependencies.model,
    instructions: TEAM_AGENT_INSTRUCTIONS,
    tools: createKnowledgeTools(
      dependencies.service,
      dependencies.history,
      dependencies.sources,
      dependencies.writeAudit,
    ),
    stopWhen: stepCountIs(maxSteps),
    providerOptions: { openai: { store: false } },
  });
}

export type RunKnowledgeAgentDependencies = Pick<TeamAgentDependencies, 'model' | 'service'> & {
  eventId: string;
  modelName: string;
  maxSteps: number;
  timeoutMs: number;
  agentRunStore: AgentRunStore;
  conversationKey: string;
  triggerMessageId: string;
  conversationStore: Pick<ConversationStore, 'search' | 'recentWithinBudget'>;
  contextTokenTarget?: number;
};

const WRITE_AUDIT_UNAVAILABLE = 'write_audit_unavailable';
const AGENT_AUDIT_UNAVAILABLE = 'agent_audit_unavailable';
const AGENT_RUN_ABORTED_CATEGORY = 'agent_run_aborted';
const AUDIT_FINALIZATION_TIMEOUT_MS = 5_000;

class WriteAuditUnavailable extends Error {
  constructor() {
    super(WRITE_AUDIT_UNAVAILABLE);
    this.name = 'WriteAuditUnavailable';
  }
}

function stableWriteErrorCategory(error: unknown) {
  return error instanceof KnowledgeWriteConflict
    ? 'knowledge_write_conflict'
    : 'knowledge_write_failed';
}

function createWriteAudit(
  store: AgentRunStore,
  agentRunId: string,
  signal: AbortSignal,
): KnowledgeWriteAudit {
  return {
    async run(input, operation) {
      let write: { id: string };
      try {
        write = await withAbort(
          () => store.beginWrite(agentRunId, input),
          signal,
          (lateWrite) => withAuditFinalization(() => store.finishWrite(lateWrite.id, {
            success: false,
            errorCategory: AGENT_RUN_ABORTED_CATEGORY,
          })),
        );
      } catch {
        throw new WriteAuditUnavailable();
      }

      try {
        signal.throwIfAborted();
        const result = await operation();
        try {
          await withAuditFinalization(
            () => store.finishWrite(write.id, { success: true }),
          );
        } catch {
          throw new WriteAuditUnavailable();
        }
        return result;
      } catch (error) {
        if (error instanceof WriteAuditUnavailable) throw error;
        try {
          await withAuditFinalization(() => store.finishWrite(write.id, {
            success: false,
            errorCategory: stableWriteErrorCategory(error),
          }));
        } catch {
          throw new WriteAuditUnavailable();
        }
        throw error;
      }
    },
  };
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function withAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateSuccess?: (value: T) => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      settled = true;
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        if (aborted) {
          if (onLateSuccess) {
            try {
              void onLateSuccess(value).catch(() => undefined);
            } catch {
              // Late audit reconciliation is best-effort and already independently bounded.
            }
          }
          return;
        }
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function withAuditFinalization<T>(operation: () => Promise<T>): Promise<T> {
  return withAbort(operation, AbortSignal.timeout(AUDIT_FINALIZATION_TIMEOUT_MS));
}

export async function runKnowledgeAgent(
  input: AgentRunInput,
  dependencies: RunKnowledgeAgentDependencies,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const runSignal = combinedSignal(signal, dependencies.timeoutMs);
  const sources = new SourceRegistry();
  const contextTokenTarget = dependencies.contextTokenTarget ?? 24_000;

  let run: { id: string };
  try {
    run = await withAbort(
      () => dependencies.agentRunStore.start({
        eventId: dependencies.eventId,
        model: dependencies.modelName,
      }),
      runSignal,
      (lateRun) => withAuditFinalization(() => dependencies.agentRunStore.finish(lateRun.id, {
        toolCallCount: 0,
        outcome: 'aborted',
      })),
    );
  } catch {
    throw new Error(AGENT_AUDIT_UNAVAILABLE);
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let toolCallCount = 0;
  let outcome: 'completed' | 'failed' | 'aborted' = 'failed';

  try {
    const storedHistory = await withAbort(
      () => dependencies.conversationStore.recentWithinBudget(
        dependencies.conversationKey,
        contextTokenTarget,
        dependencies.triggerMessageId,
      ),
      runSignal,
    );
    const authoritativeHistory = storedHistory.map(({ role, content }) => ({ role, content }));
    const trigger = storedHistory.find(
      (message) => message.messageId === dependencies.triggerMessageId,
    );
    if (trigger?.role !== 'user' || trigger.content !== input.prompt) {
      throw new Error('trigger_prompt_mismatch');
    }
    if (input.history.length > 0
      && JSON.stringify(input.history) !== JSON.stringify(authoritativeHistory)) {
      throw new Error('conversation_history_mismatch');
    }
    const agent = createTeamAgent({
      model: dependencies.model,
      service: dependencies.service,
      sources,
      writeAudit: createWriteAudit(dependencies.agentRunStore, run.id, runSignal),
      history: {
        search: (query, limit) => dependencies.conversationStore.search(
          dependencies.conversationKey,
          query,
          limit,
        ),
      },
    }, dependencies.maxSteps);
    const history = selectRecentHistory(
      authoritativeHistory,
      contextTokenTarget,
    );
    const result = await agent.generate({
      messages: history,
      abortSignal: runSignal,
      onStepEnd: (step) => {
        if (step.usage.inputTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + step.usage.inputTokens;
        }
        if (step.usage.outputTokens !== undefined) {
          outputTokens = (outputTokens ?? 0) + step.usage.outputTokens;
        }
        toolCallCount += step.toolCalls.length;
      },
    });
    inputTokens = result.usage.inputTokens;
    outputTokens = result.usage.outputTokens;
    toolCallCount = result.toolCalls.length;
    const finalized = sources.finalize(result.text);
    outcome = 'completed';
    return {
      ...finalized,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    };
  } catch (error) {
    outcome = runSignal.aborted ? 'aborted' : 'failed';
    throw error;
  } finally {
    try {
      await withAuditFinalization(() => dependencies.agentRunStore.finish(run.id, {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        toolCallCount,
        outcome,
      }));
    } catch {
      throw new Error(AGENT_AUDIT_UNAVAILABLE);
    }
  }
}
