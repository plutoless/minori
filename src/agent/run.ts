import {
  ToolLoopAgent,
  type LanguageModel,
} from 'ai';
import { KnowledgeWriteConflict } from '../lark/errors.js';
import type { KnowledgeService, KnowledgeWriteResult } from '../lark/knowledge-service.js';
import type {
  GroupContextSource,
  GroupHistoryAudit,
  InitialGroupContext,
  ScopedGroupContextReader,
} from '../feishu/group-context.js';
import type { AgentRunStore } from '../storage/agent-run-store.js';
import type { ConversationStore } from '../storage/conversation-store.js';
import { TeamContextUpdateError, type TeamContextSource } from '../team-context/source.js';
import { DefaultContextAssembler } from './context-assembler.js';
import type { AgentHistoryMessage } from './context-window.js';
import { TEAM_AGENT_INSTRUCTIONS } from './instructions.js';
import {
  budgetExhaustedText,
  interruptedAfterWriteText,
  type AgentReplyOutcome,
  type AgentRunOutcome,
  type WriteAttemptReceipt,
} from './run-outcome.js';
import { SourceRegistry, type AgentSource } from './sources.js';
import {
  createKnowledgeTools,
  type GroupHistoryToolContext,
  type PersistentWriteAudit,
  type ScopedHistoryReader,
  type TeamContextToolContext,
} from './tools.js';

export type AgentReply = {
  text: string;
  sources: AgentSource[];
  usage: { inputTokens?: number; outputTokens?: number };
  outcome: AgentReplyOutcome;
  writeAttempts: WriteAttemptReceipt[];
};

export type AgentRunInput = {
  prompt: string;
  history: AgentHistoryMessage[];
  trigger: {
    kind: 'feishu_member';
    senderOpenId: string;
    chatId: string;
    chatType: 'group' | 'p2p';
    occurredAt: Date;
  };
};

export interface KnowledgeAgent {
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentReply>;
}

export type TeamAgentDependencies = {
  model: LanguageModel;
  service: KnowledgeService;
  history: ScopedHistoryReader;
  sources: SourceRegistry;
  writeAudit: PersistentWriteAudit;
  groupHistory?: GroupHistoryToolContext;
  teamContext?: TeamContextToolContext;
};

function createStepBudget(maxSteps: number) {
  let exhausted = false;
  return {
    stopWhen: ({ steps }: { steps: Array<unknown> }) => {
      exhausted = steps.length === maxSteps;
      return exhausted;
    },
    exhausted: () => exhausted,
  };
}

type StepBudget = ReturnType<typeof createStepBudget>;

function createTeamAgentWithBudget(
  dependencies: TeamAgentDependencies,
  budget: StepBudget,
) {
  return new ToolLoopAgent({
    id: 'minori-team-agent',
    model: dependencies.model,
    instructions: TEAM_AGENT_INSTRUCTIONS,
    tools: createKnowledgeTools(
      dependencies.service,
      dependencies.history,
      dependencies.sources,
      dependencies.writeAudit,
      dependencies.groupHistory,
      dependencies.teamContext,
    ),
    stopWhen: budget.stopWhen,
    providerOptions: { openai: { store: false } },
  });
}

export function createTeamAgent(dependencies: TeamAgentDependencies, maxSteps: number) {
  return createTeamAgentWithBudget(dependencies, createStepBudget(maxSteps));
}

export type RunKnowledgeAgentDependencies = Pick<TeamAgentDependencies, 'model' | 'service'> & {
  eventId: string;
  claimAttempt: number;
  modelName: string;
  maxSteps: number;
  timeoutMs: number;
  botOpenId: string;
  botAppId: string;
  agentRunStore: AgentRunStore;
  conversationKey: string;
  triggerMessageId: string;
  conversationStore: Pick<ConversationStore, 'search' | 'recentWithinBudget'>;
  groupContextSource?: GroupContextSource;
  teamContextSource?: TeamContextSource;
  contextTokenTarget?: number;
};

