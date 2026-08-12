import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWriteConflict } from '../../src/lark/errors.js';
import type { KnowledgeService } from '../../src/lark/knowledge-service.js';
import type { MeetingService } from '../../src/lark/meeting-service.js';
import {
  runKnowledgeAgent,
  type AgentRunInput,
  type RunKnowledgeAgentDependencies,
} from '../../src/agent/run.js';
import type {
  GroupContextSource,
  GroupHistoryAudit,
  ScopedGroupContextReader,
} from '../../src/feishu/group-context.js';
import type { AgentRunStore } from '../../src/storage/agent-run-store.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function generated(
  content: LanguageModelV4GenerateResult['content'],
  finish: 'stop' | 'tool-calls',
): LanguageModelV4GenerateResult {
  return { content, finishReason: { unified: finish, raw: finish }, usage, warnings: [] };
}

function service(): KnowledgeService {
  return {
    search: vi.fn().mockResolvedValue({
      status: 'complete',
      results: [{
        title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch',
        token: 'doxcnLaunch', type: 'docx',
      }],
      rawCount: 1,
      validCount: 1,
      omittedCount: 0,
    }),
    fetchDocument: vi.fn().mockResolvedValue({
      token: 'doxcnLaunch',
      title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch',
      markdown: '# Launch\nThe beta launch is Friday.', revisionId: 1,
    }),
    listSpaces: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn(),
    createDocument: vi.fn().mockResolvedValue({
      operation: 'create', token: 'doxcnCreated', title: 'Created plan',
      url: 'https://acme.feishu.cn/docx/created', revisionId: 1,
    }),
    appendDocument: vi.fn().mockResolvedValue({
      operation: 'append', token: 'doxcnLaunch', title: 'Launch plan',
      url: 'https://acme.feishu.cn/docx/launch', revisionId: 2,
    }),
    patchDocument: vi.fn().mockResolvedValue({
      operation: 'patch', token: 'doxcnLaunch', title: 'Launch plan',
      url: 'https://acme.feishu.cn/docx/launch', revisionId: 2,
    }),
  };
}

function meetingService(): MeetingService {
  return {
    resolvePeople: vi.fn().mockResolvedValue([]),
    searchMeetings: vi.fn().mockResolvedValue({
      status: 'complete',
      items: [{
        kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
        start: '2026-08-11T09:00:00Z',
      }],
      rawCount: 1, validCount: 1, omittedCount: 0,
    }),
    getMeetingDetails: vi.fn().mockResolvedValue([]),
    searchMinutes: vi.fn().mockResolvedValue({
      status: 'complete', items: [], rawCount: 0, validCount: 0, omittedCount: 0,
    }),
    fetchContent: vi.fn().mockResolvedValue({
      status: 'loaded', kind: 'smart_note_ai_summary', title: 'DevX weekly',
      meetingTime: '2026-08-11T09:00:00Z',
      url: 'https://acme.feishu.cn/docx/devx-weekly', text: 'Decision: ship Friday.',
    }),
  };
}

function conversationStore(
  prompt: string,
  search = vi.fn().mockResolvedValue([]),
) {
  return {
    search,
    recentWithinBudget: vi.fn().mockResolvedValue([
      {
        messageId: 'om_prior', conversationId: 'conv_1', role: 'user',
        content: 'Earlier context', createdAt: new Date('2026-08-05T00:00:00Z'),
      },
      {
        messageId: 'om_prior_reply', conversationId: 'conv_1', role: 'assistant',
        content: 'Earlier Minori reply', createdAt: new Date('2026-08-05T00:00:30Z'),
      },
      {
        messageId: 'om_trigger', conversationId: 'conv_1', role: 'user',
        content: prompt, createdAt: new Date('2026-08-05T00:01:00Z'),
      },
    ]),
  };
}

const input = {
  prompt: 'When is the beta launch?',
  history: [],
  trigger: {
    kind: 'feishu_member',
    senderOpenId: 'ou_member',
    chatId: 'oc_team',
    chatType: 'p2p',
    occurredAt: new Date('2026-08-08T10:00:00.000Z'),
  },
} satisfies AgentRunInput;

const groupInput = {
  prompt: 'summarize above',
  history: [],
  trigger: {
    kind: 'feishu_member',
    senderOpenId: 'ou_current',
    chatId: 'oc_team',
    chatType: 'group',
    occurredAt: new Date('2026-08-08T10:00:00.000Z'),
  },
} satisfies AgentRunInput;

function groupContext(
  initialOverrides: Partial<Awaited<ReturnType<ScopedGroupContextReader['loadInitial']>>> = {},
) {
  const cutoff = new Date('2026-08-08T10:00:00.000Z');
  const audit: GroupHistoryAudit = {
    status: 'loaded', messageCount: 3, pageCallCount: 1, cutoff,
  };
  const reader: ScopedGroupContextReader = {
    loadInitial: vi.fn().mockResolvedValue({
      messages: [
        {
          speakerName: 'Alice', role: 'user', content: 'Launch on Friday.',
          occurredAt: new Date('2026-08-08T09:55:00.000Z'),
        },
        {
          speakerName: 'Bob', role: 'user', content: 'Please capture the risks.',
          occurredAt: new Date('2026-08-08T09:56:00.000Z'),
        },
        {
          speakerName: 'Minori', role: 'assistant', content: 'I can help when invoked.',
          occurredAt: new Date('2026-08-08T09:57:00.000Z'),
        },
      ],
      currentSenderName: 'Carol',
      audit,
      ...initialOverrides,
    }),
    readEarlier: vi.fn().mockResolvedValue({ messages: [], audit }),
  };
  const source: GroupContextSource = { open: vi.fn().mockReturnValue(reader) };
  return { source, reader };
}

