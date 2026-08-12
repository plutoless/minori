import { describe, expect, it, vi } from 'vitest';
import type { AgentReply } from '../../src/agent/run.js';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import type {
  EventStore, PreparedReplyKind, StoredEvent,
} from '../../src/storage/event-store.js';
import { MessageWorker } from '../../src/worker/message-worker.js';
import { PROGRESS_REPLY_TEXT } from '../../src/worker/progress-reply.js';

function message(content: NormalizedMessage['content'] = {
  kind: 'text', text: '发布流程是什么？', feishuLinks: [],
}): NormalizedMessage {
  return {
    eventId: 'evt_1', messageId: 'om_1', chatId: 'oc_1',
    conversationKey: 'oc_1', senderOpenId: 'ou_1',
    chatType: 'group', content, occurredAt: new Date('2026-08-05T00:00:00Z'),
  };
}

function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: 'evt_1',
    payload: message(),
    attempts: 1,
    receivedAt: new Date('2026-08-05T01:00:00.000Z'),
    ...overrides,
  };
}

class FakeEventStore implements EventStore {
  calls: string[] = [];
  marked?: { key: string; attemptedAt: Date; text?: string; kind?: PreparedReplyKind };
  completed?: { replyMessageId?: string; errorCode?: string };
  retried?: { errorCode: string; nextAttemptAt: Date };
  terminalProcessingReactionId?: string;
  async enqueue() { return 'queued' as const; }
  async attachProcessingReaction() { return true; }
  async claimReady() { return []; }
  async complete(_eventId: string, _attempt: number, outcome: typeof this.completed) {
    this.calls.push('complete'); this.completed = outcome;
    return this.terminalProcessingReactionId
      ? { processingReactionId: this.terminalProcessingReactionId }
      : {};
  }
  async markReplyStarted(
    _eventId: string,
    _attempt: number,
    key: string,
    attemptedAt: Date,
    prepared?: { text: string; kind: PreparedReplyKind },
  ) {
    this.calls.push('markReplyStarted');
    this.marked = { key, attemptedAt, ...prepared };
  }
  async markProgressAttempted() {
    this.calls.push('markProgress');
    return true;
  }
  async confirmProgressSent() {
    this.calls.push('confirmProgress');
    return true;
  }
  async markReplyUncertain() {
    this.calls.push('uncertain');
    return this.terminalProcessingReactionId
      ? { processingReactionId: this.terminalProcessingReactionId }
      : {};
  }
  async retry(_eventId: string, _attempt: number, errorCode: string, nextAttemptAt: Date) {
    this.calls.push('retry'); this.retried = { errorCode, nextAttemptAt };
  }
  async recoverExpiredLeases() { return 0; }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const eventStore = new FakeEventStore();
  const appended: Array<{ messageId: string; role: string; content: string }> = [];
  const runAgent = vi.fn(async (): Promise<AgentReply> => ({
    text: '发布说明和设计稿都已核对。',
    sources: [
      { id: 1, title: '设计稿', url: 'https://example.com/design' },
      { id: 2, title: '发布说明', url: 'https://example.com/release' },
    ],
    usage: {},
    outcome: 'completed',
    writeAttempts: [],
  }));
  const messenger = {
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReaction: vi.fn(async () => undefined),
    replyText: vi.fn(async () => 'om_reply_1'),
    replyRichContent: vi.fn(async () => 'om_reply_1'),
  };
  return {
    eventStore,
    appended,
    runAgent,
    messenger,
    options: {
      eventStore,
      conversations: {
        getOrCreateConversation: vi.fn(async () => 'conversation_1'),
        append: vi.fn(async (entry) => { appended.push(entry); }),
      },
      runAgent,
      loadWriteAttempts: vi.fn(async () => []),
      messenger,
      logger: { warn: vi.fn(), info: vi.fn() },
      now: () => new Date('2026-08-05T01:00:00Z'),
      ...overrides,
    },
  };
}

