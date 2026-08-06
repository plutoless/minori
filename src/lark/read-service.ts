import { z } from 'zod';
import { LarkContractError } from './errors.js';
import type { LarkExecutor } from './runner.js';

export type KnowledgeSearchResult = {
  title: string;
  url: string;
  token: string;
  type: string;
};

export interface KnowledgeReader {
  search(input: { query: string; spaceIds?: string[] }): Promise<KnowledgeSearchResult[]>;
  fetchDocument(input: { doc: string }): Promise<{ title: string; url: string; markdown: string }>;
  listSpaces(): Promise<Array<{ spaceId: string; name: string }>>;
  listNodes(input: {
    spaceId: string;
    parentNodeToken?: string;
  }): Promise<Array<{ nodeToken: string; title: string; objType: string }>>;
  getNode(input: {
    nodeToken: string;
  }): Promise<{ nodeToken: string; objToken: string; objType: string; title: string }>;
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
    content: z.string(),
    title: z.string().optional(),
    url: z.string().optional(),
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

export class LarkKnowledgeReader implements KnowledgeReader {
  constructor(private readonly executor: LarkExecutor) {}

  async search(input: { query: string; spaceIds?: string[] }): Promise<KnowledgeSearchResult[]> {
    const data = await this.executor.run<unknown>({
      id: 'drive.search',
      query: input.query,
      ...(input.spaceIds ? { spaceIds: input.spaceIds } : {}),
    });
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

  async fetchDocument(input: { doc: string }) {
    const data = await this.executor.run<unknown>({ id: 'docs.fetch', doc: input.doc });
    const { document } = parseContract(documentSchema, data);
    return {
      title: document.title ?? titleFromMarkdown(document.content, document.document_id),
      url: document.url ?? (
        /^https?:\/\//u.test(input.doc)
          ? input.doc
          : `https://www.feishu.cn/docx/${encodeURIComponent(document.document_id)}`
      ),
      markdown: document.content,
    };
  }

  async listSpaces() {
    const data = await this.executor.run<unknown>({ id: 'wiki.spaceList' });
    const parsed = parseContract(spaceListSchema, data);
    return parsed.spaces.map((space) => ({ spaceId: space.space_id, name: space.name }));
  }

  async listNodes(input: { spaceId: string; parentNodeToken?: string }) {
    const data = await this.executor.run<unknown>({
      id: 'wiki.nodeList',
      spaceId: input.spaceId,
      ...(input.parentNodeToken ? { parentNodeToken: input.parentNodeToken } : {}),
    });
    const parsed = parseContract(nodeListSchema, data);
    return parsed.nodes.map((node) => ({
      nodeToken: node.node_token,
      title: node.title,
      objType: node.obj_type,
    }));
  }

  async getNode(input: { nodeToken: string }) {
    const data = await this.executor.run<unknown>({
      id: 'wiki.nodeGet', nodeToken: input.nodeToken,
    });
    const node = parseContract(nodeSchema, data);
    return {
      nodeToken: node.node_token,
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title,
    };
  }
}
