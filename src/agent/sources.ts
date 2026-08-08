export type AgentSource = { id: number; title: string; url: string };

function normalizeSourceIdentity(input: { title: string; url: string }) {
  if (/[\u0000-\u0020\u007f]/u.test(input.url)) return undefined;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const title = input.title
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (title.length === 0) return undefined;
  return { title, url: url.href };
}

export function normalizeAgentSource(source: AgentSource): AgentSource | undefined {
  if (!Number.isSafeInteger(source.id) || source.id <= 0) return undefined;
  const normalized = normalizeSourceIdentity(source);
  return normalized ? { id: source.id, ...normalized } : undefined;
}

type CitationOccurrence = { id: number; start: number; end: number };

function maskMarkdownCode(text: string, mask: (value: string) => string) {
  let fence: { character: string; length: number } | undefined;
  return text.split(/(?<=\n)/u).map((line) => {
    const content = line.endsWith('\r\n')
      ? line.slice(0, -2)
      : line.endsWith('\n') ? line.slice(0, -1) : line;
    if (fence) {
      const closingFence = new RegExp(
        `^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`,
        'u',
      );
      const masked = mask(line);
      if (closingFence.test(content)) fence = undefined;
      return masked;
    }

    const openingFence = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (openingFence) {
      const delimiter = openingFence[1]!;
      const info = openingFence[2]!;
      if (!delimiter.startsWith('`') || !info.includes('`')) {
        fence = { character: delimiter[0]!, length: delimiter.length };
        return mask(line);
      }
    }
    return /^(?: {4}|\t)/u.test(content) ? mask(line) : line;
  }).join('');
}

function citationOccurrences(text: string): CitationOccurrence[] {
  // Match UTF-16 code units so removal offsets stay aligned with String.slice/match.index.
  const mask = (value: string) => value.replace(/[^\n]/g, ' ');
  const visibleText = maskMarkdownCode(text, mask)
    .replace(/`[^`\n]*`/gu, mask)
    .replace(/^>.*$/gmu, mask);
  const pattern = /\[(\d+)\](?!\s*(?:\(|:))/gu;
  return [...visibleText.matchAll(pattern)].map((match) => ({
    id: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function stripUnreadMarkers(text: string, validIds: Set<number>) {
  const unread = citationOccurrences(text).filter(({ id }) => !validIds.has(id));
  let rewritten = '';
  let position = 0;
  for (const occurrence of unread) {
    let start = occurrence.start;
    let end = occurrence.end;
    if (start > position && /\s/u.test(text[start - 1]!)) start -= 1;
    else if (/\s/u.test(text[end] ?? '')) end += 1;
    rewritten += text.slice(position, start);
    position = end;
  }
  return rewritten + text.slice(position);
}

export class SourceRegistry {
  private readonly sources: AgentSource[] = [];
  private readonly byUrl = new Map<string, AgentSource>();

  register(input: { title: string; url: string }): AgentSource {
    const normalized = normalizeSourceIdentity(input);
    if (!normalized) throw new Error('invalid_source_metadata');
    const existing = this.byUrl.get(normalized.url);
    if (existing) return existing;
    const source = { id: this.sources.length + 1, ...normalized };
    this.sources.push(source);
    this.byUrl.set(source.url, source);
    return source;
  }

  snapshot(): AgentSource[] {
    return this.sources.map((source) => ({ ...source }));
  }

  finalize(text: string): { text: string; sources: AgentSource[] } {
    const sources = this.snapshot();
    const validIds = new Set(sources.map(({ id }) => id));
    return {
      text: stripUnreadMarkers(text, validIds),
      sources,
    };
  }
}
