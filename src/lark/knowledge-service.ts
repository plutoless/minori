import { z } from 'zod';
import { KnowledgeWriteConflict, LarkCliError, LarkContractError } from './errors.js';
import type { LarkExecutor } from './runner.js';

export type KnowledgeSearchResult = {
  title: string;
  url: string;
  token: string;
  type: string;
};

export interface KnowledgeReader {
  search(input: { query: string; spaceIds?: string[] }, signal?: AbortSignal): Promise<KnowledgeSearchResult[]>;
  fetchDocument(input: { doc: string }, signal?: AbortSignal): Promise<KnowledgeDocument>;
  listSpaces(signal?: AbortSignal): Promise<Array<{ spaceId: string; name: string }>>;
  listNodes(input: {
    spaceId: string;
    parentNodeToken?: string;
  }, signal?: AbortSignal): Promise<Array<{ nodeToken: string; title: string; objType: string }>>;
  getNode(input: {
    nodeToken: string;
  }, signal?: AbortSignal): Promise<{ nodeToken: string; objToken: string; objType: string; title: string }>;
}

export type KnowledgeDocument = {
  token: string;
  title: string;
  url: string;
  markdown: string;
  revisionId: number;
};

export type KnowledgeWriteResult = {
  operation: 'create' | 'append' | 'patch';
  token: string;
  title: string;
  url: string;
  revisionId: number;
};

