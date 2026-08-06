import type { AgentReply } from '../agent/run.js';
import type { AgentSource } from '../agent/sources.js';

export class CitationFormatError extends Error {
  constructor() {
    super('citation_format_invalid');
    this.name = 'CitationFormatError';
  }
}

type Citation = { id: number; start: number; end: number };

function citations(text: string): Citation[] {
  const mask = (value: string) => value.replace(/[^\n]/gu, ' ');
  const visible = text
    .replace(/```[\s\S]*?```/gu, mask)
    .replace(/`[^`\n]*`/gu, mask)
    .replace(/^>.*$/gmu, mask);
  return [...visible.matchAll(/(?<![\p{L}\p{N}_^])\[(\d+)\](?!\s*(?:\(|:))/gu)]
    .map((match) => ({
      id: Number(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    }));
}

function normalizedSource(source: AgentSource): AgentSource {
  if (!Number.isSafeInteger(source.id) || source.id <= 0 || source.title.trim().length === 0) {
    throw new CitationFormatError();
  }
  if (/[\u0000-\u0020\u007f]/u.test(source.url)) throw new CitationFormatError();
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new CitationFormatError();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CitationFormatError();
  const title = source.title
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (title.length === 0) throw new CitationFormatError();
  return { id: source.id, title, url: url.href };
}

export function formatAgentReply(reply: AgentReply): string {
  if (reply.citationContractValid === false) throw new CitationFormatError();
  const occurrences = citations(reply.text);
  if (reply.sources.length === 0) {
    if (occurrences.length > 0) throw new CitationFormatError();
    return reply.text;
  }

  const byId = new Map<number, AgentSource>();
  for (const rawSource of reply.sources) {
    const source = normalizedSource(rawSource);
    if (byId.has(source.id)) throw new CitationFormatError();
    byId.set(source.id, source);
  }

  const sourceUrls = new Set<string>();
  for (const source of byId.values()) {
    sourceUrls.add(source.url);
  }
  const ordered: AgentSource[] = [];
  const normalizedByUrl = new Map<string, number>();
  for (const occurrence of occurrences) {
    const source = byId.get(occurrence.id);
    if (!source) throw new CitationFormatError();
    if (!normalizedByUrl.has(source.url)) {
      normalizedByUrl.set(source.url, ordered.length + 1);
      ordered.push(source);
    }
  }
  if (ordered.length !== sourceUrls.size) throw new CitationFormatError();

  let rewritten = '';
  let position = 0;
  for (const occurrence of occurrences) {
    const source = byId.get(occurrence.id)!;
    rewritten += `${reply.text.slice(position, occurrence.start)}[${normalizedByUrl.get(source.url)}]`;
    position = occurrence.end;
  }
  rewritten += reply.text.slice(position);

  const sourceLines = ordered.map((source, index) =>
    `[${index + 1}] ${source.title.trim()} — ${source.url}`);
  return `${rewritten}\n\nSources:\n${sourceLines.join('\n')}`;
}
