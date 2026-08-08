import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeService } from '../../src/lark/knowledge-service.js';
import { createKnowledgeTools } from '../../src/agent/tools.js';
import { SourceRegistry } from '../../src/agent/sources.js';

function service(): KnowledgeService {
  return {
    search: vi.fn().mockResolvedValue([]),
    fetchDocument: vi.fn().mockResolvedValue({
      token: 'doxcnRoadmap', title: 'Roadmap',
      url: 'https://acme.feishu.cn/docx/roadmap', markdown: '# Roadmap', revisionId: 3,
    }),
    listSpaces: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn().mockResolvedValue({
      nodeToken: 'wikcn1', objToken: 'doxcn1', objType: 'docx', title: 'Roadmap',
    }),
    createDocument: vi.fn().mockResolvedValue({
      operation: 'create', token: 'doxcnCreated', title: 'Created plan',
      url: 'https://acme.feishu.cn/docx/created', revisionId: 1,
    }),
    appendDocument: vi.fn().mockResolvedValue({
      operation: 'append', token: 'doxcnRoadmap', title: 'Roadmap',
      url: 'https://acme.feishu.cn/docx/roadmap', revisionId: 4,
    }),
    patchDocument: vi.fn().mockResolvedValue({
      operation: 'patch', token: 'doxcnRoadmap', title: 'Roadmap',
      url: 'https://acme.feishu.cn/docx/roadmap', revisionId: 4,
    }),
  };
}

