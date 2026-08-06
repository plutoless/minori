import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeReader } from '../../src/lark/read-service.js';
import { createReadTools } from '../../src/agent/tools.js';
import { SourceRegistry } from '../../src/agent/sources.js';

function reader(): KnowledgeReader {
  return {
    search: vi.fn().mockResolvedValue([]),
    fetchDocument: vi.fn().mockResolvedValue({
      title: 'Roadmap', url: 'https://acme.feishu.cn/docx/roadmap', markdown: '# Roadmap',
    }),
    listSpaces: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn().mockResolvedValue({
      nodeToken: 'wikcn1', objToken: 'doxcn1', objType: 'docx', title: 'Roadmap',
    }),
  };
}

describe('createReadTools', () => {
  it('exposes exactly the approved read-only authority', () => {
    const tools = createReadTools(reader(), { search: vi.fn().mockResolvedValue([]) });

    expect(Object.keys(tools).sort()).toEqual([
      'fetchDocument',
      'getKnowledgeNode',
      'listKnowledgeNodes',
      'listKnowledgeSpaces',
      'searchConversationHistory',
      'searchKnowledge',
    ]);
    expect(Object.keys(tools).join(' ')).not.toMatch(
      /create|update|delete|move|permission|shell|http|file/iu,
    );
    const fetchSchema = tools.fetchDocument.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(fetchSchema.safeParse({
      doc: 'https://evil.example/arbitrary/path', mode: 'full',
    }).success).toBe(false);
    expect(fetchSchema.safeParse({ doc: 'doxcnApproved_1', mode: 'full' }).success).toBe(true);
  });

  it('binds history to the current conversation and accepts only query and limit', async () => {
    const search = vi.fn().mockResolvedValue([{
      messageId: 'om_old', role: 'user', excerpt: 'launch was Friday',
      createdAt: new Date('2026-07-31T12:00:00Z'),
    }]);
    const tools = createReadTools(reader(), { search });
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
    const knowledge = reader();
    const longSection = 'Beta launch evidence. '.repeat(900);
    knowledge.fetchDocument = vi.fn().mockResolvedValue({
      title: 'Launch plan',
      url: 'https://acme.feishu.cn/docx/launch',
      markdown: `# Overview\nGeneral context.\n## Beta\n${longSection}\n## Appendix\nOlder notes.`,
    });
    const sources = new SourceRegistry();
    const tools = createReadTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      sources,
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
    const knowledge = reader();
    const controller = new AbortController();
    const tools = createReadTools(knowledge, { search: vi.fn().mockResolvedValue([]) });

    await tools.searchKnowledge.execute?.(
      { query: 'roadmap' },
      { toolCallId: 'call_abort', messages: [], abortSignal: controller.signal },
    );
    expect(knowledge.search).toHaveBeenCalledWith({ query: 'roadmap' }, controller.signal);
  });

  it('stops waiting for a stalled history query when the Agent is aborted', async () => {
    const controller = new AbortController();
    const tools = createReadTools(reader(), {
      search: vi.fn(() => new Promise(() => undefined)),
    });
    const execution = tools.searchConversationHistory.execute?.(
      { query: 'old detail', limit: 5 },
      { toolCallId: 'call_history', messages: [], abortSignal: controller.signal },
    );

    controller.abort(new Error('agent_deadline'));

    await expect(execution).rejects.toThrow('agent_deadline');
  });
});
