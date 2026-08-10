import type { ScheduledRun } from '../schedule/types.js';
import type { AgentHistoryMessage } from './context-window.js';
import {
  runKnowledgeAgent,
  type AgentReply,
  type RunKnowledgeAgentDependencies,
} from './run.js';

export type ScheduledInvocationDependencies = Omit<
  RunKnowledgeAgentDependencies,
  | 'eventId' | 'claimAttempt' | 'conversationKey' | 'triggerMessageId'
  | 'conversationStore' | 'scheduleTools' | 'invocationSource'
>;

export interface AgentInvocationRunner {
  runScheduled(
    run: ScheduledRun,
    dependencies: ScheduledInvocationDependencies,
    signal?: AbortSignal,
  ): Promise<AgentReply>;
}

export function createAgentInvocationRunner(): AgentInvocationRunner {
  return {
    async runScheduled(run, dependencies, signal) {
      const triggerMessageId = `scheduled:${run.id}`;
      const history: AgentHistoryMessage[] = [{ role: 'user', content: run.instruction }];
      return runKnowledgeAgent({
        prompt: run.instruction,
        history,
        trigger: {
          kind: 'scheduled_task',
          scheduledRunId: run.id,
          chatId: run.scheduledContext?.chatId ?? run.resultTarget.chatId,
          chatType: run.scheduledContext ? 'group' : 'p2p',
          occurredAt: run.scheduledFor,
        },
      }, {
        ...dependencies,
        eventId: triggerMessageId,
        claimAttempt: run.claimAttempt,
        conversationKey: `scheduled:${run.resultTarget.chatId}`,
        triggerMessageId,
        invocationSource: {
          kind: 'scheduled',
          scheduledRunId: run.id,
          claimAttempt: run.claimAttempt,
        },
        conversationStore: {
          recentWithinBudget: async () => [{
            messageId: triggerMessageId,
            conversationId: run.id,
            role: 'user' as const,
            content: run.instruction,
            createdAt: run.scheduledFor,
          }],
          search: async () => [],
        },
      }, signal);
    },
  };
}