const WRITE_AUDIT_UNAVAILABLE = 'write_audit_unavailable';
const AGENT_AUDIT_UNAVAILABLE = 'agent_audit_unavailable';
const AGENT_RUN_ABORTED_CATEGORY = 'agent_run_aborted';
const AUDIT_FINALIZATION_TIMEOUT_MS = 5_000;
const CURRENT_SENDER_NAME_UNAVAILABLE = '姓名不可用的成员';

class WriteAuditUnavailable extends Error {
  constructor() {
    super(WRITE_AUDIT_UNAVAILABLE);
    this.name = 'WriteAuditUnavailable';
  }
}

function stableWriteErrorCategory(
  error: unknown,
  toolName: Parameters<PersistentWriteAudit['run']>[0]['toolName'],
) {
  if (error instanceof TeamContextUpdateError) return error.code;
  if (error instanceof KnowledgeWriteConflict) {
    return toolName === 'updateTeamContext'
      ? 'team_context_conflict'
      : 'knowledge_write_conflict';
  }
  return toolName === 'updateTeamContext'
    ? 'team_context_update_failed'
    : 'knowledge_write_failed';
}

function createWriteAudit(
  store: AgentRunStore,
  agentRunId: string,
  signal: AbortSignal,
  writeAttempts: WriteAttemptReceipt[],
  replayBoundary: { crossed: boolean },
): PersistentWriteAudit {
  return {
    async run<T>(
      input: Parameters<PersistentWriteAudit['run']>[0],
      operation: () => Promise<T>,
      identifiersForResult?: (result: T) => Record<string, string> | undefined,
    ) {
      let write: { id: string };
      try {
        write = await withAbort(
          () => store.beginWrite(agentRunId, input),
          signal,
          (lateWrite) => withAuditFinalization(() => store.finishWrite(lateWrite.id, {
            outcome: 'unknown',
            errorCategory: AGENT_RUN_ABORTED_CATEGORY,
          })),
        );
      } catch {
        throw new WriteAuditUnavailable();
      }
      replayBoundary.crossed = true;

      const receipt: WriteAttemptReceipt = {
        ...input,
        outcome: 'unknown',
      };
      writeAttempts.push(receipt);

      try {
        signal.throwIfAborted();
        const result = await operation();
        const identifiers = identifiersForResult?.(result) ?? resultIdentifiers(result);
        try {
          await withAuditFinalization(
            () => store.finishWrite(write.id, {
              outcome: 'succeeded',
              ...(identifiers ? { resultIdentifiers: identifiers } : {}),
            }),
          );
        } catch {
          throw new WriteAuditUnavailable();
        }
        receipt.outcome = 'succeeded';
        if (identifiers) receipt.resultIdentifiers = identifiers;
        return result;
      } catch (error) {
        if (error instanceof WriteAuditUnavailable) throw error;
        const errorCategory = signal.aborted
          ? AGENT_RUN_ABORTED_CATEGORY
          : stableWriteErrorCategory(error, input.toolName);
        try {
          await withAuditFinalization(() => store.finishWrite(write.id, {
            outcome: signal.aborted ? 'unknown' : 'failed',
            errorCategory,
          }));
        } catch {
          throw new WriteAuditUnavailable();
        }
        receipt.outcome = signal.aborted ? 'unknown' : 'failed';
        receipt.errorCategory = errorCategory;
        throw error;
      }
    },
  };
}

