import { describe, expect, it, vi } from 'vitest';
import type { AgentReply } from '../../src/agent/run.js';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import type { EventStore, StoredEvent } from '../../src/storage/event-store.js';
import { MessageWorker } from '../../src/worker/message-worker.js';

function message(content: NormalizedMessage['content'] = {
  kind: 'text', text: '发布流程是什么？', feishuLinks: [],
}): NormalizedMessage {
  return {
    eventId: 'evt_1', messageId: 'om_1', chatId: 'oc_1',
    conversationKey: 'oc_1:om_root', rootId: 'om_root', senderOpenId: 'ou_1',
    chatType: 'group', content, occurredAt: new Date('2026-08-05T00:00:00Z'),
  };
}

class FakeEventStore implements EventStore {
  calls: string[] = [];
  marked?: { key: string; attemptedAt: Date; text?: string };
  completed?: { replyMessageId?: string; errorCode?: string };
  retried?: { errorCode: string; nextAttemptAt: Date };
  async enqueue() { return 'queued' as const; }
  async claimReady() { return []; }
  async complete(_eventId: string, _attempt: number, outcome: typeof this.completed) {
    this.calls.push('complete'); this.completed = outcome;
  }
  async markReplyStarted(
    _eventId: string, _attempt: number, key: string, attemptedAt: Date, text?: string,
  ) {
    this.calls.push('markReplyStarted'); this.marked = { key, attemptedAt, ...(text ? { text } : {}) };
  }
  async saveProcessingReaction(_eventId: string, _attempt: number, reactionId: string) {
    this.calls.push(`saveReaction:${reactionId}`);
  }
  async clearProcessingReaction() { this.calls.push('clearReaction'); }
  async markReplyUncertain() { this.calls.push('uncertain'); }
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
  }));
  const messenger = {
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReaction: vi.fn(async () => undefined),
    replyText: vi.fn(async () => 'om_reply_1'),
  };
  return {
    eventStore,
    appended,
    runAgent,
    messenger,
    options: {
      eventStore,
      membership: { authorize: vi.fn(async () => ({ allowed: true as const })) },
      conversations: {
        getOrCreateConversation: vi.fn(async () => 'conversation_1'),
        append: vi.fn(async (entry) => { appended.push(entry); }),
      },
      runAgent,
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

  it('stops a hung event before its lease and durably retries it', async () => {
    const setup = dependencies({
      membership: { authorize: vi.fn(() => new Promise(() => undefined)) },
    });
    const worker = new MessageWorker({
      ...setup.options,
      processingDeadlineMs: 5,
      leaseMs: 100,
    });

    await worker.process({ eventId: 'evt_1', payload: message(), attempts: 1 });

    expect(setup.eventStore.retried?.errorCode).toMatch(
      /^(membership_check_failed|processing_deadline_exceeded)$/u,
    );
    expect(setup.runAgent).not.toHaveBeenCalled();
  });

  it('persists, answers with sources, cleans Typing, and completes in durable order', async () => {
    const setup = dependencies();
    const worker = new MessageWorker(setup.options);
    await worker.process({ eventId: 'evt_1', payload: message(), attempts: 1 });

    expect(setup.runAgent).toHaveBeenCalledOnce();
    expect(setup.messenger.addReaction).toHaveBeenCalledWith('om_1', 'Typing');
    expect(setup.eventStore.marked?.key).toMatch(/^minori-[a-f0-9]{32}$/u);
    expect(setup.messenger.replyText).toHaveBeenCalledWith(
      'om_1',
      expect.stringContaining('[1] 设计稿 — https://example.com/design'),
      setup.eventStore.marked?.key,
    );
    expect(setup.messenger.replyText.mock.calls[0]?.[1])
      .toContain('[2] 发布说明 — https://example.com/release');
    expect(setup.appended.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
      { messageId: 'om_1', role: 'user' },
      { messageId: 'om_reply_1', role: 'assistant' },
    ]);
    expect(setup.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
    expect(setup.eventStore.calls.indexOf('markReplyStarted'))
      .toBeLessThan(setup.eventStore.calls.indexOf('complete'));
  });

  it('completes ineligible events without invoking the Agent or messenger', async () => {
    const setup = dependencies({
      membership: { authorize: vi.fn(async () => ({
        allowed: false as const, reason: 'not_team_member' as const,
      })) },
    });
    await new MessageWorker(setup.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(setup.runAgent).not.toHaveBeenCalled();
    expect(setup.messenger.replyText).not.toHaveBeenCalled();
    expect(setup.eventStore.completed).toEqual({ errorCode: 'not_team_member' });
  });

  it('durably bounds membership and conversation-store failures', async () => {
    const membership = dependencies({
      membership: { authorize: vi.fn(async () => { throw new Error('membership secret'); }) },
    });
    await new MessageWorker(membership.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(membership.eventStore.retried?.errorCode).toBe('membership_check_failed');

    const unavailable = dependencies({
      membership: { authorize: vi.fn(async () => ({
        allowed: false as const, reason: 'membership_unavailable' as const,
      })) },
    });
    await new MessageWorker(unavailable.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(unavailable.eventStore.retried?.errorCode).toBe('membership_check_failed');

    const conversation = dependencies({
      conversations: {
        getOrCreateConversation: vi.fn(async () => { throw new Error('database secret'); }),
        append: vi.fn(),
      },
    });
    await new MessageWorker(conversation.options).process({
      eventId: 'evt_1', payload: message(), attempts: 3,
    });
    expect(conversation.eventStore.completed).toEqual({ errorCode: 'conversation_store_failed' });
    expect(conversation.runAgent).not.toHaveBeenCalled();
  });

  it('explicitly replies to unsupported content without invoking the Agent', async () => {
    const setup = dependencies();
    await new MessageWorker(setup.options).process({
      eventId: 'evt_1',
      payload: message({ kind: 'unsupported', sourceMessageType: 'file' }),
      attempts: 1,
    });
    expect(setup.runAgent).not.toHaveBeenCalled();
    expect(setup.messenger.replyText.mock.calls[0]?.[1]).toContain('暂不支持');
    expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  });

  it('continues when reaction creation or removal fails', async () => {
    const setup = dependencies();
    setup.messenger.addReaction.mockRejectedValueOnce(new Error('reaction api secret'));
    await new MessageWorker(setup.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(setup.messenger.replyText).toHaveBeenCalledOnce();

    const second = dependencies();
    second.messenger.removeReaction.mockRejectedValueOnce(new Error('reaction api secret'));
    await new MessageWorker(second.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(second.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  });

  it('retries transient Agent failures, then emits a truthful temporary-error reply', async () => {
    const first = dependencies({ runAgent: vi.fn(async () => { throw new Error('model key secret'); }) });
    await new MessageWorker(first.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });
    expect(first.eventStore.retried?.errorCode).toBe('agent_failed');
    expect(first.messenger.replyText).not.toHaveBeenCalled();

    const last = dependencies({ runAgent: vi.fn(async () => { throw new Error('lark auth secret'); }) });
    await new MessageWorker(last.options).process({
      eventId: 'evt_1', payload: message(), attempts: 3,
    });
    const text = last.messenger.replyText.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('暂时无法完成');
    expect(text).not.toContain('知识库没有');
  });

  it('sends a natural source-linked answer without a citation repair flow', async () => {
    const natural: AgentReply = {
      text: '发布是在周五。',
      sources: [{ id: 1, title: '发布计划', url: 'https://example.com/plan' }], usage: {},
    };
    const setup = dependencies({ runAgent: vi.fn(async () => natural) });

    await new MessageWorker(setup.options).process({
      eventId: 'evt_1', payload: message(), attempts: 1,
    });

    expect(setup.messenger.replyText.mock.calls[0]?.[1]).toBe([
      '发布是在周五。', '', 'Sources:', '[1] 发布计划 — https://example.com/plan',
    ].join('\n'));
  });
});
