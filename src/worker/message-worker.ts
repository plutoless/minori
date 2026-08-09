import { createHash } from 'node:crypto';
import type { AgentReply } from '../agent/run.js';
import type { NormalizedMessage } from '../contracts/messages.js';
import type { FeishuMessenger } from '../feishu/client.js';
import type { ConversationStore } from '../storage/conversation-store.js';
import type { EventStore, StoredEvent } from '../storage/event-store.js';
import { formatAgentReply } from './source-format.js';

const UNSUPPORTED_REPLY = '我暂不支持直接读取这种消息类型。请发送文字、富文本，或粘贴飞书文档链接。';
const TEMPORARY_ERROR_REPLY = '我暂时无法完成这次查询，请稍后重试。';
const DEADLINE_DRAIN_MS = 2 * 60 * 1_000;

type WorkerLogger = {
  warn(bindings: Record<string, unknown>, message: string): unknown;
  info(bindings: Record<string, unknown>, message: string): unknown;
};

export type MessageWorkerOptions = {
  eventStore: EventStore;
  conversations: Pick<ConversationStore, 'getOrCreateConversation' | 'append'>;
  runAgent(message: NormalizedMessage, signal?: AbortSignal): Promise<AgentReply>;
  messenger: FeishuMessenger;
  logger: WorkerLogger;
  now?: () => Date;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  processingDeadlineMs?: number;
  replyDeduplicationMs?: number;
  recoverLimit?: number;
  recoveryIntervalMs?: number;
  signal?: AbortSignal;
};

class RetryableProcessingError extends Error {
  constructor(readonly errorCode: 'agent_failed' | 'reply_failed') {
    super(errorCode);
    this.name = 'RetryableProcessingError';
  }
}

function stableReplyKey(eventId: string) {
  const digest = createHash('sha256').update(`reply:v1:${eventId}`).digest('hex').slice(0, 32);
  return `minori-${digest}`;
}

export class MessageWorker {
  private readonly now: () => Date;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly processingDeadlineMs: number;
  private readonly replyDeduplicationMs: number;
  private readonly recoverLimit: number;
  private readonly recoveryIntervalMs: number;
  private stopping = true;
  private loops: Promise<void>[] = [];
  private readonly wakeResolvers = new Set<() => void>();
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private recoveryRun: Promise<void> | undefined;

  constructor(private readonly options: MessageWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.concurrency = options.concurrency ?? 4;
    this.pollMs = options.pollMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 20 * 60 * 1_000;
    this.processingDeadlineMs = options.processingDeadlineMs ?? 15 * 60 * 1_000;
    this.replyDeduplicationMs = options.replyDeduplicationMs ?? 60 * 60 * 1_000;
    this.recoverLimit = options.recoverLimit ?? 100;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
    if (this.concurrency < 1 || this.pollMs < 1 || this.leaseMs < 1
      || this.processingDeadlineMs < 1 || this.processingDeadlineMs >= this.leaseMs
      || this.recoveryIntervalMs < 1) {
      throw new Error('invalid_worker_options');
    }
  }

  wake(): void {
    for (const resolve of [...this.wakeResolvers]) resolve();
  }