function resultIdentifiers(result: unknown): WriteAttemptReceipt['resultIdentifiers'] {
  const candidate = result as Partial<KnowledgeWriteResult>;
  if (typeof candidate.token !== 'string'
    || typeof candidate.title !== 'string'
    || typeof candidate.url !== 'string'
    || typeof candidate.revisionId !== 'number') return undefined;
  return {
    token: candidate.token,
    title: candidate.title,
    url: candidate.url,
    revisionId: String(candidate.revisionId),
  };
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

function unavailableGroupContext(cutoff: Date): InitialGroupContext {
  return {
    messages: [],
    currentSenderName: CURRENT_SENDER_NAME_UNAVAILABLE,
    audit: {
      status: 'unavailable',
      messageCount: 0,
      pageCallCount: 1,
      cutoff: new Date(cutoff),
      errorCategory: 'group_history_unavailable',
    },
  };
}

function groupModelMessages(initial: InitialGroupContext): AgentHistoryMessage[] {
  const messages: AgentHistoryMessage[] = initial.messages.map((message) => ({
    role: message.role,
    content: `[Live Group History][${message.speakerName}]`
      + `[${message.occurredAt.toISOString()}] ${message.content}`,
  }));
  if (initial.audit.errorCategory) {
    messages.push({
      role: 'user',
      content: `[Live Group History][Context Limitation] ${initial.audit.errorCategory}`,
    });
  }
  return messages;
}

function createRunAbortSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let firstAbortSource: 'external' | 'timeout' | undefined;
  const recordExternalAbort = () => { firstAbortSource ??= 'external'; };
  const recordTimeoutAbort = () => { firstAbortSource ??= 'timeout'; };
  signal?.addEventListener('abort', recordExternalAbort, { once: true });
  timeoutSignal.addEventListener('abort', recordTimeoutAbort, { once: true });
  if (signal?.aborted) recordExternalAbort();
  if (timeoutSignal.aborted) recordTimeoutAbort();
  return {
    runSignal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    firstAbortSource: () => firstAbortSource,
    dispose: () => {
      signal?.removeEventListener('abort', recordExternalAbort);
      timeoutSignal.removeEventListener('abort', recordTimeoutAbort);
    },
  };
}

