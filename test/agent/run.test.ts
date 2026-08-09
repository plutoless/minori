import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWriteConflict } from '../../src/lark/errors.js';
import type { KnowledgeService } from '../../src/lark/knowledge-service.js';
import { runKnowledgeAgent, type RunKnowledgeAgentDependencies } from '../../src/agent/run.js';
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

function agentRunStore(overrides: Partial<AgentRunStore> = {}): AgentRunStore {
  return {
    start: vi.fn().mockResolvedValue({ id: 'run_1' }),
    beginWrite: vi.fn().mockResolvedValue({ id: 'write_1' }),
    finishWrite: vi.fn().mockResolvedValue(undefined),
    listWriteAttempts: vi.fn().mockResolvedValue([]),
    finish: vi.fn().mockResolvedValue(undefined),
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
    conversationKey: 'oc_team:om_root',
    triggerMessageId: 'om_trigger',
    conversationStore: conversationStore(prompt),
    eventId: 'evt_1',
    claimAttempt: 1,
    modelName: '5.6-terra',
    maxSteps: 20,
    timeoutMs: 180_000,
    agentRunStore: agentRunStore(),
    ...overrides,
  };
}

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
    expect(historySearch).toHaveBeenCalledWith('oc_team:om_root', 'codename', 5);
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
    }));
  });

  it('reports the configured Agent deadline as a truthful terminal outcome', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      }),
    });

    const audit = agentRunStore();
    await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
      timeoutMs: 5,
      agentRunStore: audit,
    }))).resolves.toMatchObject({
      outcome: 'timeout_reached',
      writeAttempts: [],
    });
    expect(audit.finish).toHaveBeenCalledWith('run_1', {
      toolCallCount: 0,
      outcome: 'timeout_reached',
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
    });
  });
});
