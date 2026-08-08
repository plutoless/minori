import type { AgentReply } from '../agent/run.js';
import { normalizeAgentSource, type AgentSource } from '../agent/sources.js';

export function formatAgentReply(reply: AgentReply): string {
  const sources: AgentSource[] = [];
  const seenUrls = new Set<string>();
  for (const rawSource of reply.sources) {
    const source = normalizeAgentSource(rawSource);
    if (!source || seenUrls.has(source.url)) continue;
    seenUrls.add(source.url);
    sources.push(source);
  }
  if (sources.length === 0) return reply.text;

  const sourceLines = sources.map((source, index) =>
    `[${index + 1}] ${source.title} — ${source.url}`);
  return `${reply.text}\n\nSources:\n${sourceLines.join('\n')}`;
}