  async start(): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    await this.recoverExpiredLeases();
    this.recoveryTimer = setInterval(() => {
      void this.recoverExpiredLeases().catch(() => undefined);
    }, this.recoveryIntervalMs);
    this.recoveryTimer.unref?.();
    this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    this.wake();
    await Promise.all(this.loops);
    await this.recoveryRun;
    this.loops = [];
  }

  async process(event: StoredEvent): Promise<void> {
    const signal = AbortSignal.timeout(this.processingDeadlineMs);
    const state = { replyStarted: event.replyAttemptedAt !== undefined };
    try {
      await this.processWithinDeadline(event, signal, state);
    } catch (error) {
      if (!signal.aborted) throw error;
      if (state.replyStarted) {
        await this.options.eventStore.retry(
          event.eventId,
          event.attempts,
          'processing_deadline_exceeded',
          this.nextAttemptAt(event.attempts, DEADLINE_DRAIN_MS),
        );
      } else {
        await this.failBeforeReply(
          event,
          'processing_deadline_exceeded',
          DEADLINE_DRAIN_MS,
        );
      }
    }
  }

  private async processWithinDeadline(
    event: StoredEvent,
    signal: AbortSignal,
    state: { replyStarted: boolean },
  ): Promise<void> {
    await this.removePersistedReaction(event, signal);

    const replyAttemptedAt = event.replyAttemptedAt;
    const recoveringReply = replyAttemptedAt !== undefined;
    if (replyAttemptedAt) {
      const elapsed = this.now().getTime() - replyAttemptedAt.getTime();
      if (elapsed >= this.replyDeduplicationMs
        || !event.replyIdempotencyKey
        || !event.preparedReplyText) {
        this.options.logger.warn(
          { eventId: event.eventId, errorCode: 'reply_uncertain' },
          'reply outcome is uncertain',
        );
        await this.options.eventStore.markReplyUncertain(event.eventId, event.attempts);
        return;
      }
    }

    let conversationId: string;
    try {
      conversationId = await this.withAbort(this.options.conversations.getOrCreateConversation({
        conversationKey: event.payload.conversationKey,
        chatId: event.payload.chatId,
        type: event.payload.chatType,
      }), signal);
      await this.withAbort(this.options.conversations.append({
        messageId: event.payload.messageId,
        conversationId,
        role: 'user',
        senderOpenId: event.payload.senderOpenId,
        content: event.payload.content.kind === 'text'
          ? event.payload.content.text
          : `[unsupported:${event.payload.content.sourceMessageType}]`,
        createdAt: event.payload.occurredAt,
      }), signal);
    } catch {
      if (recoveringReply) {
        await this.options.eventStore.retry(
          event.eventId,
          event.attempts,
          'conversation_store_failed',
          this.nextAttemptAt(event.attempts, signal.aborted ? DEADLINE_DRAIN_MS : 0),
        );
      } else {
        await this.failBeforeReply(
          event,
          signal.aborted ? 'processing_deadline_exceeded' : 'conversation_store_failed',
          signal.aborted ? DEADLINE_DRAIN_MS : 0,
        );
      }
      return;
    }

    let reactionId: string | null = null;
    let retryError: RetryableProcessingError | undefined;
    let replyMessageId: string | undefined;
    let sentReplyText: string | undefined;
    try {
      if (!event.replyAttemptedAt) {
        reactionId = await this.addReaction(event, signal);
      }
      const prepared = event.replyAttemptedAt
        ? {
          text: event.preparedReplyText!,
          key: event.replyIdempotencyKey!,
          attemptedAt: event.replyAttemptedAt,
        }
        : await this.prepareReply(event, signal, state);
      sentReplyText = prepared.text;
      try {
        replyMessageId = await this.withAbort(this.options.messenger.replyText(
          event.payload.messageId,
          prepared.text,
          prepared.key,
        ), signal);
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new RetryableProcessingError('reply_failed');
      }
    } catch (error) {
      if (error instanceof RetryableProcessingError) retryError = error;
      else throw error;
    } finally {
      if (reactionId) await this.removeCurrentReaction(event, reactionId);
    }

    if (retryError) {
      await this.options.eventStore.retry(
        event.eventId,
        event.attempts,
        retryError.errorCode,
        this.nextAttemptAt(event.attempts),
      );
      return;
    }
    if (!replyMessageId) throw new Error('reply_message_id_unavailable');

    if (!sentReplyText) throw new Error('prepared_reply_unavailable');
    await this.withAbort(this.options.conversations.append({
      messageId: replyMessageId,
      conversationId,
      role: 'assistant',
      content: sentReplyText,
      createdAt: this.now(),
    }), signal);
    await this.options.eventStore.complete(event.eventId, event.attempts, { replyMessageId });
  }

  private async prepareReply(
    event: StoredEvent,
    signal: AbortSignal,
    state: { replyStarted: boolean },
  ) {
    let text: string;
    if (event.payload.content.kind === 'unsupported') {
      text = UNSUPPORTED_REPLY;
    } else {
      let reply: AgentReply;
      try {
        const runSignal = this.options.signal
          ? AbortSignal.any([this.options.signal, signal])
          : signal;
        reply = await this.options.runAgent(event.payload, runSignal);
      } catch {
        if (signal.aborted) throw signal.reason;
        if (event.attempts < 3) throw new RetryableProcessingError('agent_failed');
        text = TEMPORARY_ERROR_REPLY;
        return this.persistPreparedReply(event, text, signal, state);
      }
      text = formatAgentReply(reply);
    }
    return this.persistPreparedReply(event, text, signal, state);
  }

  private async persistPreparedReply(
    event: StoredEvent,
    text: string,
    signal: AbortSignal,
    state: { replyStarted: boolean },
  ) {
    const key = stableReplyKey(event.eventId);
    const attemptedAt = this.now();
    await this.withAbort(this.options.eventStore.markReplyStarted(
      event.eventId,
      event.attempts,
      key,
      attemptedAt,
      text,
    ), signal);
    state.replyStarted = true;
    return { text, key, attemptedAt };
  }

  private async addReaction(event: StoredEvent, signal: AbortSignal) {
    let reactionId: string | null = null;
    try {
      reactionId = await this.withAbort(
        this.options.messenger.addReaction(event.payload.messageId, 'Typing'),
        signal,
      );
      if (reactionId) {
        await this.withAbort(this.options.eventStore.saveProcessingReaction(
          event.eventId,
          event.attempts,
          reactionId,
        ), signal);
      }
    } catch {
      this.options.logger.warn(
        { eventId: event.eventId, errorCode: 'reaction_add_failed' },
        'reaction add failed',
      );
    }
    return reactionId;
  }

  private async removePersistedReaction(event: StoredEvent, signal: AbortSignal) {
    if (!event.processingReactionId) return;
    try {
      await this.withAbort(this.options.messenger.removeReaction(
        event.payload.messageId,
        event.processingReactionId,
      ), signal);
    } catch {
      this.options.logger.warn(
        { eventId: event.eventId, errorCode: 'reaction_remove_failed' },
        'reaction remove failed',
      );
    }
    try {
      await this.withAbort(
        this.options.eventStore.clearProcessingReaction(event.eventId, event.attempts),
        signal,
      );
    } catch {
      this.options.logger.warn(
        { eventId: event.eventId, errorCode: 'reaction_clear_failed' },
        'reaction state clear failed',
      );
    }
  }

  private async removeCurrentReaction(event: StoredEvent, reactionId: string) {
    try {
      await this.options.messenger.removeReaction(event.payload.messageId, reactionId);
    } catch {
      this.options.logger.warn(
        { eventId: event.eventId, errorCode: 'reaction_remove_failed' },
        'reaction remove failed',
      );
    }
    try {
      await this.options.eventStore.clearProcessingReaction(event.eventId, event.attempts);
    } catch {
      this.options.logger.warn(
        { eventId: event.eventId, errorCode: 'reaction_clear_failed' },
        'reaction state clear failed',
      );
    }
  }

  private nextAttemptAt(attempts: number, minimumDelayMs = 0) {
    const delay = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1_000);
    return new Date(this.now().getTime() + Math.max(delay, minimumDelayMs));
  }

  private async failBeforeReply(
    event: StoredEvent,
    errorCode: string,
    minimumDelayMs = 0,
  ) {
    if (event.attempts < 3) {
      await this.options.eventStore.retry(
        event.eventId,
        event.attempts,
        errorCode,
        this.nextAttemptAt(event.attempts, minimumDelayMs),
      );
      return;
    }
    await this.options.eventStore.complete(event.eventId, event.attempts, { errorCode });
  }

  private async runLoop() {
    while (!this.stopping && !this.options.signal?.aborted) {
      try {
        const [event] = await this.options.eventStore.claimReady(
          1,
          new Date(this.now().getTime() + this.leaseMs),
        );
        if (event) {
          await this.process(event);
          continue;
        }
      } catch {
        this.options.logger.warn(
          { errorCode: 'worker_iteration_failed' },
          'worker iteration failed',
        );
      }
      await this.waitForWork();
    }
  }

  private recoverExpiredLeases(): Promise<void> {
    if (this.recoveryRun) return this.recoveryRun;
    this.recoveryRun = this.options.eventStore
      .recoverExpiredLeases(this.now(), this.recoverLimit)
      .then(() => undefined)
      .catch(() => {
        this.options.logger.warn(
          { errorCode: 'lease_recovery_failed' },
          'expired lease recovery failed',
        );
      })
      .finally(() => {
        this.recoveryRun = undefined;
      });
    return this.recoveryRun;
  }

  private async waitForWork() {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeResolvers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, this.pollMs);
      this.wakeResolvers.add(finish);
    });
  }

  private withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
}