describe('createKnowledgeTools', () => {
  it('exposes exactly the approved reversible knowledge authority', () => {
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    );

    expect(Object.keys(tools)).toEqual([
      'searchKnowledge',
      'fetchDocument',
      'listKnowledgeSpaces',
      'listKnowledgeNodes',
      'getKnowledgeNode',
      'createDocument',
      'appendDocument',
      'patchDocument',
      'searchConversationHistory',
    ]);
    expect(Object.keys(tools).join(' ')).not.toMatch(
      /delete|move|overwrite|permission|sharing|shell|http|filesystem|raw/iu,
    );
    const fetchSchema = tools.fetchDocument.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(fetchSchema.safeParse({
      doc: 'https://evil.example/arbitrary/path', mode: 'full',
    }).success).toBe(false);
    expect(fetchSchema.safeParse({ doc: 'doxcnApproved_1', mode: 'full' }).success).toBe(true);
  });

  it('creates a document through a strict audited tool and returns its canonical receipt', async () => {
    const knowledge = service();
    const audited: unknown[] = [];
    const tools = createKnowledgeTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      {
        run: async (input, operation) => {
          audited.push(input);
          return operation();
        },
      },
    );
    const schema = tools.createDocument.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse({ title: 'Plan', content: '# Plan' }).success).toBe(true);
    expect(schema.safeParse({
      title: 'Plan', content: '# Plan', rawCommand: 'docs delete --all',
    }).success).toBe(false);

    await expect(tools.createDocument.execute?.(
      { title: 'Plan', content: '# Plan', parentToken: 'fldcnParent' },
      { toolCallId: 'call_create', messages: [] },
    )).resolves.toEqual({
      url: 'https://acme.feishu.cn/docx/created',
      receipt: 'Created "Created plan" (revision 1).',
    });
    expect(knowledge.createDocument).toHaveBeenCalledWith(
      { title: 'Plan', content: '# Plan', parentToken: 'fldcnParent' },
      undefined,
    );
    expect(audited).toEqual([{
      toolName: 'createDocument',
      targetIdentifiers: { parentToken: 'fldcnParent' },
      sanitizedSummary: 'created one document',
    }]);
  });

  it('exposes only strict append and exact-patch inputs with concise receipts', async () => {
    const knowledge = service();
    const tools = createKnowledgeTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    );
    const appendSchema = tools.appendDocument.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const patchSchema = tools.patchDocument.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(appendSchema.safeParse({ doc: 'doxcnRoadmap', content: 'Next.' }).success)
      .toBe(true);
    expect(appendSchema.safeParse({
      doc: 'doxcnRoadmap', content: 'Next.', overwrite: true,
    }).success).toBe(false);
    expect(patchSchema.safeParse({
      doc: 'doxcnRoadmap', pattern: 'Old', replacement: 'New',
    }).success).toBe(true);
    expect(patchSchema.safeParse({
      doc: 'doxcnRoadmap', pattern: 'Old', replacement: 'New', deleteDocument: true,
    }).success).toBe(false);

    await expect(tools.appendDocument.execute?.(
      { doc: 'doxcnRoadmap', content: 'Next.' },
      { toolCallId: 'call_append', messages: [] },
    )).resolves.toEqual({
      url: 'https://acme.feishu.cn/docx/roadmap',
      receipt: 'Appended to "Roadmap" (revision 4).',
    });
    await expect(tools.patchDocument.execute?.(
      { doc: 'doxcnRoadmap', pattern: 'Old', replacement: 'New' },
      { toolCallId: 'call_patch', messages: [] },
    )).resolves.toEqual({
      url: 'https://acme.feishu.cn/docx/roadmap',
      receipt: 'Patched "Roadmap" (revision 4).',
    });
  });

  it('binds history to the current conversation and accepts only query and limit', async () => {
    const search = vi.fn().mockResolvedValue([{
      messageId: 'om_old', role: 'user', excerpt: 'launch was Friday',
      createdAt: new Date('2026-07-31T12:00:00Z'),
    }]);
    const tools = createKnowledgeTools(
      service(), { search }, new SourceRegistry(), { run: (_input, operation) => operation() },
    );
    const schema = tools.searchConversationHistory.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse({ query: 'launch', limit: 5 }).success).toBe(true);
    expect(schema.safeParse({ query: 'launch', limit: 5, chatId: 'other' }).success).toBe(false);
    expect(schema.safeParse({ query: 'launch', conversationKey: 'other' }).success).toBe(false);
    expect(schema.safeParse({ query: 'launch', rawSql: 'select *' }).success).toBe(false);

    await tools.searchConversationHistory.execute?.(
      { query: 'launch', limit: 5 },
      { toolCallId: 'call_1', messages: [] },
    );
    expect(search).toHaveBeenCalledWith('launch', 5);
  });

  it('returns bounded relevant document pages, source metadata, and cached continuation', async () => {
    const knowledge = service();
    const longSection = 'Beta launch evidence. '.repeat(900);
    knowledge.fetchDocument = vi.fn().mockResolvedValue({
      title: 'Launch plan',
      url: 'https://acme.feishu.cn/docx/launch',
      markdown: `# Overview\nGeneral context.\n## Beta\n${longSection}\n## Appendix\nOlder notes.`,
    });
    const sources = new SourceRegistry();
    const tools = createKnowledgeTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      sources,
      { run: (_input, operation) => operation() },
    );

    const first = await tools.fetchDocument.execute?.(
      { doc: 'doxcnLaunch', mode: 'relevant', query: 'beta launch' },
      { toolCallId: 'call_1', messages: [] },
    );
    expect(first).toMatchObject({
      source: {
        id: 1,
        title: 'Launch plan',
        url: 'https://acme.feishu.cn/docx/launch',
        truncated: true,
      },
    });
    expect(first?.markdown).toContain('Beta launch evidence');
    expect(first?.markdown.length).toBeLessThanOrEqual(12_000);
    expect(first?.source.nextCursor).toEqual(expect.any(String));

    const second = await tools.fetchDocument.execute?.(
      {
        doc: 'doxcnLaunch', mode: 'relevant', query: 'beta launch',
        cursor: first?.source.nextCursor,
      },
      { toolCallId: 'call_2', messages: [] },
    );
    expect(second?.source.id).toBe(1);
    expect(knowledge.fetchDocument).toHaveBeenCalledTimes(1);
  });

  it('threads the Agent abort signal into Lark reads', async () => {
    const knowledge = service();
    const controller = new AbortController();
    const tools = createKnowledgeTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    );

    await tools.searchKnowledge.execute?.(
      { query: 'roadmap' },
      { toolCallId: 'call_abort', messages: [], abortSignal: controller.signal },
    );
    expect(knowledge.search).toHaveBeenCalledWith({ query: 'roadmap' }, controller.signal);
  });

  it('stops waiting for a stalled history query when the Agent is aborted', async () => {
    const controller = new AbortController();
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn(() => new Promise(() => undefined)) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    );
    const execution = tools.searchConversationHistory.execute?.(
      { query: 'old detail', limit: 5 },
      { toolCallId: 'call_history', messages: [], abortSignal: controller.signal },
    );

    controller.abort(new Error('agent_deadline'));

    await expect(execution).rejects.toThrow('agent_deadline');
  });
});