export interface KnowledgeService extends KnowledgeReader {
  createDocument(input: {
    title: string;
    content: string;
    parentToken?: string;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult>;
  appendDocument(input: {
    doc: string;
    content: string;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult>;
  patchDocument(input: {
    doc: string;
    pattern: string;
    replacement: string;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult>;
}

const driveSearchSchema = z.object({
  results: z.array(z.object({
    title: z.string().optional(),
    title_highlighted: z.string().optional(),
    entity_type: z.string(),
    entity_id: z.string(),
    result_meta: z.object({ url: z.string().optional() }).passthrough().optional(),
  }).passthrough()),
}).passthrough();

const documentSchema = z.object({
  document: z.object({
    document_id: z.string(),
    revision_id: z.number().int(),
    content: z.string(),
    title: z.string().optional(),
    url: z.string().optional(),
  }).passthrough(),
}).passthrough();

const writeResultSchema = z.object({
  document: z.object({
    document_id: z.string(),
    revision_id: z.number().int(),
  }).passthrough(),
}).passthrough();

const spaceListSchema = z.object({
  spaces: z.array(z.object({
    space_id: z.string(),
    name: z.string(),
  }).passthrough()),
}).passthrough();

const nodeListSchema = z.object({
  nodes: z.array(z.object({
    node_token: z.string(),
    title: z.string(),
    obj_type: z.string(),
  }).passthrough()),
}).passthrough();

const nodeSchema = z.object({
  node_token: z.string(),
  obj_token: z.string(),
  obj_type: z.string(),
  title: z.string(),
}).passthrough();

function parseContract<TSchema extends z.ZodType>(schema: TSchema, data: unknown): z.output<TSchema> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new LarkContractError();
  return parsed.data;
}

function titleFromMarkdown(markdown: string, fallback: string) {
  return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() || fallback;
}

function searchResultTitle(
  title: string | undefined,
  titleHighlighted: string | undefined,
  fallback: string,
) {
  const highlighted = titleHighlighted?.replace(/<\/?h(?:b)?>/gu, '');
  return title || highlighted || fallback;
}

function countExactOccurrences(markdown: string, pattern: string) {
  if (!pattern) return 0;
  let count = 0;
  let index = 0;
  while (index <= markdown.length - pattern.length) {
    const foundAt = markdown.indexOf(pattern, index);
    if (foundAt === -1) break;
    count += 1;
    index = foundAt + pattern.length;
  }
  return count;
}

function isRevisionConflict(error: unknown) {
  if (!(error instanceof LarkCliError) || error.code !== 'cli_error') return false;
  const details = [error.details.type, error.details.subtype, error.details.upstreamCode]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /revision[ _-]?conflict|conflict[ _-]?revision/iu.test(details);
}

export class LarkKnowledgeService implements KnowledgeService {
  constructor(private readonly executor: LarkExecutor) {}

  private run<T>(command: Parameters<LarkExecutor['run']>[0], signal?: AbortSignal) {
    return signal
      ? this.executor.run<T>(command, signal)
      : this.executor.run<T>(command);
  }

  async search(
    input: { query: string; spaceIds?: string[] },
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult[]> {
    const data = await this.run<unknown>({
      id: 'drive.search',
      query: input.query,
      ...(input.spaceIds ? { spaceIds: input.spaceIds } : {}),
    }, signal);
    const parsed = parseContract(driveSearchSchema, data);
    return parsed.results.flatMap((result) => {
      const url = result.result_meta?.url;
      if (!url) return [];
      return [{
        title: searchResultTitle(result.title, result.title_highlighted, result.entity_id),
        url,
        token: result.entity_id,
        type: result.entity_type,
      }];
    });
  }

  async fetchDocument(input: { doc: string }, signal?: AbortSignal) {
    const data = await this.run<unknown>({ id: 'docs.fetch', doc: input.doc }, signal);
    const { document } = parseContract(documentSchema, data);
    return {
      token: document.document_id,
      title: document.title ?? titleFromMarkdown(document.content, document.document_id),
      url: document.url ?? (
        /^https?:\/\//u.test(input.doc)
          ? input.doc
          : `https://www.feishu.cn/docx/${encodeURIComponent(document.document_id)}`
      ),
      markdown: document.content,
      revisionId: document.revision_id,
    };
  }

  private async requireWriteResponse(
    command: Parameters<LarkExecutor['run']>[0],
    signal?: AbortSignal,
  ) {
    try {
      const data = await this.run<unknown>(command, signal);
      return parseContract(writeResultSchema, data).document;
    } catch (error) {
      if (isRevisionConflict(error)) throw new KnowledgeWriteConflict();
      throw error;
    }
  }

  private async writeResult(
    operation: KnowledgeWriteResult['operation'],
    token: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const document = await this.fetchDocument({ doc: token }, signal);
    return {
      operation,
      token: document.token,
      title: document.title,
      url: document.url,
      revisionId: document.revisionId,
    };
  }

  async createDocument(
    input: { title: string; content: string; parentToken?: string },
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const result = await this.requireWriteResponse({
      id: 'docs.create',
      title: input.title,
      content: input.content,
      ...(input.parentToken ? { parentToken: input.parentToken } : {}),
    }, signal);
    return this.writeResult('create', result.document_id, signal);
  }

  async appendDocument(
    input: { doc: string; content: string },
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    await this.requireWriteResponse({
      id: 'docs.append', doc: current.token, content: input.content, revisionId: current.revisionId,
    }, signal);
    return this.writeResult('append', current.token, signal);
  }

  async patchDocument(
    input: { doc: string; pattern: string; replacement: string },
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    if (countExactOccurrences(current.markdown, input.pattern) !== 1) {
      throw new KnowledgeWriteConflict();
    }
    await this.requireWriteResponse({
      id: 'docs.patch',
      doc: current.token,
      pattern: input.pattern,
      content: input.replacement,
      revisionId: current.revisionId,
    }, signal);
    return this.writeResult('patch', current.token, signal);
  }

  async listSpaces(signal?: AbortSignal) {
    const data = await this.run<unknown>({ id: 'wiki.spaceList' }, signal);
    const parsed = parseContract(spaceListSchema, data);
    return parsed.spaces.map((space) => ({ spaceId: space.space_id, name: space.name }));
  }

  async listNodes(input: { spaceId: string; parentNodeToken?: string }, signal?: AbortSignal) {
    const data = await this.run<unknown>({
      id: 'wiki.nodeList',
      spaceId: input.spaceId,
      ...(input.parentNodeToken ? { parentNodeToken: input.parentNodeToken } : {}),
    }, signal);
    const parsed = parseContract(nodeListSchema, data);
    return parsed.nodes.map((node) => ({
      nodeToken: node.node_token,
      title: node.title,
      objType: node.obj_type,
    }));
  }

  async getNode(input: { nodeToken: string }, signal?: AbortSignal) {
    const data = await this.run<unknown>({
      id: 'wiki.nodeGet', nodeToken: input.nodeToken,
    }, signal);
    const node = parseContract(nodeSchema, data);
    return {
      nodeToken: node.node_token,
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title,
    };
  }
}
