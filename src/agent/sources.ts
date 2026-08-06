export type AgentSource = { id: number; title: string; url: string };
export const GENERAL_ANSWER_MARKER = '<!-- minori:general -->';

export class CitationContractError extends Error {
  constructor() {
    super('citation_contract_invalid');
    this.name = 'CitationContractError';
  }
}

type CitationOccurrence = { id: number; start: number; end: number };

function citationOccurrences(text: string): CitationOccurrence[] {
  // Match UTF-16 code units so masked offsets stay aligned with String.slice/match.index.
  const mask = (value: string) => value.replace(/[^\n]/g, ' ');
  const visibleText = text
    .replace(/```[\s\S]*?```/gu, mask)
    .replace(/`[^`\n]*`/gu, mask)
    .replace(/^>.*$/gmu, mask);
  const pattern = /(?<![\p{L}\p{N}_^])\[(\d+)\](?!\s*(?:\(|:))/gu;
  return [...visibleText.matchAll(pattern)].map((match) => ({
    id: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function rewriteCitations(
  text: string,
  occurrences: CitationOccurrence[],
  idMap: Map<number, number>,
) {
  let rewritten = '';
  let position = 0;
  for (const occurrence of occurrences) {
    const normalized = idMap.get(occurrence.id);
    if (!normalized) throw new CitationContractError();
    rewritten += `${text.slice(position, occurrence.start)}[${normalized}]`;
    position = occurrence.end;
  }
  return rewritten + text.slice(position);
}

export class SourceRegistry {
  private readonly sources: AgentSource[] = [];
  private readonly byUrl = new Map<string, AgentSource>();

  register(input: { title: string; url: string }): AgentSource {
    const existing = this.byUrl.get(input.url);
    if (existing) return existing;
    const source = { id: this.sources.length + 1, ...input };
    this.sources.push(source);
    this.byUrl.set(source.url, source);
    return source;
  }

  finalize(text: string): { text: string; sources: AgentSource[] } {
    const occurrences = citationOccurrences(text);
    const citedInOrder = occurrences.map((occurrence) => occurrence.id);
    const uniqueInOrder = [...new Set(citedInOrder)];
    if (this.sources.length === 0) {
      if (uniqueInOrder.length > 0 || !text.includes(GENERAL_ANSWER_MARKER)) {
        throw new CitationContractError();
      }
      return {
        text: text.replace(GENERAL_ANSWER_MARKER, '').trim(),
        sources: [],
      };
    }
    if (text.includes(GENERAL_ANSWER_MARKER)
      || uniqueInOrder.length !== this.sources.length
      || uniqueInOrder.some((id) => !this.sources[id - 1])) {
      throw new CitationContractError();
    }
    if (/^sources?\s*:/imu.test(text)) throw new CitationContractError();
    const idMap = new Map(uniqueInOrder.map((oldId, index) => [oldId, index + 1]));
    const normalizedText = rewriteCitations(text, occurrences, idMap);
    const orderedSources = uniqueInOrder.map((oldId, index) => ({
      ...this.sources[oldId - 1]!,
      id: index + 1,
    }));
    return { text: normalizedText, sources: orderedSources };
  }
}
