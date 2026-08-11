import { createHash } from 'node:crypto';
import type { FeishuMessenger } from '../feishu/client.js';
import type { EventStore, StoredEvent } from '../storage/event-store.js';

export const PROGRESS_REPLY_DELAY_MS = 20_000;
export const PROGRESS_REPLY_TEXT = '我还在处理这条请求，完成后会继续回复。';

type ProgressLogger = {
  warn(bindings: Record<string, unknown>, message: string): unknown;
};

export type ProgressReplyHandle = { settle(): Promise<void> };

export type ProgressReplyDependencies = {
  eventStore: Pick<EventStore, 'markProgressAttempted' | 'confirmProgressSent'>;
  messenger: Pick<FeishuMessenger, 'replyText'>;
  logger: ProgressLogger;
  now?: () => Date;
};

const NO_PROGRESS: ProgressReplyHandle = {
  async settle() {},
};

function progressReplyKey(eventId: string) {
  const digest = createHash('sha256')
    .update(`progress:v1:${eventId}`).digest('hex').slice(0, 32);
  return `minori-progress-${digest}`;
}

export function startProgressReply(
  event: StoredEvent,
  dependencies: ProgressReplyDependencies,
): ProgressReplyHandle {
  if (event.payload.content.kind === 'unsupported'
    || event.replyAttemptedAt
    || event.progressAttemptedAt) {
    return NO_PROGRESS;
  }

  const now = dependencies.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let settled = false;

  const send = async () => {
    try {
      const attemptedAt = now();
      const admitted = await dependencies.eventStore.markProgressAttempted(
        event.eventId,
        event.attempts,
        attemptedAt,
      );
      if (!admitted) return;
      const messageId = await dependencies.messenger.replyText(
        event.payload.messageId,
        PROGRESS_REPLY_TEXT,
        progressReplyKey(event.eventId),
      );
      const confirmed = await dependencies.eventStore.confirmProgressSent(
        event.eventId,
        event.attempts,
        messageId,
      );
      if (!confirmed) throw new Error('progress_confirmation_rejected');
    } catch {
      dependencies.logger.warn(
        { eventId: event.eventId, errorCode: 'progress_reply_failed' },
        'progress reply failed',
      );
    }
  };

  const begin = () => {
    if (settled || inFlight) return;
    inFlight = send();
  };
  const delay = Math.max(
    0,
    event.receivedAt.getTime() + PROGRESS_REPLY_DELAY_MS - now().getTime(),
  );
  if (delay === 0) {
    begin();
  } else {
    timer = setTimeout(() => {
      timer = undefined;
      begin();
    }, delay);
    timer.unref?.();
  }

  return {
    async settle() {
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },
  };
}
