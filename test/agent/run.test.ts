import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeReader } from '../../src/lark/read-service.js';
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

function reader(): KnowledgeReader {
  return {
    search: vi.fn().mockResolvedValue([{
      title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch',
      token: 'doxcnLaunch', type: 'docx',
    }]),
    fetchDocument: vi.fn().mockResolvedValue({
      title: 'Launch plan', url: 'https://acme.feishu.cn/docx/launch',
      markdown: '# Launch\nThe beta launch is Friday.',
    }),
    listSpaces: vi.fn().mockResolvedValue([]),
    listNodes: vi.fn().mockResolvedValue([]),
    getNode: vi.fn(),
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
      model, reader: reader(), conversationKey: 'oc_team:om_root',
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
        type: 'text', text: 'Shorter version.\n<!-- minori:general -->',
      }], 'stop'),
    });

    await expect(runKnowledgeAgent({ ...input, prompt: 'Rewrite this more briefly.' }, {
      model, reader: reader(), conversationKey: 'oc_team:om_root',
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
          type: 'text', text: 'You previously called it Juniper.\n<!-- minori:general -->',
        }], 'stop'),
      ],
    });

    const reply = await runKnowledgeAgent({ ...input, prompt: 'What codename did I use?' }, {
      model, reader: reader(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger',
      conversationStore: conversationStore('What codename did I use?', historySearch),
      contextTokenTarget: 1,
    });

    expect(reply.sources).toEqual([]);
    expect(historySearch).toHaveBeenCalledWith('oc_team:om_root', 'codename', 5);
  });

  it('autonomously follows a document continuation cursor when more evidence is needed', async () => {
    const knowledge = reader();
    knowledge.fetchDocument = vi.fn().mockResolvedValue({
      title: 'Long plan', url: 'https://acme.feishu.cn/docx/long-plan',
      markdown: `# Part one\n${'context '.repeat(2_000)}\n# Part two\nFinal launch detail.`,
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
      model, reader: knowledge, conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore(input.prompt),
    });

    expect(reply.sources).toHaveLength(1);
    expect(knowledge.fetchDocument).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('aborts an Agent run at the configured deadline', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      }),
    });

    await expect(runKnowledgeAgent(input, {
      model, reader: reader(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', conversationStore: conversationStore(input.prompt),
      timeoutMs: 5,
    })).rejects.toBeDefined();
  });

  it('applies the same wall-clock deadline while loading recent history', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: 'text', text: 'unused' }], 'stop'),
    });

    await expect(runKnowledgeAgent(input, {
      model, reader: reader(), conversationKey: 'oc_team:om_root',
      triggerMessageId: 'om_trigger', timeoutMs: 5,
      conversationStore: {
        search: vi.fn().mockResolvedValue([]),
        recentWithinBudget: vi.fn(() => new Promise(() => undefined)),
      },
    })).rejects.toBeDefined();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
