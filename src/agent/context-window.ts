import { estimateConversationTokens } from '../storage/conversation-store.js';

export type AgentHistoryMessage = { role: 'user' | 'assistant'; content: string };

export function selectRecentHistory(
  history: AgentHistoryMessage[],
  tokenTarget: number,
  estimateTokens: (text: string) => number = estimateConversationTokens,
): AgentHistoryMessage[] {
  const selected: AgentHistoryMessage[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const tokens = estimateTokens(message.content);
    if (selected.length > 0 && used + tokens > tokenTarget) break;
    selected.push(message);
    used += tokens;
  }
  return selected.reverse();
}
