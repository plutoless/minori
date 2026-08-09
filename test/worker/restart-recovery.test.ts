import { describe, expect, it, vi } from 'vitest';
import type { StoredEvent } from '../../src/storage/event-store.js';
import { MessageWorker } from '../../src/worker/message-worker.js';

function recovered(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: 'evt_crash', attempts: 2,
    payload: {
      eventId: 'evt_crash', messageId: 'om_1', chatId: 'oc_1',
      conversationKey: 'oc_1:om_root', senderOpenId: 'ou_1', chatType: 'group',
      content: { kind: 'text', text: 'hello', feishuLinks: [] },
      occurredAt: new Date('2026-08-05T00:00:00Z'),
    },
    replyIdempotencyKey: 'minori-1234567890abcdef1234567890abcdef',
    replyAttemptedAt: new Date('2026-08-05T00:30:00Z'),
    preparedReplyText: 'durably prepared answer',
    processingReactionId: 'stale_reaction',
    ...overrides,
  };
}

function setup(now: Date) {
  const calls: string[] = [];
  const accepted = new Map<string, string>();
  const replyText = vi.fn(async (_messageId: string, _text: string, key: string) => {
    const prior = accepted.get(key);
    if (prior) return prior;
    accepted.set(key, 'om_reply_once');
    return 'om_reply_once';
  });
  const eventStore = {
    enqueue: vi.fn(), claimReady: vi.fn(async () => []), recoverExpiredLeases: vi.fn(async () => 0),
    attachProcessingReaction: vi.fn(async () => true),
    markReplyStarted: vi.fn(async () => { calls.push('mark'); }),
    retry: vi.fn(async () => { calls.push('retry'); }),
    complete: vi.fn(async () => {
      calls.push('complete');
      return { processingReactionId: 'stale_reaction' };
    }),
    markReplyUncertain: vi.fn(async () => {
      calls.push('uncertain');
      return { processingReactionId: 'stale_reaction' };
    }),
  };
  const messenger = {
    addReaction: vi.fn(async () => null), replyText,
    removeReaction: vi.fn(async () => { calls.push('remove'); }),
  };
  const runAgent = vi.fn();
  const logger = { warn: vi.fn(), info: vi.fn() };
  const worker = new MessageWorker({
    eventStore,
    conversations: {
      getOrCreateConversation: vi.fn(async () => 'conversation_1'),
      append: vi.fn(async () => undefined),
    },
    runAgent, messenger,
    logger,
    now: () => now,
  });
  return { worker, eventStore, messenger, runAgent, logger, calls, accepted };
}

describe('MessageWorker restart recovery', () => {
  it('does not duplicate a reply accepted just before the first worker loses confirmation', async () => {
    let marked: { key: string; attemptedAt: Date; text: string } | undefined;
    const accepted = new Map<string, string>();
    let loseFirstConfirmation = true;
    const replyText = vi.fn(async (_messageId: string, _text: string, key: string) => {
      const messageId = accepted.get(key) ?? 'om_reply_once';
      accepted.set(key, messageId);
      if (loseFirstConfirmation) {
        loseFirstConfirmation = false;
        throw new Error('connection_lost_after_accept');
      }
      return messageId;
    });
    const eventStore = {
      enqueue: vi.fn(), claimReady: vi.fn(async () => []), recoverExpiredLeases: vi.fn(async () => 0),
      attachProcessingReaction: vi.fn(async () => true),
      complete: vi.fn(async () => ({})),
      markReplyUncertain: vi.fn(async () => ({})),
      retry: vi.fn(async () => undefined),
      markReplyStarted: vi.fn(async (
        _eventId: string, _attempt: number, key: string, attemptedAt: Date, text: string,
      ) => { marked = { key, attemptedAt, text }; }),
    };
    const runAgent = vi.fn(async () => ({ text: 'prepared answer', sources: [], usage: {} }));
    const worker = new MessageWorker({
      eventStore,
      conversations: {
        getOrCreateConversation: vi.fn(async () => 'conversation_1'),
        append: vi.fn(async () => undefined),
      },
      runAgent,
      messenger: {
        addReaction: vi.fn(async () => null),
        removeReaction: vi.fn(async () => undefined),
        replyText,
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      now: () => new Date('2026-08-05T01:00:00Z'),
    });
    const initial = recovered({ attempts: 1 });
    delete initial.replyIdempotencyKey;
    delete initial.replyAttemptedAt;
    delete initial.preparedReplyText;
    delete initial.processingReactionId;
    await worker.process(initial);
    expect(eventStore.retry).toHaveBeenCalledWith(
      'evt_crash', 1, 'reply_failed', expect.any(Date),
    );
    expect(marked).toBeDefined();

    const replay = recovered({
      attempts: 2,
      replyIdempotencyKey: marked!.key,
      replyAttemptedAt: marked!.attemptedAt,
      preparedReplyText: marked!.text,
    });
    delete replay.processingReactionId;
    await worker.process(replay);

    expect(replyText).toHaveBeenCalledTimes(2);
    expect(replyText.mock.calls[0]?.[2]).toBe(replyText.mock.calls[1]?.[2]);
    expect(accepted.size).toBe(1);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(eventStore.complete).toHaveBeenCalledWith(
      'evt_crash', 2, { replyMessageId: 'om_reply_once' },
    );
  });

  it('replays a recent accepted reply and removes Typing only after terminal completion', async () => {
    const state = setup(new Date('2026-08-05T01:00:00Z'));
    const event = recovered();
    await state.worker.process(event);

    expect(state.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'stale_reaction');
    expect(state.runAgent).not.toHaveBeenCalled();
    expect(state.messenger.replyText).toHaveBeenCalledWith(
      'om_1', 'durably prepared answer', event.replyIdempotencyKey,
    );
    expect(state.eventStore.markReplyStarted).not.toHaveBeenCalled();
    expect(state.eventStore.complete).toHaveBeenCalledWith(
      'evt_crash', 2, { replyMessageId: 'om_reply_once' },
    );
    expect(state.calls.slice(-2)).toEqual(['complete', 'remove']);
  });

  it('marks a reply uncertain after the one-hour deduplication window', async () => {
    const state = setup(new Date('2026-08-05T02:00:01Z'));
    await state.worker.process(recovered());

    expect(state.calls.slice(0, 2)).toEqual(['uncertain', 'remove']);
    expect(state.eventStore.markReplyUncertain).toHaveBeenCalledWith('evt_crash', 2);
    expect(state.messenger.replyText).not.toHaveBeenCalled();
    expect(state.runAgent).not.toHaveBeenCalled();
    expect(state.logger.warn).toHaveBeenCalledWith(
      { eventId: 'evt_crash', errorCode: 'reply_uncertain' },
      'reply outcome is uncertain',
    );
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain('durably prepared answer');
  });
});
