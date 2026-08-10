import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeService } from '../../src/lark/knowledge-service.js';
import { createKnowledgeTools } from '../../src/agent/tools.js';
import { SourceRegistry } from '../../src/agent/sources.js';
import type {
  GroupHistoryAudit,
  ScopedGroupContextReader,
} from '../../src/feishu/group-context.js';

const BASE_TOOL_NAMES = [
  'searchKnowledge',
  'fetchDocument',
  'listKnowledgeSpaces',
  'listKnowledgeNodes',
  'getKnowledgeNode',
  'createDocument',
  'appendDocument',
  'patchDocument',
  'searchConversationHistory',
] as const;
const FORBIDDEN_TOOL_AUTHORITY =
  /delete|rename|move|trash|overwrite|permission|sharing|shell|http|filesystem|raw/iu;

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
  it('adds only the configured Team Context mutation tool for member-triggered runs', async () => {
    const update = vi.fn().mockResolvedValue({
      operation: 'patch' as const,
      token: 'dox_team', title: 'Team Context',
      url: 'https://acme.feishu.cn/docx/dox_team', revisionId: 8,
    });
    const audited: unknown[] = [];
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      {
        run: async (input, operation) => {
          audited.push(input);
          return operation();
        },
      },
      undefined,
      {
        source: { documentToken: 'dox_team', load: vi.fn(), update },
        current: {
          status: 'loaded', content: '# Team Context\n', sourceRevision: 7,
          estimatedTokens: 4, fetchedAt: new Date('2026-08-10T09:00:00Z'),
        },
        allowMutation: true,
      },
    );

    expect(tools).toHaveProperty('updateTeamContext');
    const schema = tools.updateTeamContext!.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const input = {
      expectedRevision: 7,
      pattern: 'Old rule',
      replacement: 'New rule',
      reason: 'correction' as const,
      semanticChangeApproved: true,
    };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, documentToken: 'dox_other' }).success).toBe(false);

    await expect(tools.updateTeamContext!.execute?.(
      input,
      { toolCallId: 'call_context', messages: [] },
    )).resolves.toEqual({
      status: 'updated', documentToken: 'dox_team', revisionId: '8',
      summary: 'Updated Team Context',
    });
    expect(update).toHaveBeenCalledWith({
      expectedRevision: 7,
      pattern: 'Old rule',
      replacement: 'New rule',
      semanticChangeApproved: true,
    }, undefined);
    expect(audited).toEqual([{
      toolName: 'updateTeamContext',
      targetIdentifiers: { documentToken: 'dox_team' },
      sanitizedSummary: 'updated Team Context',
    }]);

    const scheduledTools = createKnowledgeTools(
      service(), { search: vi.fn().mockResolvedValue([]) }, new SourceRegistry(),
      { run: (_input, operation) => operation() }, undefined,
      {
        source: { documentToken: 'dox_team', load: vi.fn(), update },
        current: { status: 'unavailable', errorCategory: 'team_context_unavailable' },
        allowMutation: false,
      },
    );
    expect(scheduledTools).not.toHaveProperty('updateTeamContext');
  });

  it('exposes the Initial Typed Write Set, knowledge reads, and retained history in p2p', () => {
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    );

    expect(Object.keys(tools)).toEqual(BASE_TOOL_NAMES);
    expect(Object.keys(tools).join(' ')).not.toMatch(FORBIDDEN_TOOL_AUTHORITY);
    expect(tools).not.toHaveProperty('readEarlierGroupHistory');
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
    const auditedResults: unknown[] = [];
    const tools = createKnowledgeTools(
      knowledge,
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      {
        run: async (input, operation) => {
          audited.push(input);
          const result = await operation();
          auditedResults.push(result);
          return result;
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
    expect(auditedResults).toEqual([{
      operation: 'create',
      token: 'doxcnCreated',
      title: 'Created plan',
      url: 'https://acme.feishu.cn/docx/created',
      revisionId: 1,
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

  it('adds only a scoped, strict, audited earlier-group-history reader for group runs', async () => {
    const audit: GroupHistoryAudit = {
      status: 'loaded', messageCount: 22, pageCallCount: 2,
      cutoff: new Date('2026-08-08T10:00:00.000Z'),
    };
    const reader: ScopedGroupContextReader = {
      loadInitial: vi.fn(),
      readEarlier: vi.fn().mockResolvedValue({
        messages: [
          {
            speakerName: 'Alice', role: 'user', content: 'Earlier decision.',
            occurredAt: new Date('2026-08-08T09:00:00.000Z'),
          },
          {
            speakerName: 'Bob', role: 'user', content: '[未读取：image 消息]',
            occurredAt: new Date('2026-08-08T09:01:00.000Z'),
          },
        ],
        nextCursor: 'group_cursor_2',
        audit,
      }),
    };
    const recordAudit = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
      { reader, recordAudit },
    );
    const groupTool = tools.readEarlierGroupHistory;
    expect(groupTool).toBeDefined();
    expect(Object.keys(tools)).toEqual([...BASE_TOOL_NAMES, 'readEarlierGroupHistory']);
    expect(Object.keys(tools).join(' ')).not.toMatch(FORBIDDEN_TOOL_AUTHORITY);
    const schema = groupTool!.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse({ limit: 50 }).success).toBe(true);
    expect(schema.safeParse({ cursor: 'group_cursor_1', limit: 20 }).success)
      .toBe(true);
    expect(schema.safeParse({ chatId: 'oc_other', limit: 20 }).success)
      .toBe(false);
    expect(schema.safeParse({ cutoff: '2027-01-01', limit: 20 }).success)
      .toBe(false);

    const result = await groupTool!.execute?.(
      { cursor: 'group_cursor_1', limit: 20 },
      { toolCallId: 'call_group_history', messages: [], abortSignal: controller.signal },
    );

    expect(reader.readEarlier).toHaveBeenCalledWith(
      { cursor: 'group_cursor_1', limit: 20 }, controller.signal,
    );
    expect(recordAudit).toHaveBeenCalledWith(audit);
    expect(result).toEqual({
      status: 'loaded',
      messages: [
        {
          speakerName: 'Alice', role: 'user', content: 'Earlier decision.',
          occurredAt: new Date('2026-08-08T09:00:00.000Z'),
        },
        {
          speakerName: 'Bob', role: 'user', content: '[未读取：image 消息]',
          occurredAt: new Date('2026-08-08T09:01:00.000Z'),
        },
      ],
      nextCursor: 'group_cursor_2',
    });
    expect(JSON.stringify(result)).not.toContain('ou_');
    expect(JSON.stringify(result)).not.toContain('provider_secret_error');
  });

  it('serializes read and audit while rejecting duplicate or reused group-history traversal', async () => {
    const cutoff = new Date('2026-08-08T10:00:00.000Z');
    const activity: string[] = [];
    let expectedCursor: string | undefined;
    let firstRequest = true;
    let page = 1;
    const reader: ScopedGroupContextReader = {
      loadInitial: vi.fn(),
      readEarlier: vi.fn(async (input) => {
        if (firstRequest) {
          if (input.cursor !== undefined) throw new Error('invalid_group_history_cursor');
          firstRequest = false;
        } else if (input.cursor !== expectedCursor) {
          activity.push('read:invalid');
          throw new Error('invalid_group_history_cursor');
        }
        const currentPage = page;
        expectedCursor = `group_cursor_${currentPage}`;
        activity.push(`read:${currentPage}`);
        await Promise.resolve();
        page += 1;
        return {
          messages: [{
            speakerName: `Member ${currentPage}`,
            role: 'user' as const,
            content: `Older page ${currentPage}`,
            occurredAt: new Date(`2026-08-08T0${currentPage}:00:00.000Z`),
          }],
          nextCursor: expectedCursor,
          audit: {
            status: 'loaded' as const,
            messageCount: page,
            pageCallCount: page,
            cutoff,
          },
        };
      }),
    };
    const recordAudit = vi.fn(async (audit: GroupHistoryAudit) => {
      activity.push(`audit:${audit.pageCallCount}`);
    });
    const tools = createKnowledgeTools(
      service(),
      { search: vi.fn().mockResolvedValue([]) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
      { reader, recordAudit },
    );

    const [first, duplicate] = await Promise.allSettled([
      tools.readEarlierGroupHistory!.execute?.(
        { limit: 20 }, { toolCallId: 'call_page_1', messages: [] },
      ),
      tools.readEarlierGroupHistory!.execute?.(
        { limit: 20 }, { toolCallId: 'call_page_2', messages: [] },
      ),
    ]);

    expect(first).toMatchObject({ status: 'fulfilled' });
    expect(first.status === 'fulfilled' ? first.value?.messages : undefined).toEqual([
      expect.objectContaining({ content: 'Older page 1' }),
    ]);
    expect(duplicate).toMatchObject({
      status: 'rejected', reason: expect.objectContaining({ message: 'invalid_group_history_cursor' }),
    });
    const next = await tools.readEarlierGroupHistory!.execute?.(
      { cursor: 'group_cursor_1', limit: 20 },
      { toolCallId: 'call_page_3', messages: [] },
    );
    await expect(tools.readEarlierGroupHistory!.execute?.(
      { cursor: 'group_cursor_1', limit: 20 },
      { toolCallId: 'call_page_4', messages: [] },
    )).rejects.toThrow('invalid_group_history_cursor');
    expect(next?.messages).toEqual([
      expect.objectContaining({ content: 'Older page 2' }),
    ]);
    expect(recordAudit.mock.calls.map(([audit]) => ({
      messageCount: audit.messageCount,
      pageCallCount: audit.pageCallCount,
    }))).toEqual([
      { messageCount: 2, pageCallCount: 2 },
      { messageCount: 3, pageCallCount: 3 },
    ]);
    expect(activity).toEqual([
      'read:1', 'audit:2', 'read:invalid',
      'read:2', 'audit:3', 'read:invalid',
    ]);
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
