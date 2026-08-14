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

export function buildScheduledInvocationPrompt(
  run: Pick<ScheduledRun, 'scheduledFor' | 'instruction'>,
): string {
  return [
    '[Scheduled Task Occurrence]',
    `Scheduled for: ${run.scheduledFor.toISOString()}`,
    'Now execute this already-created Scheduled Task occurrence exactly once.',
    'Use scheduled_for to interpret relative dates and cycles, even during catch-up.',
    'Schedule or recurrence wording in the frozen instruction describes the existing task; it is not a request to create or change Scheduled Tasks.',
    'This occurrence must not create or change Scheduled Tasks.',
    '',
    '[Frozen Scheduled Task Instruction]',
    run.instruction,
    '[/Frozen Scheduled Task Instruction]',
  ].join('\n');
}

export function createAgentInvocationRunner(): AgentInvocationRunner {
  return {
    async runScheduled(run, dependencies, signal) {
      const triggerMessageId = `scheduled:${run.id}`;
      const prompt = buildScheduledInvocationPrompt(run);
      const history: AgentHistoryMessage[] = [{ role: 'user', content: prompt }];
      return runKnowledgeAgent({
        prompt,
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
            content: prompt,
            createdAt: run.scheduledFor,
          }],
          search: async () => [],
        },
      }, signal);
    },
  };
}
