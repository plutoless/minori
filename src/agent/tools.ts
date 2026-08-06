import { tool } from 'ai';
import { z } from 'zod';
import type { KnowledgeReader } from '../lark/read-service.js';
import { SourceRegistry } from './sources.js';

export type ScopedHistoryReader = {
  search(query: string, limit: number): Promise<Array<{
    messageId: string;
    role: 'user' | 'assistant';
    excerpt: string;
    createdAt: Date;
  }>>;
};

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const MAX_DOCUMENT_PAGE_CHARS = 12_000;
const TOKEN_SCHEMA = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);

type FetchedDocument = Awaited<ReturnType<KnowledgeReader['fetchDocument']>>;

function splitSections(markdown: string) {
  const sections = markdown.split(/(?=^#{1,6}\s+)/gmu).filter(Boolean);
  return sections.length > 0 ? sections : [markdown];
}

function orderedSections(markdown: string, mode: 'relevant' | 'full', query?: string) {
  const sections = splitSections(markdown);
  if (mode === 'full' || !query?.trim()) return sections;
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const scored = sections.map((section, index) => ({
    index,
    score: terms.reduce(
      (total, term) => total + (section.toLocaleLowerCase().split(term).length - 1),
      0,
    ),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const order: number[] = [];
  for (const item of scored) {
    for (const index of [item.index, item.index - 1, item.index + 1]) {
      if (index >= 0 && index < sections.length && !order.includes(index)) order.push(index);
    }
  }
  return order.map((index) => sections[index]!);
}

function paginate(sections: string[]) {
  const pages: string[] = [];
  let page = '';
  const flush = () => {
    if (page) pages.push(page);
    page = '';
  };
  for (const section of sections) {
    let remaining = section;
    while (remaining.length > 0) {
      const capacity = MAX_DOCUMENT_PAGE_CHARS - page.length;
      if (capacity === 0) flush();
      const take = Math.min(MAX_DOCUMENT_PAGE_CHARS - page.length, remaining.length);
      page += remaining.slice(0, take);
      remaining = remaining.slice(take);
      if (page.length === MAX_DOCUMENT_PAGE_CHARS) flush();
    }
  }
  flush();
  return pages.length > 0 ? pages : [''];
}

export function createReadTools(
  reader: KnowledgeReader,
  history: ScopedHistoryReader,
  sources = new SourceRegistry(),
) {
  const documents = new Map<string, Promise<FetchedDocument>>();
  const pageSets = new Map<string, string[]>();
  const cursors = new Map<string, { key: string; index: number }>();
  let cursorSequence = 0;

  const getDocument = (doc: string, signal?: AbortSignal) => {
    let fetching = documents.get(doc);
    if (!fetching) {
      fetching = reader.fetchDocument({ doc }, signal);
      documents.set(doc, fetching);
    }
    return fetching;
  };

  return {
    searchKnowledge: tool({
      description: 'Search the authorized Feishu knowledge base for relevant documents.',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        spaceIds: z.array(TOKEN_SCHEMA).max(20).optional(),
      }).strict(),
      execute: ({ query, spaceIds }, { abortSignal }) => reader.search({
        query,
        ...(spaceIds ? { spaceIds } : {}),
      }, abortSignal),
    }),
    fetchDocument: tool({
      description: 'Read an authorized Feishu document as bounded markdown evidence.',
      inputSchema: z.object({
        doc: TOKEN_SCHEMA,
        mode: z.enum(['relevant', 'full']),
        query: z.string().min(1).max(500).optional(),
        cursor: z.string().min(1).max(200).optional(),
      }).strict(),
      execute: async ({ doc, mode, query, cursor }, { abortSignal }) => {
        const key = JSON.stringify([doc, mode, query ?? '']);
        let index = 0;
        if (cursor) {
          const continuation = cursors.get(cursor);
          if (!continuation || continuation.key !== key) throw new Error('invalid_document_cursor');
          index = continuation.index;
        }
        const document = await getDocument(doc, abortSignal);
        let pages = pageSets.get(key);
        if (!pages) {
          pages = paginate(orderedSections(document.markdown, mode, query));
          pageSets.set(key, pages);
        }
        const markdown = pages[index];
        if (markdown === undefined) throw new Error('invalid_document_cursor');
        const nextIndex = index + 1;
        let nextCursor: string | undefined;
        if (nextIndex < pages.length) {
          nextCursor = `cursor_${++cursorSequence}`;
          cursors.set(nextCursor, { key, index: nextIndex });
        }
        const source = sources.register({ title: document.title, url: document.url });
        return {
          markdown,
          source: {
            ...source,
            sectionPath: markdown.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim() ?? document.title,
            ...(nextCursor ? { nextCursor } : {}),
            truncated: nextCursor !== undefined,
          },
        };
      },
    }),
    listKnowledgeSpaces: tool({
      description: 'List knowledge spaces visible to the dedicated Feishu user.',
      inputSchema: z.object({}).strict(),
      execute: (_input, { abortSignal }) => reader.listSpaces(abortSignal),
    }),
    listKnowledgeNodes: tool({
      description: 'List nodes in one authorized knowledge space.',
      inputSchema: z.object({
        spaceId: TOKEN_SCHEMA,
        parentNodeToken: TOKEN_SCHEMA.optional(),
      }).strict(),
      execute: ({ spaceId, parentNodeToken }, { abortSignal }) => reader.listNodes({
        spaceId,
        ...(parentNodeToken ? { parentNodeToken } : {}),
      }, abortSignal),
    }),
    getKnowledgeNode: tool({
      description: 'Resolve one authorized knowledge node to its document metadata.',
      inputSchema: z.object({ nodeToken: TOKEN_SCHEMA }).strict(),
      execute: (input, { abortSignal }) => reader.getNode(input, abortSignal),
    }),
    searchConversationHistory: tool({
      description: 'Search older retained messages in this conversation only.',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(20).default(5),
      }).strict(),
      execute: async ({ query, limit }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const messages = await withAbort(history.search(query, limit), abortSignal);
        abortSignal?.throwIfAborted();
        return messages.map((message) => ({
          messageId: message.messageId,
          role: message.role,
          excerpt: message.excerpt,
          createdAt: message.createdAt.toISOString(),
        }));
      },
    }),
  };
}
