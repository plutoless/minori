import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
} from 'ai';
import type { KnowledgeService } from '../lark/knowledge-service.js';
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
  conversationKey: string;
  triggerMessageId: string;
  conversationStore: Pick<ConversationStore, 'search' | 'recentWithinBudget'>;
  writeAudit?: KnowledgeWriteAudit;
  contextTokenTarget?: number;
  timeoutMs?: number;
};

const unpersistedWriteAudit: KnowledgeWriteAudit = {
  run: (_input, operation) => operation(),
};

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function runKnowledgeAgent(
  input: AgentRunInput,
  dependencies: RunKnowledgeAgentDependencies,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const runSignal = combinedSignal(signal, dependencies.timeoutMs ?? 90_000);
  const sources = new SourceRegistry();
  const contextTokenTarget = dependencies.contextTokenTarget ?? 24_000;
  const storedHistory = await withAbort(
    dependencies.conversationStore.recentWithinBudget(
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
    writeAudit: dependencies.writeAudit ?? unpersistedWriteAudit,
    history: {
      search: (query, limit) => dependencies.conversationStore.search(
        dependencies.conversationKey,
        query,
        limit,
      ),
    },
  }, 12);
  const history = selectRecentHistory(
    authoritativeHistory,
    contextTokenTarget,
  );
  const result = await agent.generate({
    messages: history,
    abortSignal: runSignal,
  });
  const finalized = sources.finalize(result.text);
  return {
    ...finalized,
    usage: {
      ...(result.usage.inputTokens !== undefined
        ? { inputTokens: result.usage.inputTokens }
        : {}),
      ...(result.usage.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
    },
  };
}
