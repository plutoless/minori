import type { TeamContextLoad } from '../team-context/types.js';
import { selectRecentHistory, type AgentHistoryMessage } from './context-window.js';

export type InvocationContext = {
  teamContext?: TeamContextLoad;
  conversation: AgentHistoryMessage[];
  currentInvocation: { speakerName: string; text: string };
  conversationTokenTarget: number;
  estimateTokens?: (text: string) => number;
};

export interface ContextAssembler {
  assemble(input: InvocationContext): AgentHistoryMessage[];
}

function teamContextMessages(context: TeamContextLoad | undefined): AgentHistoryMessage[] {
  if (!context) return [];
  if (context.content && context.sourceRevision !== undefined) {
    const freshness = context.status === 'loaded'
      ? ''
      : context.status === 'over_budget' ? '[Over Budget Fallback]' : '[Stale]';
    const limitation = context.errorCategory
      ? `\n[Context Limitation] ${context.errorCategory}`
      : '';
    return [{
      role: 'user',
      content: `[Team Context]${freshness}[Revision ${context.sourceRevision}]\n${context.content}${limitation}`,
    }];
  }
  return context.errorCategory ? [{
    role: 'user',
    content: `[Team Context][Context Limitation] ${context.errorCategory}`,
  }] : [];
}

export class DefaultContextAssembler implements ContextAssembler {
  assemble(input: InvocationContext): AgentHistoryMessage[] {
    return [
      ...teamContextMessages(input.teamContext),
      ...selectRecentHistory(
        input.conversation,
        input.conversationTokenTarget,
        input.estimateTokens,
      ),
      {
        role: 'user',
        content: `[Current Invocation][${input.currentInvocation.speakerName}] ${input.currentInvocation.text}`,
      },
    ];
  }
}
