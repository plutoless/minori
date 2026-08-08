import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWriteConflict } from '../../src/lark/errors.js';
import type { KnowledgeService } from '../../src/lark/knowledge-service.js';
import { runKnowledgeAgent } from '../../src/agent/run.js';

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
    search: vi.fn().mockResolvedValue([{
      title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch',
      token: 'doxcnLaunch', type: 'docx',
    }]),
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
        messageId: 'om_trigger', conversationId: 'conv_1', role: 'user',
        content: prompt, createdAt: new Date('2026-08-05T00:01:00Z'),
      },
    ]),
  };
}

const input = {
  prompt: 'When is the beta launch?',
  history: [],
  trigger: { kind: 'feishu_member' as const, senderOpenId: 'ou_member', chatId: 'oc_team' },
};

describe('runKnowledgeAgent', () => {
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

    await expect(runKnowledgeAgent(input, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: store,
    })).resolves.toEqual({
      text: 'The beta launch is Friday [1].',
      sources: [{ id: 1, title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch' }],
      usage: { inputTokens: 30, outputTokens: 12 },
    });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(store.recentWithinBudget).toHaveBeenCalledWith(
      'oc_team:om_root', 24_000, 'om_trigger',
    );
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Earlier context');
    expect(model.doGenerateCalls.every(
      (call) => call.providerOptions?.openai?.store === false,
    )).toBe(true);
  });

  it('answers a general transformation directly without tools or an empty source section', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{
        type: 'text', text: 'Shorter version.',
      }], 'stop'),
    });

    await expect(runKnowledgeAgent({ ...input, prompt: 'Rewrite this more briefly.' }, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('Rewrite this more briefly.'),
    })).resolves.toEqual({
      text: 'Shorter version.', sources: [],
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(model.doGenerateCalls[0]?.prompt.map((message) => message.role)).toEqual([
      'system', 'user', 'user',
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

    await expect(runKnowledgeAgent(input, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore(input.prompt),
    })).resolves.toEqual({
      text: 'The beta launch is Friday.',
      sources: [{ id: 1, title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch' }],
      usage: { inputTokens: 20, outputTokens: 8 },
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

    const reply = await runKnowledgeAgent({ ...input, prompt: 'What codename did I use?' }, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('What codename did I use?', historySearch),
      contextTokenTarget: 1,
    });

    expect(reply.sources).toEqual([]);
    expect(historySearch).toHaveBeenCalledWith('oc_team:om_root', 'codename', 5);
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

    const reply = await runKnowledgeAgent(input, {
      model, service: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore(input.prompt),
    });

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

    const reply = await runKnowledgeAgent({ ...input, prompt: 'Compare doxcnOne and doxcnTwo.' }, {
      model, service: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('Compare doxcnOne and doxcnTwo.'),
    });

    expect(knowledge.search).not.toHaveBeenCalled();
    expect(reply.text).toBe('Combined natural summary.');
    expect(reply.sources.map(({ title }) => title)).toEqual(['One', 'Two']);
  });

  it('creates a document autonomously and records only sanitized audit metadata', async () => {
    const knowledge = service();
    const audit = { run: vi.fn((_input, operation) => operation()) };
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({ title: 'Plan', content: '# Plan' }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'Created the plan.' }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent({ ...input, prompt: 'Create a plan.' }, {
      model, service: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore('Create a plan.'),
      writeAudit: audit,
    });

    expect(reply.text).toBe('Created the plan.');
    expect(knowledge.createDocument).toHaveBeenCalledWith(
      { title: 'Plan', content: '# Plan' }, expect.any(AbortSignal),
    );
    expect(audit.run.mock.calls[0]?.[0]).toEqual({
      toolName: 'createDocument', targetIdentifiers: {},
      sanitizedSummary: 'created one document',
    });
    expect(JSON.stringify(audit.run.mock.calls[0]?.[0])).not.toContain('# Plan');
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

    await runKnowledgeAgent({ ...input, prompt: 'Append a step and change the launch day.' }, {
      model, service: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('Append a step and change the launch day.'),
    });

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

    const reply = await runKnowledgeAgent({ ...input, prompt: 'Change Friday to Thursday.' }, {
      model, service: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('Change Friday to Thursday.'),
    });

    expect(knowledge.patchDocument).toHaveBeenCalledTimes(2);
    expect(knowledge.fetchDocument).toHaveBeenCalledOnce();
    expect(reply.sources).toHaveLength(1);
  });

  it('aborts an Agent run at the configured deadline', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      }),
    });

    await expect(runKnowledgeAgent(input, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore(input.prompt),
      timeoutMs: 5,
    })).rejects.toBeDefined();
  });

  it('applies the same wall-clock deadline while loading recent history', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'unused' }], 'stop'),
    });

    await expect(runKnowledgeAgent(input, {
      model, service: service(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', timeoutMs: 5,
      conversationStore: {
        search: vi.fn().mockResolvedValue([]),
        recentWithinBudget: vi.fn(() => new Promise(() => undefined)),
      },
    })).rejects.toBeDefined();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