function agentRunStore(overrides: Partial<AgentRunStore> = {}): AgentRunStore {
  return {
    start: vi.fn().mockResolvedValue({ id: 'run_1' }),
    beginWrite: vi.fn().mockResolvedValue({ id: 'write_1' }),
    finishWrite: vi.fn().mockResolvedValue(undefined),
    recordKnowledgeSearch: vi.fn().mockResolvedValue(undefined),
    recordMeetingRead: vi.fn().mockResolvedValue(undefined),
    listWriteAttempts: vi.fn().mockResolvedValue([]),
    recordGroupHistory: vi.fn().mockResolvedValue(undefined),
    recordTeamContext: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    purgeFailureDetails: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function dependencies(
  prompt: string,
  model: RunKnowledgeAgentDependencies['model'],
  overrides: Partial<RunKnowledgeAgentDependencies> = {},
): RunKnowledgeAgentDependencies {
  return {
    model,
    service: service(),
    meetingService: meetingService(),
    conversationKey: 'oc_team',
    triggerMessageId: 'om_trigger',
    conversationStore: conversationStore(prompt),
    eventId: 'evt_1',
    claimAttempt: 1,
    modelName: '5.6-terra',
    maxSteps: 20,
    timeoutMs: 180_000,
    botOpenId: 'ou_minori',
    botAppId: 'cli_minori',
    agentRunStore: agentRunStore(),
    onOperationalError: vi.fn(),
    ...overrides,
  };
}

describe('runKnowledgeAgent', () => {
  it('lets the open Agent fetch current meeting evidence and returns its authentic source', async () => {
    const meetings = meetingService();
    const doGenerate = vi.fn()
      .mockResolvedValueOnce(generated([{
        type: 'tool-call', toolCallId: 'call_meetings', toolName: 'searchMeetings',
        input: JSON.stringify({ range: { kind: 'recent' } }),
      }], 'tool-calls'))
      .mockResolvedValueOnce(generated([{
        type: 'tool-call', toolCallId: 'call_content', toolName: 'fetchMeetingContent',
        input: JSON.stringify({
          meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto',
        }),
      }], 'tool-calls'))
      .mockResolvedValueOnce(generated([{
        type: 'text', text: 'The team decided to ship Friday [1].',
      }], 'stop'));
    const model = new MockLanguageModelV4({ doGenerate });
    const store = agentRunStore();

    const reply = await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      meetingService: meetings,
      agentRunStore: store,
    }));

    expect(reply).toMatchObject({
      text: 'The team decided to ship Friday [1].',
      sources: [{
        id: 1,
        title: '[Smart Meeting Note AI summary] DevX weekly — 2026-08-11T09:00:00Z',
        url: 'https://acme.feishu.cn/docx/devx-weekly',
      }],
      outcome: 'completed',
    });
    expect(model.doGenerateCalls[0]?.tools?.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'searchMeetings', 'searchMeetingMinutes', 'fetchMeetingContent',
      ]),
    );
    await vi.waitFor(() => expect(store.recordMeetingRead).toHaveBeenCalledTimes(2));
  });

  it('does not delay or replace meeting results when their audit is unavailable', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_meetings', toolName: 'searchMeetings',
          input: JSON.stringify({ range: { kind: 'recent' } }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'I found the recent meeting.' }], 'stop'),
      ],
    });
    const audit = agentRunStore({
      recordMeetingRead: vi.fn().mockRejectedValue(new Error('postgres://secret-host')),
    });
    const onOperationalError = vi.fn();

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
      onOperationalError,
    }))).resolves.toMatchObject({
      text: 'I found the recent meeting.',
      outcome: 'completed',
    });
    await vi.waitFor(() => expect(onOperationalError).toHaveBeenCalledOnce());
    expect(onOperationalError).toHaveBeenCalledWith('meeting_audit_unavailable');
  });
  it('loads Team Context independently and places it before retained private context', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'Private answer.' }], 'stop'),
    });
    const load = vi.fn().mockResolvedValue({
      status: 'loaded' as const,
      content: '- Weekly Review means PMO.\n',
      sourceRevision: 9,
      estimatedTokens: 8,
      fetchedAt: new Date('2026-08-10T09:00:00Z'),
    });

    await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      teamContextSource: { documentToken: 'dox_team', load, update: vi.fn() },
    }));

    expect(load).toHaveBeenCalledWith(expect.any(AbortSignal));
    const serialized = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(serialized).toContain('[Team Context][Revision 9]');
    expect(serialized).toContain('Earlier context');
    expect(serialized).toContain('[Current Invocation][成员] When is the beta launch?');
    expect(serialized.indexOf('[Team Context]')).toBeLessThan(serialized.indexOf('Earlier context'));
    expect(serialized.lastIndexOf('[Current Invocation]')).toBeGreaterThan(
      serialized.lastIndexOf('Earlier Minori reply'),
    );
    expect(serialized.match(/When is the beta launch\?/gu)).toHaveLength(1);
  });

  it('keeps an old permission failure explicitly historical when no current read occurs', async () => {
    const historical = '2026-08-10 audit: Wiki read was blocked by missing scopes.';
    const knowledge = service();
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        const serialized = JSON.stringify(options.prompt);
        const followsEvidenceBoundary = serialized.includes(
          'Do not present historical content as a live result from the current run.',
        ) && serialized.includes(historical);
        return Promise.resolve(generated([{
          type: 'text',
          text: followsEvidenceBoundary
            ? '历史记录显示昨天的读取被权限拦截；本次没有实时验证。'
            : '实时读取仍被权限拦截。',
        }], 'stop'));
      },
    });
    const prompt = '现在 Wiki 情况怎么样？';
    const retained = conversationStore(prompt);
    retained.recentWithinBudget.mockResolvedValueOnce([
      {
        messageId: 'om_old', conversationId: 'conv_1', role: 'assistant',
        content: historical, createdAt: new Date('2026-08-10T02:00:00Z'),
      },
      {
        messageId: 'om_trigger', conversationId: 'conv_1', role: 'user',
        content: prompt, createdAt: new Date('2026-08-11T02:00:00Z'),
      },
    ]);

    const reply = await runKnowledgeAgent(
      { ...input, prompt },
      dependencies(prompt, model, { conversationStore: retained, service: knowledge }),
    );

    expect(reply.text).toBe('历史记录显示昨天的读取被权限拦截；本次没有实时验证。');
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('uses a current successful tool result without inventing a current read failure', async () => {
    const knowledge = service();
    const doGenerate = vi.fn()
      .mockResolvedValueOnce(generated([{
        type: 'tool-call', toolCallId: 'call_search', toolName: 'searchKnowledge',
        input: JSON.stringify({ query: 'DevX Wiki' }),
      }], 'tool-calls'))
      .mockImplementationOnce((options) => {
        const serialized = JSON.stringify(options.prompt);
        const hasCurrentResult = serialized.includes('Launch plan')
          && serialized.includes('Do not present historical content as a live result');
        return Promise.resolve(generated([{
          type: 'text',
          text: hasCurrentResult
            ? '本次实时搜索成功，找到了 Launch plan。'
            : '实时读取被权限拦截。',
        }], 'stop'));
      });
    const model = new MockLanguageModelV4({
      doGenerate,
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: '实时检查 DevX Wiki。' },
      dependencies('实时检查 DevX Wiki。', model, { service: knowledge }),
    );

    expect(knowledge.search).toHaveBeenCalledWith(
      { query: 'DevX Wiki' },
      expect.any(AbortSignal),
    );
    expect(reply.text).toBe('本次实时搜索成功，找到了 Launch plan。');
    expect(reply.text).not.toContain('权限拦截');
  });

  it('keeps an unverified member-provided current fact attributed to the member', async () => {
    const prompt = '我刚刚已经给机器人开了 Wiki 权限。';
    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        const serialized = JSON.stringify(options.prompt);
        const hasAttributionRule = serialized.includes(
          'attribute it to the member rather than claiming independent confirmation',
        );
        return Promise.resolve(generated([{
          type: 'text',
          text: hasAttributionRule
            ? '收到，你说已经开通了 Wiki 权限；我还没有独立验证。'
            : 'Wiki 权限已经确认开通。',
        }], 'stop'));
      },
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt },
      dependencies(prompt, model, { conversationStore: conversationStore(prompt) }),
    );

    expect(reply.text).toBe('收到，你说已经开通了 Wiki 权限；我还没有独立验证。');
  });

  it('can retain a naturally stated durable team assertion through one fenced update', async () => {
    const durableInput: AgentRunInput = {
      ...input,
      prompt: '以后周报都先给结论，再列来源。',
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_context', toolName: 'updateTeamContext',
          input: JSON.stringify({
            expectedRevision: 7,
            pattern: '- 周报格式：未约定',
            replacement: '- 周报格式：先给结论，再列来源',
            reason: 'durable_assertion',
            semanticChangeApproved: true,
          }),
        }], 'tool-calls'),
        generated([{
          type: 'text', text: '已记入团队上下文：周报先给结论，再列来源。',
        }], 'stop'),
      ],
    });
    const update = vi.fn().mockResolvedValue({
      operation: 'patch' as const,
      token: 'dox_team', title: 'Team Context',
      url: 'https://acme.feishu.cn/docx/dox_team', revisionId: 8,
    });
    const audit = agentRunStore();

    const reply = await runKnowledgeAgent(durableInput, dependencies(durableInput.prompt, model, {
      agentRunStore: audit,
      teamContextSource: {
        documentToken: 'dox_team',
        load: vi.fn().mockResolvedValue({
          status: 'loaded', content: '- 周报格式：未约定\n', sourceRevision: 7,
          estimatedTokens: 8, fetchedAt: new Date('2026-08-10T09:00:00Z'),
        }),
        update,
      },
    }));

    expect(update).toHaveBeenCalledWith({
      expectedRevision: 7,
      pattern: '- 周报格式：未约定',
      replacement: '- 周报格式：先给结论，再列来源',
      reason: 'durable_assertion',
      semanticChangeApproved: true,
    }, expect.any(AbortSignal));
    expect(audit.beginWrite).toHaveBeenCalledWith('run_1', {
      toolName: 'updateTeamContext',
      targetIdentifiers: { documentToken: 'dox_team' },
      sanitizedSummary: 'updated Team Context',
    });
    expect(audit.finishWrite).toHaveBeenCalledWith('write_1', {
      outcome: 'succeeded',
      resultIdentifiers: {
        token: 'dox_team', title: 'Team Context',
        url: 'https://acme.feishu.cn/docx/dox_team', revisionId: '8',
      },
    });
    expect(reply.text).toContain('已记入团队上下文');
    expect(reply.writeAttempts).toMatchObject([{
      toolName: 'updateTeamContext', outcome: 'succeeded',
    }]);
  });

  it('audits a concurrent Team Context edit with its stable conflict category', async () => {
    const durableInput: AgentRunInput = { ...input, prompt: '以后周报先给结论。' };
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_context', toolName: 'updateTeamContext',
          input: JSON.stringify({
            expectedRevision: 7, pattern: '旧规则', replacement: '先给结论',
            reason: 'correction', semanticChangeApproved: true,
          }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: '团队上下文刚刚发生了并发修改，我没有覆盖它。' }], 'stop'),
      ],
    });
    const audit = agentRunStore();

    await runKnowledgeAgent(durableInput, dependencies(durableInput.prompt, model, {
      agentRunStore: audit,
      teamContextSource: {
        documentToken: 'dox_team',
        load: vi.fn().mockResolvedValue({
          status: 'loaded', content: '旧规则\n', sourceRevision: 7,
          estimatedTokens: 3, fetchedAt: new Date(),
        }),
        update: vi.fn().mockRejectedValue(new KnowledgeWriteConflict()),
      },
    }));

    expect(audit.finishWrite).toHaveBeenCalledWith('write_1', {
      outcome: 'failed', errorCategory: 'team_context_conflict',
    });
  });

  it('supplies transient named group history before one distinct Current Invocation', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'Friday, with risks noted.' }], 'stop'),
    });
    const group = groupContext();
    const audit = agentRunStore();

    await runKnowledgeAgent(groupInput, dependencies(groupInput.prompt, model, {
      groupContextSource: group.source,
      agentRunStore: audit,
    }));

    expect(group.source.open).toHaveBeenCalledWith({
      chatId: 'oc_team',
      cutoff: new Date('2026-08-08T10:00:00.000Z'),
      triggerMessageId: 'om_trigger',
      currentSenderOpenId: 'ou_current',
      botOpenId: 'ou_minori',
      botAppId: 'cli_minori',
    });
    expect(group.reader.loadInitial).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(audit.recordGroupHistory).toHaveBeenCalledWith('run_1', {
      status: 'loaded', messageCount: 3, pageCallCount: 1,
      cutoff: new Date('2026-08-08T10:00:00.000Z'),
    });
    const serializedMessages = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(serializedMessages).toContain('[Live Group History][Alice]');
    expect(serializedMessages).toContain('[Live Group History][Bob]');
    expect(serializedMessages).toContain('[Live Group History][Minori]');
    expect(serializedMessages).toContain('[Current Invocation][Carol] summarize above');
    expect(serializedMessages).not.toContain('Earlier context');
    expect(serializedMessages).not.toContain('Earlier Minori reply');
    expect(serializedMessages).not.toContain('ou_');
    expect(serializedMessages.lastIndexOf('[Current Invocation]'))
      .toBeGreaterThan(serializedMessages.lastIndexOf('[Live Group History]'));
    expect(model.doGenerateCalls[0]?.tools?.map(({ name }) => name))
      .toContain('readEarlierGroupHistory');
  });

  it('keeps retained private history and never opens Group Context for p2p', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'Private answer.' }], 'stop'),
    });
    const group = groupContext();

    await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      groupContextSource: group.source,
    }));

    expect(group.source.open).not.toHaveBeenCalled();
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Earlier context');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Earlier Minori reply');
    expect(model.doGenerateCalls[0]?.tools?.map(({ name }) => name))
      .not.toContain('readEarlierGroupHistory');
  });

  it('falls back to retained conversation records before Current Invocation when group history is unavailable', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'I can answer from the request.' }], 'stop'),
    });
    const unavailableAudit: GroupHistoryAudit = {
      status: 'unavailable', messageCount: 0, pageCallCount: 1,
      cutoff: new Date('2026-08-08T10:00:00.000Z'),
      errorCategory: 'group_history_unavailable',
    };
    const group = groupContext({
      messages: [], currentSenderName: 'Carol', audit: unavailableAudit,
    });
    const audit = agentRunStore();

    await expect(runKnowledgeAgent(groupInput, dependencies(groupInput.prompt, model, {
      groupContextSource: group.source,
      agentRunStore: audit,
    }))).resolves.toMatchObject({ outcome: 'completed' });

    expect(model.doGenerateCalls).toHaveLength(1);
    const serializedMessages = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(serializedMessages).toContain('Earlier context');
    expect(serializedMessages).toContain('Earlier Minori reply');
    expect(serializedMessages).toContain('group_history_unavailable');
    expect(serializedMessages).toContain('[Current Invocation][Carol] summarize above');
    expect(serializedMessages.lastIndexOf('[Current Invocation]'))
      .toBeGreaterThan(serializedMessages.lastIndexOf('Earlier Minori reply'));
    expect(serializedMessages.match(/summarize above/gu)).toHaveLength(1);
    expect(serializedMessages).not.toContain('provider denied history for oc_team');
    expect(audit.recordGroupHistory).toHaveBeenCalledWith('run_1', unavailableAudit);
  });

  it('searches, reads, and returns a source-linked team knowledge answer', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_search', toolName: 'searchKnowledge',
          input: JSON.stringify({ query: 'beta launch' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_fetch', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnLaunch', mode: 'relevant', query: 'beta launch' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'The beta launch is Friday [1].' }], 'stop'),
      ],
    });
    const store = conversationStore(input.prompt);

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      conversationStore: store,
    }))).resolves.toEqual({
      text: 'The beta launch is Friday [1].',
      sources: [{ id: 1, title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch' }],
      usage: { inputTokens: 30, outputTokens: 12 },
      outcome: 'completed',
      writeAttempts: [],
    });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(store.recentWithinBudget).toHaveBeenCalledWith(
      'oc_team', 24_000, 'om_trigger',
    );
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Earlier context');
    expect(model.doGenerateCalls.every(
      (call) => call.providerOptions?.openai?.store === false,
    )).toBe(true);
  });

  it('does not delay or fail a successful search when its audit is unavailable', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_search', toolName: 'searchKnowledge',
          input: JSON.stringify({ query: 'beta launch' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'I found the launch plan.' }], 'stop'),
      ],
    });
    const audit = agentRunStore({
      recordKnowledgeSearch: vi.fn().mockRejectedValue(new Error('postgres://secret-host')),
    });
    const onOperationalError = vi.fn();

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
      onOperationalError,
    }))).resolves.toMatchObject({
      text: 'I found the launch plan.',
      outcome: 'completed',
    });
    await vi.waitFor(() => {
      expect(onOperationalError).toHaveBeenCalledOnce();
    });
    expect(onOperationalError).toHaveBeenCalledWith('search_audit_unavailable');
  });

  it('answers a general transformation directly without tools or an empty source section', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{
        type: 'text', text: 'Shorter version.',
      }], 'stop'),
    });

    await expect(runKnowledgeAgent({ ...input, prompt: 'Rewrite this more briefly.' }, dependencies(
      'Rewrite this more briefly.', model, {
      conversationStore: conversationStore('Rewrite this more briefly.'),
      },
    ))).resolves.toEqual({
      text: 'Shorter version.', sources: [],
      usage: { inputTokens: 10, outputTokens: 4 },
      outcome: 'completed', writeAttempts: [],
    });
    expect(model.doGenerateCalls[0]?.prompt.map((message) => message.role)).toEqual([
      'system', 'user', 'assistant', 'user',
    ]);
  });

  it('returns every authentic source without requiring a citation marker', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_fetch', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnLaunch', mode: 'relevant' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'The beta launch is Friday.' }], 'stop'),
      ],
    });

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model)))
      .resolves.toEqual({
      text: 'The beta launch is Friday.',
      sources: [{ id: 1, title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch' }],
      usage: { inputTokens: 20, outputTokens: 8 },
      outcome: 'completed',
      writeAttempts: [],
    });
  });

  it('can search only the scoped retained conversation for an older detail', async () => {
    const historySearch = vi.fn().mockResolvedValue([{
      messageId: 'om_old', role: 'user', excerpt: 'codename was Juniper',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    }]);
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_history', toolName: 'searchConversationHistory',
          input: JSON.stringify({ query: 'codename', limit: 5 }),
        }], 'tool-calls'),
        generated([{
          type: 'text', text: 'You previously called it Juniper.',
        }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'What codename did I use?' },
      dependencies('What codename did I use?', model, {
      conversationStore: conversationStore('What codename did I use?', historySearch),
      contextTokenTarget: 1,
      }),
    );

    expect(reply.sources).toEqual([]);
    expect(historySearch).toHaveBeenCalledWith('oc_team', 'codename', 5);
  });

  it('keeps Agent-managed recovery open with the visible receipt and full typed write set', async () => {
    const visibleReceipt = [
      '本次执行在写入开始后中断，现已停止。',
      '已记录的写入尝试：',
      '- 已确认成功：created one document — https://acme.feishu.cn/docx/created',
    ].join('\n');
    const prompt = '继续';
    const store = {
      search: vi.fn().mockResolvedValue([]),
      recentWithinBudget: vi.fn().mockResolvedValue([
        {
          messageId: 'om_receipt', conversationId: 'conv_1', role: 'assistant' as const,
          content: visibleReceipt, createdAt: new Date('2026-08-05T00:00:00Z'),
        },
        {
          messageId: 'om_trigger', conversationId: 'conv_1', role: 'user' as const,
          content: prompt, createdAt: new Date('2026-08-05T00:01:00Z'),
        },
      ]),
    };
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'I checked the visible receipt.' }], 'stop'),
    });

    await runKnowledgeAgent(
      { ...input, prompt },
      dependencies(prompt, model, { conversationStore: store }),
    );

    const call = model.doGenerateCalls[0]!;
    expect(JSON.stringify(call.prompt)).toContain('写入开始后中断');
    expect(JSON.stringify(call.prompt)).toContain('https://acme.feishu.cn/docx/created');
    expect(call.tools?.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'createDocument', 'appendDocument', 'patchDocument',
    ]));
  });

  it('autonomously follows a document continuation cursor when more evidence is needed', async () => {
    const knowledge = service();
    knowledge.fetchDocument = vi.fn().mockResolvedValue({
      token: 'doxcnLong', title: 'Long plan', url: 'https://acme.feishu.cn/docx/long-plan',
      markdown: `# Part one\n${'context '.repeat(2_000)}\n# Part two\nFinal launch detail.`,
      revisionId: 1,
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_fetch_1', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnLong', mode: 'full' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_fetch_2', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnLong', mode: 'full', cursor: 'cursor_1' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'The final detail is documented [1].' }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      service: knowledge,
    }));

    expect(reply.sources).toHaveLength(1);
    expect(knowledge.fetchDocument).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('reads multiple documents directly without a scenario label, search sequence, or markers', async () => {
    const knowledge = service();
    knowledge.fetchDocument = vi.fn()
      .mockResolvedValueOnce({
        token: 'doxcnOne', title: 'One', url: 'https://acme.feishu.cn/docx/one',
        markdown: '# One\nFirst.', revisionId: 1,
      })
      .mockResolvedValueOnce({
        token: 'doxcnTwo', title: 'Two', url: 'https://acme.feishu.cn/docx/two',
        markdown: '# Two\nSecond.', revisionId: 1,
      });
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([
          {
            type: 'tool-call', toolCallId: 'call_one', toolName: 'fetchDocument',
            input: JSON.stringify({ doc: 'doxcnOne', mode: 'full' }),
          },
          {
            type: 'tool-call', toolCallId: 'call_two', toolName: 'fetchDocument',
            input: JSON.stringify({ doc: 'doxcnTwo', mode: 'full' }),
          },
        ], 'tool-calls'),
        generated([{ type: 'text', text: 'Combined natural summary.' }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Compare doxcnOne and doxcnTwo.' },
      dependencies('Compare doxcnOne and doxcnTwo.', model, { service: knowledge }),
    );

    expect(knowledge.search).not.toHaveBeenCalled();
    expect(reply.text).toBe('Combined natural summary.');
    expect(reply.sources.map(({ title }) => title)).toEqual(['One', 'Two']);
  });

  it('creates a document autonomously and records only sanitized audit metadata', async () => {
    const knowledge = service();
    const audit = agentRunStore();
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({ title: 'Plan', content: '# Plan' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'Created the plan.' }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Create a plan.' },
      dependencies('Create a plan.', model, { service: knowledge, agentRunStore: audit }),
    );

    expect(reply.text).toBe('Created the plan.');
    expect(knowledge.createDocument).toHaveBeenCalledWith(
      { title: 'Plan', content: '# Plan' }, expect.any(AbortSignal),
    );
    expect(audit.start).toHaveBeenCalledWith({
      eventId: 'evt_1', claimAttempt: 1, model: '5.6-terra',
    });
    expect(audit.beginWrite).toHaveBeenCalledWith('run_1', {
      toolName: 'createDocument', targetIdentifiers: {},
      sanitizedSummary: 'created one document',
    });
    expect(audit.finishWrite).toHaveBeenCalledWith('write_1', {
      outcome: 'succeeded',
      resultIdentifiers: {
        token: 'doxcnCreated',
        title: 'Created plan',
        url: 'https://acme.feishu.cn/docx/created',
        revisionId: '1',
      },
    });
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      inputTokens: 20,
      outputTokens: 8,
      toolCallCount: 1,
      outcome: 'completed',
    });
    expect(JSON.stringify(vi.mocked(audit.beginWrite).mock.calls)).not.toContain('# Plan');
  });

  it('does not write when the pending audit row cannot be persisted', async () => {
    const knowledge = service();
    const audit = agentRunStore({
      beginWrite: vi.fn().mockRejectedValue(new Error('postgres://secret-host')),
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({ title: 'Plan', content: '# Sensitive plan' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'The write could not be audited.' }], 'stop'),
      ],
    });

    await expect(runKnowledgeAgent(
      { ...input, prompt: 'Create a sensitive plan.' },
      dependencies('Create a sensitive plan.', model, {
        service: knowledge,
        agentRunStore: audit,
      }),
    )).resolves.toMatchObject({ text: 'The write could not be audited.' });

    expect(knowledge.createDocument).not.toHaveBeenCalled();
    const secondPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(secondPrompt).toContain('write_audit_unavailable');
    expect(secondPrompt).not.toContain('postgres://secret-host');
  });

  it('does not write when pending audit persistence resolves after the Agent deadline', async () => {
    const knowledge = service();
    const audit = agentRunStore({
      beginWrite: vi.fn(() => new Promise<{ id: string }>((resolve) => {
        setTimeout(() => resolve({ id: 'write_delayed' }), 25);
      })),
    });
    const model = new MockLanguageModelV4({
      doGenerate: generated([{
        type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
        input: JSON.stringify({ title: 'Plan', content: '# Must not be written' }),
      }], 'tool-calls'),
    });

    await expect(runKnowledgeAgent(
      { ...input, prompt: 'Create a plan before the deadline.' },
      dependencies('Create a plan before the deadline.', model, {
        service: knowledge,
        agentRunStore: audit,
        timeoutMs: 5,
      }),
    )).resolves.toMatchObject({
      outcome: 'timeout_reached',
      writeAttempts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(knowledge.createDocument).not.toHaveBeenCalled();
    expect(audit.finishWrite).toHaveBeenCalledWith('write_delayed', {
      outcome: 'unknown',
      errorCategory: 'agent_run_aborted',
    });
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      inputTokens: 10,
      outputTokens: 4,
      toolCallCount: 1,
      outcome: 'timeout_reached',
      errorMessage: expect.any(String),
    });
  });

  it('finalizes an Agent run that starts after its deadline', async () => {
    const audit = agentRunStore({
      start: vi.fn(() => new Promise<{ id: string }>((resolve) => {
        setTimeout(() => resolve({ id: 'run_delayed' }), 25);
      })),
    });
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'must not run' }], 'stop'),
    });

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
      timeoutMs: 5,
    }))).rejects.toThrow('agent_audit_unavailable');
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(audit.finish).toHaveBeenCalledWith('run_delayed', {
      toolCallCount: 0,
      outcome: 'aborted',
      errorMessage: expect.any(String),
    });
  });

  it('handles a store rejection after an already-aborted signal without an unhandled rejection', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already_aborted'));
    const audit = agentRunStore({
      start: vi.fn().mockRejectedValue(new Error('postgres://secret-host')),
    });
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'must not run' }], 'stop'),
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await expect(runKnowledgeAgent(
        input,
        dependencies(input.prompt, model, { agentRunStore: audit }),
        controller.signal,
      )).rejects.toThrow('agent_audit_unavailable');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(model.doGenerateCalls).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports a reached Agent step limit as a truthful terminal outcome', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_search', toolName: 'searchKnowledge',
          input: JSON.stringify({ query: 'launch' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'This step must not run.' }], 'stop'),
      ],
    });

    const audit = agentRunStore();
    const reply = await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      maxSteps: 1,
      agentRunStore: audit,
    }));

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(reply).toMatchObject({
      outcome: 'step_limit_reached',
      writeAttempts: [],
    });
    expect(reply.text).toContain('执行步数上限');
    expect(reply.text).toContain('继续');
    expect(audit.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
      outcome: 'step_limit_reached',
    }));
    expect(vi.mocked(audit.finish).mock.calls.at(-1)?.[1]).not.toHaveProperty('errorMessage');
  });

  it('does not misclassify natural completion on the final allowed step', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'Finished naturally.' }], 'stop'),
    });

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      maxSteps: 1,
    }))).resolves.toMatchObject({
      text: 'Finished naturally.',
      outcome: 'completed',
      writeAttempts: [],
    });
  });

  it('retains only sanitized confirmed write facts when the step limit is reached', async () => {
    const knowledge = service();
    const model = new MockLanguageModelV4({
      doGenerate: generated([{
        type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
        input: JSON.stringify({ title: 'Plan', content: '# Sensitive launch body' }),
      }], 'tool-calls'),
    });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Create the confidential launch plan.' },
      dependencies('Create the confidential launch plan.', model, {
        service: knowledge,
        maxSteps: 1,
        agentRunStore: agentRunStore(),
        }),
    );

    expect(reply).toMatchObject({
      outcome: 'step_limit_reached',
      writeAttempts: [{
        toolName: 'createDocument',
        outcome: 'succeeded',
        sanitizedSummary: 'created one document',
        targetIdentifiers: {},
        resultIdentifiers: {
          token: 'doxcnCreated',
          title: 'Created plan',
          url: 'https://acme.feishu.cn/docx/created',
          revisionId: '1',
        },
      }],
    });
    expect(reply.text).toContain('已确认成功：created one document');
    expect(reply.text).toContain('https://acme.feishu.cn/docx/created');
    expect(reply.text).not.toContain('Sensitive launch body');
    expect(reply.text).not.toContain('confidential launch plan');
  });

  it('appends and applies one exact patch without a confirmation flow', async () => {
    const knowledge = service();
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_append', toolName: 'appendDocument',
          input: JSON.stringify({ doc: 'doxcnLaunch', content: '\nNext step.' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_patch', toolName: 'patchDocument',
          input: JSON.stringify({
            doc: 'doxcnLaunch', pattern: 'Friday', replacement: 'Thursday',
          }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'Applied both requested changes.' }], 'stop'),
      ],
    });

    await runKnowledgeAgent(
      { ...input, prompt: 'Append a step and change the launch day.' },
      dependencies('Append a step and change the launch day.', model, { service: knowledge }),
    );

    expect(knowledge.appendDocument).toHaveBeenCalledWith(
      { doc: 'doxcnLaunch', content: '\nNext step.' }, expect.any(AbortSignal),
    );
    expect(knowledge.patchDocument).toHaveBeenCalledWith(
      { doc: 'doxcnLaunch', pattern: 'Friday', replacement: 'Thursday' },
      expect.any(AbortSignal),
    );
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('can re-read after a write conflict before retrying an exact patch', async () => {
    const knowledge = service();
    knowledge.patchDocument = vi.fn()
      .mockRejectedValueOnce(new KnowledgeWriteConflict())
      .mockResolvedValueOnce({
        operation: 'patch', token: 'doxcnLaunch', title: 'Launch plan',
        url: 'https://acme.feishu.cn/docx/launch', revisionId: 3,
      });
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_patch_1', toolName: 'patchDocument',
          input: JSON.stringify({
            doc: 'doxcnLaunch', pattern: 'Friday', replacement: 'Thursday',
          }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_refetch', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnLaunch', mode: 'full' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_patch_2', toolName: 'patchDocument',
          input: JSON.stringify({
            doc: 'doxcnLaunch', pattern: 'Friday', replacement: 'Thursday',
          }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'Updated after checking the latest revision.' }], 'stop'),
      ],
    });

    const audit = agentRunStore();
    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Change Friday to Thursday.' },
      dependencies('Change Friday to Thursday.', model, {
        service: knowledge,
        agentRunStore: audit,
      }),
    );

    expect(knowledge.patchDocument).toHaveBeenCalledTimes(2);
    expect(knowledge.fetchDocument).toHaveBeenCalledOnce();
    expect(reply.sources).toHaveLength(1);
    expect(audit.finishWrite).toHaveBeenNthCalledWith(1, 'write_1', {
      outcome: 'failed',
      errorCategory: 'knowledge_write_conflict',
    });
  });

  it('rejects a model failure before any write so the worker can retry it', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: vi.fn().mockRejectedValue(new Error('model_unavailable')),
    });
    const audit = agentRunStore();

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
    }))).rejects.toThrow('model_unavailable');

    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'failed',
      errorMessage: 'model_unavailable',
    });
  });

  it('returns a truthful interruption receipt when the model fails after a successful create', async () => {
    const knowledge = service();
    const model = new MockLanguageModelV4({
      doGenerate: vi.fn()
        .mockResolvedValueOnce(generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({ title: 'Plan', content: '# Sensitive body' }),
        }], 'tool-calls'))
        .mockRejectedValueOnce(new Error('model_unavailable')),
    });
    const audit = agentRunStore();

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Create the plan, then summarize it.' },
      dependencies('Create the plan, then summarize it.', model, {
        service: knowledge,
        agentRunStore: audit,
      }),
    );

    expect(knowledge.createDocument).toHaveBeenCalledOnce();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(reply).toMatchObject({
      outcome: 'interrupted_after_write',
      writeAttempts: [{
        toolName: 'createDocument',
        outcome: 'succeeded',
        resultIdentifiers: { url: 'https://acme.feishu.cn/docx/created' },
      }],
    });
    expect(reply.text).toContain('写入开始后中断');
    expect(reply.text).toContain('https://acme.feishu.cn/docx/created');
    expect(reply.text).not.toContain('Sensitive body');
    expect(audit.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
      outcome: 'interrupted_after_write',
      errorMessage: 'model_unavailable',
    }));
  });

  it('reports the configured Agent deadline as a truthful terminal outcome', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(new Error('provider timed out')));
      }),
    });

    const audit = agentRunStore();
    const reply = await runKnowledgeAgent(input, dependencies(input.prompt, model, {
      timeoutMs: 5,
      agentRunStore: audit,
    }));
    expect(reply).toMatchObject({
      outcome: 'timeout_reached',
      writeAttempts: [],
    });
    expect(reply.text).not.toContain('provider timed out');
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'timeout_reached',
      errorMessage: 'provider timed out',
    });
  });

  it('reports confirmed writes without replaying when the deadline is reached later', async () => {
    const knowledge = service();
    const doGenerate = vi.fn()
      .mockResolvedValueOnce(generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({ title: 'Plan', content: '# Do not echo this body' }),
        }], 'tool-calls'))
      .mockImplementationOnce((options) => new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
        }));
    const model = new MockLanguageModelV4({ doGenerate });

    const reply = await runKnowledgeAgent(
      { ...input, prompt: 'Create, then keep working.' },
      dependencies('Create, then keep working.', model, {
        timeoutMs: 10,
        service: knowledge,
      }),
    );

    expect(knowledge.createDocument).toHaveBeenCalledOnce();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(reply).toMatchObject({
      outcome: 'timeout_reached',
      writeAttempts: [{
        toolName: 'createDocument',
        outcome: 'succeeded',
        resultIdentifiers: { url: 'https://acme.feishu.cn/docx/created' },
      }],
    });
    expect(reply.text).toContain('https://acme.feishu.cn/docx/created');
    expect(reply.text).not.toContain('Do not echo this body');
  });

  it('still rejects external cancellation and audits it as aborted', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      }),
    });
    const audit = agentRunStore();
    const controller = new AbortController();
    const pending = runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
    }), controller.signal);

    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    controller.abort(new Error('worker_stopped'));

    await expect(pending).rejects.toThrow('worker_stopped');
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'aborted',
      errorMessage: 'worker_stopped',
    });
  });

  it('keeps external cancellation as the cause when the provider rejects after timeout', async () => {
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        markModelStarted();
        options.abortSignal?.addEventListener('abort', () => {
          setTimeout(() => reject(options.abortSignal?.reason), 30);
        }, { once: true });
      }),
    });
    const audit = agentRunStore();
    const controller = new AbortController();
    const pending = runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
      timeoutMs: 20,
    }), controller.signal);

    await modelStarted;
    controller.abort(new Error('worker_stopped_first'));

    await expect(pending).rejects.toThrow('worker_stopped_first');
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'aborted',
      errorMessage: 'worker_stopped_first',
    });
  });

  it('applies the same wall-clock deadline while loading recent history', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'unused' }], 'stop'),
    });

    const audit = agentRunStore();
    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      timeoutMs: 5,
      agentRunStore: audit,
      conversationStore: {
        search: vi.fn().mockResolvedValue([]),
        recentWithinBudget: vi.fn(() => new Promise(() => undefined)),
      },
    }))).resolves.toMatchObject({
      outcome: 'timeout_reached',
      writeAttempts: [],
    });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(audit.start).toHaveBeenCalledWith({
      eventId: 'evt_1', claimAttempt: 1, model: '5.6-terra',
    });
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'timeout_reached',
      errorMessage: expect.any(String),
    });
  });

  it('finishes a failed Agent run when stored trigger validation fails', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'unused' }], 'stop'),
    });
    const audit = agentRunStore();

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
      conversationStore: conversationStore('different persisted prompt'),
    }))).rejects.toThrow('trigger_prompt_mismatch');

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'failed',
      errorMessage: 'trigger_prompt_mismatch',
    });
  });

  it('does not serialize a non-Error model rejection into the Agent Failure Detail', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: vi.fn().mockRejectedValue({ token: 'must-not-persist' }),
    });
    const audit = agentRunStore();

    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      agentRunStore: audit,
    }))).rejects.toEqual({ token: 'must-not-persist' });

    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'failed',
      errorMessage: 'non_error_rejection',
    });
  });
});
