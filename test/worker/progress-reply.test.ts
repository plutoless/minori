import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredEvent } from '../../src/storage/event-store.js';
import {
  PROGRESS_REPLY_TEXT,
  startProgressReply,
} from '../../src/worker/progress-reply.js';

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: 'evt_1',
    attempts: 1,
    receivedAt: new Date('2026-08-11T10:00:00.000Z'),
    payload: {
      eventId: 'evt_1',
      messageId: 'om_1',
      chatId: 'oc_1',
      conversationKey: 'oc_1',
      senderOpenId: 'ou_1',
      chatType: 'p2p',
      content: { kind: 'text', text: 'summarize the wiki', feishuLinks: [] },
      occurredAt: new Date('2026-08-11T10:00:00.000Z'),
    },
    ...overrides,
  };
}

function setup(overrides: Partial<StoredEvent> = {}) {
  const calls: string[] = [];
  const eventStore = {
    markProgressAttempted: vi.fn(async () => {
      calls.push('mark');
      return true;
    }),
    confirmProgressSent: vi.fn(async () => {
      calls.push('confirm');
      return true;
    }),
  };
  const messenger = {
    replyText: vi.fn(async () => {
      calls.push('send');
      return 'om_progress_1';
    }),
  };
  const logger = { warn: vi.fn() };
  return {
    event: event(overrides),
    calls,
    eventStore,
    messenger,
    logger,
    dependencies: {
      eventStore,
      messenger,
      logger,
      now: () => new Date(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Progress Reply', () => {
  it('cancels before 20 seconds without a durable attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:00:00.000Z'));
    const state = setup();
    const handle = startProgressReply(state.event, state.dependencies);

    await vi.advanceTimersByTimeAsync(19_999);
    await handle.settle();

    expect(state.eventStore.markProgressAttempted).not.toHaveBeenCalled();
    expect(state.messenger.replyText).not.toHaveBeenCalled();
  });

  it('marks before sending exactly once at 20 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:00:00.000Z'));
    const state = setup();
    const handle = startProgressReply(state.event, state.dependencies);

    await vi.advanceTimersByTimeAsync(20_000);
    await handle.settle();

    expect(state.calls).toEqual(['mark', 'send', 'confirm']);
    expect(state.messenger.replyText).toHaveBeenCalledWith(
      'om_1',
      PROGRESS_REPLY_TEXT,
      expect.stringMatching(/^minori-progress-[a-f0-9]{32}$/u),
    );
  });

  it('starts immediately for a claim received more than 20 seconds ago', async () => {
    const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
    const handle = startProgressReply(state.event, {
      ...state.dependencies,
      now: () => new Date('2026-08-11T10:00:00.000Z'),
    });

    await handle.settle();

    expect(state.messenger.replyText).toHaveBeenCalledOnce();
  });

  it('does not start for unsupported, final-started, or previously attempted events', async () => {
    const base = event({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
    for (const candidate of [
      {
        ...base,
        payload: {
          ...base.payload,
          content: { kind: 'unsupported' as const, sourceMessageType: 'image' },
        },
      },
      { ...base, replyAttemptedAt: new Date('2026-08-11T09:59:30.000Z') },
      { ...base, progressAttemptedAt: new Date('2026-08-11T09:59:20.000Z') },
    ]) {
      const state = setup(candidate);
      await startProgressReply(candidate, {
        ...state.dependencies,
        now: () => new Date('2026-08-11T10:00:00.000Z'),
      }).settle();
      expect(state.messenger.replyText).not.toHaveBeenCalled();
    }
  });

  it('logs one stable failure and never rejects the worker path', async () => {
    const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
    state.messenger.replyText.mockRejectedValueOnce(new Error('provider secret'));

    await expect(startProgressReply(state.event, {
      ...state.dependencies,
      now: () => new Date('2026-08-11T10:00:00.000Z'),
    }).settle()).resolves.toBeUndefined();

    expect(state.logger.warn).toHaveBeenCalledWith(
      { eventId: 'evt_1', errorCode: 'progress_reply_failed' },
      'progress reply failed',
    );
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain('provider secret');
  });

  it('does not let a delayed admission marker hold or start delivery after final settlement', async () => {
    let resolveAdmission!: (admitted: boolean) => void;
    const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
    state.eventStore.markProgressAttempted.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveAdmission = resolve; }),
    );
    const handle = startProgressReply(state.event, {
      ...state.dependencies,
      now: () => new Date('2026-08-11T10:00:00.000Z'),
    });
    await vi.waitFor(() => expect(state.eventStore.markProgressAttempted).toHaveBeenCalledOnce());

    await expect(handle.settle()).resolves.toBeUndefined();
    resolveAdmission(true);
    await vi.waitFor(() => expect(state.eventStore.markProgressAttempted).toHaveResolved());

    expect(state.messenger.replyText).not.toHaveBeenCalled();
  });

  it('waits for visible delivery but not a delayed confirmation write', async () => {
    let resolveConfirmation!: (confirmed: boolean) => void;
    const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
    state.eventStore.confirmProgressSent.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }),
    );
    const handle = startProgressReply(state.event, {
      ...state.dependencies,
      now: () => new Date('2026-08-11T10:00:00.000Z'),
    });
    await vi.waitFor(() => expect(state.messenger.replyText).toHaveBeenCalledOnce());

    await expect(handle.settle()).resolves.toBeUndefined();
    resolveConfirmation(true);
    await vi.waitFor(() => expect(state.eventStore.confirmProgressSent).toHaveResolved());
  });
});