export async function runKnowledgeAgent(
  input: AgentRunInput,
  dependencies: RunKnowledgeAgentDependencies,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const abortSignals = createRunAbortSignals(signal, dependencies.timeoutMs);
  const { runSignal } = abortSignals;
  const sources = new SourceRegistry();
  const contextTokenTarget = dependencies.contextTokenTarget ?? 24_000;
  const writeAttempts: WriteAttemptReceipt[] = [];
  const replayBoundary = { crossed: false };
  const stepBudget: StepBudget = createStepBudget(dependencies.maxSteps);

  let run: { id: string };
  try {
    run = await withAbort(
      () => dependencies.agentRunStore.start({
        eventId: dependencies.eventId,
        claimAttempt: dependencies.claimAttempt,
        model: dependencies.modelName,
      }),
      runSignal,
      (lateRun) => withAuditFinalization(() => dependencies.agentRunStore.finish(lateRun.id, {
        toolCallCount: 0,
        outcome: 'aborted',
      })),
    );
  } catch {
    abortSignals.dispose();
    throw new Error(AGENT_AUDIT_UNAVAILABLE);
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let toolCallCount = 0;
  let outcome: Exclude<AgentRunOutcome, 'running'> = 'failed';

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
    const retainedHistoryBeforeInvocation = storedHistory
      .filter((message) => message.messageId !== dependencies.triggerMessageId)
      .map(({ role, content }) => ({ role, content }));
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

    const teamContext = dependencies.teamContextSource
      ? await withAbort(() => dependencies.teamContextSource!.load(runSignal), runSignal)
      : undefined;
    if (teamContext) {
      try {
        await withAbort(
          () => dependencies.agentRunStore.recordTeamContext(run.id, teamContext),
          runSignal,
        );
      } catch (error) {
        if (runSignal.aborted) throw error;
        throw new Error(AGENT_AUDIT_UNAVAILABLE);
      }
    }

    let groupReader: ScopedGroupContextReader | undefined;
    let initialGroupContext: InitialGroupContext | undefined;
    if (input.trigger.chatType === 'group') {
      const cutoff = new Date(input.trigger.occurredAt);
      if (dependencies.groupContextSource) {
        try {
          groupReader = dependencies.groupContextSource.open({
            chatId: input.trigger.chatId,
            cutoff,
            triggerMessageId: dependencies.triggerMessageId,
            currentSenderOpenId: input.trigger.senderOpenId,
            botOpenId: dependencies.botOpenId,
            botAppId: dependencies.botAppId,
          });
          initialGroupContext = await withAbort(
            () => groupReader!.loadInitial(runSignal),
            runSignal,
          );
        } catch (error) {
          if (runSignal.aborted) throw error;
          groupReader = undefined;
          initialGroupContext = unavailableGroupContext(cutoff);
        }
      } else {
        initialGroupContext = unavailableGroupContext(cutoff);
      }
      try {
        await withAbort(
          () => dependencies.agentRunStore.recordGroupHistory(
            run.id,
            initialGroupContext!.audit,
          ),
          runSignal,
        );
      } catch (error) {
        if (runSignal.aborted) throw error;
        throw new Error(AGENT_AUDIT_UNAVAILABLE);
      }
    }

    const recordGroupHistory = async (audit: GroupHistoryAudit) => {
      try {
        await withAbort(
          () => dependencies.agentRunStore.recordGroupHistory(run.id, audit),
          runSignal,
        );
      } catch (error) {
        if (runSignal.aborted) throw error;
        throw new Error(AGENT_AUDIT_UNAVAILABLE);
      }
    };
    const agent = createTeamAgentWithBudget({
      model: dependencies.model,
      service: dependencies.service,
      sources,
      writeAudit: createWriteAudit(
        dependencies.agentRunStore,
        run.id,
        runSignal,
        writeAttempts,
        replayBoundary,
      ),
      history: {
        search: (query, limit) => dependencies.conversationStore.search(
          dependencies.conversationKey,
          query,
          limit,
        ),
      },
      ...(groupReader ? {
        groupHistory: { reader: groupReader, recordAudit: recordGroupHistory },
      } : {}),
      ...(dependencies.teamContextSource && teamContext ? {
        teamContext: {
          source: dependencies.teamContextSource,
          current: teamContext,
          allowMutation: true,
        },
      } : {}),
    }, stepBudget);
    const history = new DefaultContextAssembler().assemble({
      ...(teamContext ? { teamContext } : {}),
      conversation: input.trigger.chatType === 'group'
        ? [
          ...(initialGroupContext!.audit.status === 'unavailable'
            ? retainedHistoryBeforeInvocation
            : []),
          ...groupModelMessages(initialGroupContext!),
        ]
        : retainedHistoryBeforeInvocation,
      currentInvocation: {
        speakerName: input.trigger.chatType === 'group'
          ? initialGroupContext!.currentSenderName
          : '成员',
        text: input.prompt,
      },
      conversationTokenTarget: contextTokenTarget,
    });
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
    if (stepBudget.exhausted()) {
      outcome = 'step_limit_reached';
      return {
        ...sources.finalize(budgetExhaustedText(outcome, writeAttempts)),
        usage: {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        },
        outcome,
        writeAttempts,
      };
    }
    const finalized = sources.finalize(result.text);
    outcome = 'completed';
    return {
      ...finalized,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
      outcome,
      writeAttempts,
    };
  } catch (error) {
    if (abortSignals.firstAbortSource() === 'timeout') {
      outcome = 'timeout_reached';
      return {
        ...sources.finalize(budgetExhaustedText(outcome, writeAttempts)),
        usage: {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        },
        outcome,
        writeAttempts,
      };
    }
    if (replayBoundary.crossed) {
      outcome = 'interrupted_after_write';
      return {
        ...sources.finalize(interruptedAfterWriteText(writeAttempts)),
        usage: {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        },
        outcome,
        writeAttempts,
      };
    }
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
    } finally {
      abortSignals.dispose();
    }
  }
}
