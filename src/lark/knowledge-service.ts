import { z } from 'zod';
import {
  KnowledgeSearchContractError,
  KnowledgeWriteConflict,
  LarkCliError,
  LarkContractError,
} from './errors.js';
import type { LarkExecutor } from './runner.js';

export type KnowledgeSearchResult = {
  title: string;
  url?: string;
  token: string;
  type: string;
};

export type KnowledgeSearchResultSet = {
  status: 'complete' | 'partial';
  results: KnowledgeSearchResult[];
  rawCount: number;
  validCount: number;
  omittedCount: number;
};

export interface KnowledgeReader {
  search(input: { query: string; spaceIds?: string[] }, signal?: AbortSignal): Promise<KnowledgeSearchResultSet>;
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
    expectedRevision?: number;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult>;
}

const driveSearchSchema = z.object({
  results: z.array(z.unknown()),
}).passthrough();

const driveSearchRowSchema = z.object({
  entity_type: z.string().min(1),
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
    document_id: z.string().optional(),
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

export function validateKnowledgeCommandResult(
  command: 'drive.search' | 'docs.fetch' | 'docs.create' | 'docs.append' | 'docs.patch'
    | 'wiki.spaceList' | 'wiki.nodeList' | 'wiki.nodeGet',
  data: unknown,
) {
  switch (command) {
    case 'drive.search': return parseContract(driveSearchSchema, data);
    case 'docs.fetch': return parseContract(documentSchema, data);
    case 'docs.create': {
      const result = parseContract(writeResultSchema, data);
      if (!result.document.document_id) throw new LarkContractError();
      return result;
    }
    case 'docs.append':
    case 'docs.patch': return parseContract(writeResultSchema, data);
    case 'wiki.spaceList': return parseContract(spaceListSchema, data);
    case 'wiki.nodeList': return parseContract(nodeListSchema, data);
    case 'wiki.nodeGet': return parseContract(nodeSchema, data);
  }
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

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function httpUrl(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
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
  if (error.details.upstreamCode === 177003) return true;
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
  ): Promise<KnowledgeSearchResultSet> {
    const data = await this.run<unknown>({
      id: 'drive.search',
      query: input.query,
      ...(input.spaceIds ? { spaceIds: input.spaceIds } : {}),
    }, signal);
    const parsed = parseContract(driveSearchSchema, data);
    const results = parsed.results.flatMap((raw): KnowledgeSearchResult[] => {
      const row = driveSearchRowSchema.safeParse(raw);
      if (!row.success) return [];
      const resultMeta = objectValue(row.data.result_meta);
      const token = nonEmptyString(resultMeta?.token) ?? nonEmptyString(row.data.entity_id);
      if (!token) return [];
      const url = httpUrl(resultMeta?.url);
      return [{
        title: searchResultTitle(
          nonEmptyString(row.data.title),
          nonEmptyString(row.data.title_highlighted),
          token,
        ),
        ...(url ? { url } : {}),
        token,
        type: row.data.entity_type,
      }];
    });
    const rawCount = parsed.results.length;
    const omittedCount = rawCount - results.length;
    if (rawCount > 0 && results.length === 0) {
      throw new KnowledgeSearchContractError({
        rawCount,
        validCount: 0,
        omittedCount,
      });
    }
    return {
      status: omittedCount === 0 ? 'complete' : 'partial',
      results,
      rawCount,
      validCount: results.length,
      omittedCount,
    };
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
    acceptedRevisionId: number,
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const document = await this.fetchDocument({ doc: token }, signal);
    if (document.token !== token || document.revisionId < acceptedRevisionId) {
      throw new LarkContractError();
    }
    return {
      operation,
      token: document.token,
      title: document.title,
      url: document.url,
      revisionId: document.revisionId,
    };
  }

  private validateWriteResponse(
    result: { document_id?: string | undefined; revision_id: number },
    token: string,
    previousRevisionId: number,
  ) {
    if ((result.document_id !== undefined && result.document_id !== token)
      || result.revision_id <= previousRevisionId) {
      throw new LarkContractError();
    }
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
    if (!result.document_id) throw new LarkContractError();
    return this.writeResult('create', result.document_id, result.revision_id, signal);
  }

  async appendDocument(
    input: { doc: string; content: string },
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    const result = await this.requireWriteResponse({
      id: 'docs.append', doc: current.token, content: input.content, revisionId: current.revisionId,
    }, signal);
    this.validateWriteResponse(result, current.token, current.revisionId);
    return this.writeResult('append', current.token, result.revision_id, signal);
  }

  async patchDocument(
    input: { doc: string; pattern: string; replacement: string; expectedRevision?: number },
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    if (input.expectedRevision !== undefined && current.revisionId !== input.expectedRevision) {
      throw new KnowledgeWriteConflict();
    }
    if (countExactOccurrences(current.markdown, input.pattern) !== 1) {
      throw new KnowledgeWriteConflict();
    }
    const result = await this.requireWriteResponse({
      id: 'docs.patch',
      doc: current.token,
      pattern: input.pattern,
      content: input.replacement,
      revisionId: current.revisionId,
    }, signal);
    this.validateWriteResponse(result, current.token, current.revisionId);
    return this.writeResult('patch', current.token, result.revision_id, signal);
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