describe('MessageWorker.process', () => {
  it('recovers expired leases and starts/stops the default four-worker pool', async () => {
    const setup = dependencies();
    const claimReady = vi.spyOn(setup.eventStore, 'claimReady');
    const recover = vi.spyOn(setup.eventStore, 'recoverExpiredLeases');
    const worker = new MessageWorker({
      ...setup.options,
      pollMs: 60_000,
      recoveryIntervalMs: 5,
    });

    await worker.start();
    await vi.waitFor(() => expect(claimReady.mock.calls.length).toBeGreaterThanOrEqual(4));
    await vi.waitFor(() => expect(recover.mock.calls.length).toBeGreaterThanOrEqual(2));
    await worker.stop();

    expect(claimReady.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('stops a hung Agent run before its lease and durably retries it', async () => {
    const runAgent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        text: 'too late', sources: [], usage: {}, outcome: 'completed', writeAttempts: [],
      };
    });
    const setup = dependencies({
      runAgent,
    });
    const worker = new MessageWorker({
      ...setup.options,
      processingDeadlineMs: 5,
      leaseMs: 100,
    });

    await worker.process(storedEvent());

    expect(setup.eventStore.retried?.errorCode).toBe('processing_deadline_exceeded');
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('answers with sources, transfers terminal Typing ownership, and completes in durable order', async () => {
    const setup = dependencies();
    setup.eventStore.terminalProcessingReactionId = 'reaction_1';
    const worker = new MessageWorker(setup.options);
    await worker.process(storedEvent({
      processingReactionId: 'reaction_1',
    }));

    expect(setup.runAgent).toHaveBeenCalledOnce();
    expect(setup.messenger.addReaction).not.toHaveBeenCalled();
    expect(setup.eventStore.marked?.key).toMatch(/^minori-[a-f0-9]{32}$/u);
    expect(setup.messenger.replyRichContent).toHaveBeenCalledWith(
      'om_1',
      expect.stringContaining('[1] 设计稿 — https://example.com/design'),
      setup.eventStore.marked?.key,
    );
    expect(setup.messenger.replyRichContent.mock.calls[0]?.[1])
      .toContain('[2] 发布说明 — https://example.com/release');
    expect(setup.eventStore.marked?.kind).toBe('rich');
    expect(setup.messenger.replyText).not.toHaveBeenCalled();
    expect(setup.appended.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
      { messageId: 'om_1', role: 'user' },
      { messageId: 'om_reply_1', role: 'assistant' },
    ]);
    expect(setup.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
    expect(setup.eventStore.calls.indexOf('markReplyStarted'))
      .toBeLessThan(setup.eventStore.calls.indexOf('complete'));
  });

  it('runs a claimed private event without an authorization dependency', async () => {
    const setup = dependencies();
    const privateMessage = { ...message(), chatType: 'p2p' as const, conversationKey: 'oc_1' };

    await new MessageWorker(setup.options).process(storedEvent({
      eventId: 'evt_private', payload: privateMessage, attempts: 1,
    }));

    expect(setup.runAgent).toHaveBeenCalledWith(
      privateMessage, 1, expect.any(AbortSignal),
    );
    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
  });

  it('durably bounds conversation-store failures', async () => {
    const conversation = dependencies({
      conversations: {
        getOrCreateConversation: vi.fn(async () => { throw new Error('database secret'); }),
        append: vi.fn(),
      },
    });
    await new MessageWorker(conversation.options).process(storedEvent({
      eventId: 'evt_1', payload: message(), attempts: 3,
    }));
    expect(conversation.eventStore.completed).toEqual({ errorCode: 'conversation_store_failed' });
    expect(conversation.runAgent).not.toHaveBeenCalled();
  });

  it('explicitly replies to unsupported content without invoking the Agent', async () => {
    const setup = dependencies();
    await new MessageWorker(setup.options).process(storedEvent({
      eventId: 'evt_1',
      payload: message({ kind: 'unsupported', sourceMessageType: 'file' }),
      attempts: 1,
    }));
    expect(setup.runAgent).not.toHaveBeenCalled();
    expect(setup.messenger.replyText.mock.calls[0]?.[1]).toContain('暂不支持');
    expect(setup.messenger.replyRichContent).not.toHaveBeenCalled();
    expect(setup.eventStore.marked?.kind).toBe('control');
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  });

  it('keeps a terminal event complete when reaction removal fails', async () => {
    const setup = dependencies();
    setup.eventStore.terminalProcessingReactionId = 'reaction_1';
    setup.messenger.removeReaction.mockRejectedValueOnce(new Error('reaction api secret'));
    await new MessageWorker(setup.options).process(storedEvent({
      eventId: 'evt_1', payload: message(), attempts: 1, processingReactionId: 'reaction_1',
    }));
    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  });

  it('retries transient Agent failures, then emits a truthful temporary-error reply', async () => {
    const first = dependencies({ runAgent: vi.fn(async () => { throw new Error('model key secret'); }) });
    await new MessageWorker(first.options).process(storedEvent({
      eventId: 'evt_1', payload: message(), attempts: 1,
    }));
    expect(first.eventStore.retried?.errorCode).toBe('agent_failed');
    expect(first.messenger.replyText).not.toHaveBeenCalled();
    expect(first.messenger.replyRichContent).not.toHaveBeenCalled();

    const last = dependencies({ runAgent: vi.fn(async () => { throw new Error('lark auth secret'); }) });
    await new MessageWorker(last.options).process(storedEvent({
      eventId: 'evt_1', payload: message(), attempts: 3,
    }));
    const text = last.messenger.replyText.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('暂时无法完成');
    expect(text).not.toContain('知识库没有');
    expect(last.messenger.replyRichContent).not.toHaveBeenCalled();
    expect(last.eventStore.marked?.kind).toBe('control');
  });

  it('keeps one persisted Typing reaction through retry and removes it once after recovery', async () => {
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error('model key secret'))
      .mockResolvedValueOnce({
        text: 'recovered answer', sources: [], usage: {},
        outcome: 'completed', writeAttempts: [],
      });
    const setup = dependencies({ runAgent });
    setup.eventStore.terminalProcessingReactionId = 'reaction_1';
    const worker = new MessageWorker(setup.options);

    await worker.process(storedEvent({
      processingReactionId: 'reaction_1',
    }));
    expect(setup.eventStore.retried?.errorCode).toBe('agent_failed');
    expect(setup.messenger.removeReaction).not.toHaveBeenCalled();

    await worker.process(storedEvent({
      attempts: 2,
      processingReactionId: 'reaction_1',
    }));
    expect(setup.messenger.removeReaction).toHaveBeenCalledTimes(1);
    expect(setup.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
  });

  it('sends a natural source-linked answer without a citation repair flow', async () => {
    const natural: AgentReply = {
      text: '发布是在周五。',
      sources: [{ id: 1, title: '发布计划', url: 'https://example.com/plan' }], usage: {},
      outcome: 'completed', writeAttempts: [],
    };
    const setup = dependencies({ runAgent: vi.fn(async () => natural) });

    await new MessageWorker(setup.options).process(storedEvent());

    expect(setup.messenger.replyRichContent.mock.calls[0]?.[1]).toBe([
      '发布是在周五。', '', 'Sources:', '[1] 发布计划 — https://example.com/plan',
    ].join('\n'));
  });

  it('never downgrades an ambiguous rich reply to a second plain-text send', async () => {
    const setup = dependencies();
    setup.messenger.replyRichContent.mockRejectedValueOnce(
      new Error('connection_lost_after_accept'),
    );

    await new MessageWorker(setup.options).process(storedEvent());

    expect(setup.eventStore.retried?.errorCode).toBe('reply_failed');
    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
    expect(setup.messenger.replyText).not.toHaveBeenCalled();
  });

  it('waits for an in-flight Progress Reply before final reply delivery', async () => {
    const setup = dependencies();
    setup.eventStore.terminalProcessingReactionId = 'reaction_1';
    let resolveProgress!: (messageId: string) => void;
    setup.messenger.replyText.mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveProgress = resolve;
      }));
    const worker = new MessageWorker(setup.options);

    const processing = worker.process(storedEvent({
      receivedAt: new Date('2026-08-05T00:59:00.000Z'),
      processingReactionId: 'reaction_1',
    }));
    await vi.waitFor(() => expect(setup.messenger.replyText).toHaveBeenCalledOnce());
    expect(setup.messenger.replyText).toHaveBeenNthCalledWith(
      1,
      'om_1',
      PROGRESS_REPLY_TEXT,
      expect.stringMatching(/^minori-progress-[a-f0-9]{32}$/u),
    );
    expect(setup.eventStore.marked).toBeUndefined();
    expect(setup.messenger.removeReaction).not.toHaveBeenCalled();

    resolveProgress('om_progress_1');
    await processing;
    expect(setup.messenger.replyText).toHaveBeenCalledOnce();
    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
    expect(setup.messenger.replyRichContent.mock.calls[0]?.[1]).toContain(
      '发布说明和设计稿都已核对。',
    );
    expect(setup.eventStore.calls.indexOf('confirmProgress'))
      .toBeLessThan(setup.eventStore.calls.indexOf('markReplyStarted'));
    expect(setup.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
  });

  it('continues to one final reply when Progress Reply delivery fails', async () => {
    const setup = dependencies();
    setup.messenger.replyText.mockRejectedValueOnce(new Error('provider secret'));

    await new MessageWorker(setup.options).process(storedEvent({
      receivedAt: new Date('2026-08-05T00:59:00.000Z'),
    }));

    expect(setup.messenger.replyText).toHaveBeenCalledOnce();
    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
    expect(setup.options.logger.warn).toHaveBeenCalledWith(
      { eventId: 'evt_1', errorCode: 'progress_reply_failed' },
      'progress reply failed',
    );
    expect(JSON.stringify(setup.options.logger.warn.mock.calls)).not.toContain('provider secret');
  });

  it('does not append Progress Reply to Retained Conversation History', async () => {
    const setup = dependencies();
    await new MessageWorker(setup.options).process(storedEvent({
      receivedAt: new Date('2026-08-05T00:59:00.000Z'),
    }));

    expect(setup.appended.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
      { messageId: 'om_1', role: 'user' },
      { messageId: 'om_reply_1', role: 'assistant' },
    ]);
    expect(setup.appended.map(({ content }) => content)).not.toContain(PROGRESS_REPLY_TEXT);
  });

  it.each([
    ['step_limit_reached', '已达到本次执行步数上限。'],
    ['timeout_reached', '已达到本次执行时间上限。'],
    ['interrupted_after_write', '本次执行在写入开始后中断。'],
  ] as const)('sends a terminal %s reply once without retrying the Agent run', async (
    outcome,
    text,
  ) => {
    const setup = dependencies({
      runAgent: vi.fn(async (): Promise<AgentReply> => ({
        text,
        sources: [],
        usage: {},
        outcome,
        writeAttempts: [],
      })),
    });

    await new MessageWorker(setup.options).process(storedEvent());

    expect(setup.messenger.replyRichContent).toHaveBeenCalledOnce();
    expect(setup.messenger.replyRichContent).toHaveBeenCalledWith(
      'om_1', text, expect.stringMatching(/^minori-/u),
    );
    expect(setup.messenger.replyText).not.toHaveBeenCalled();
    expect(setup.eventStore.retried).toBeUndefined();
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  });
});
