import { and, eq, sql } from 'drizzle-orm';
import type { NormalizedMessage } from '../contracts/messages.js';
import type { Database } from './database.js';
import { processedEvents } from './schema.js';

export type StoredEvent = {
  eventId: string;
  payload: NormalizedMessage;
  attempts: number;
};

export interface EventStore {
  enqueue(event: NormalizedMessage): Promise<'queued' | 'duplicate'>;
  claimReady(limit: number, leaseUntil: Date): Promise<StoredEvent[]>;
  complete(
    eventId: string,
    claimAttempt: number,
    outcome: { replyMessageId?: string; errorCode?: string },
  ): Promise<void>;
  markReplyStarted(eventId: string, claimAttempt: number, key: string, attemptedAt: Date): Promise<void>;
  markReplyUncertain(eventId: string, claimAttempt: number): Promise<void>;
  retry(
    eventId: string,
    claimAttempt: number,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  recoverExpiredLeases(now: Date, limit: number): Promise<number>;
}

export class StaleEventClaimError extends Error {
  constructor() {
    super('stale_event_claim');
    this.name = 'StaleEventClaimError';
  }
}

export type EventStoreOptions = {
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
};

const DEFAULT_MIN_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

export class PostgresEventStore implements EventStore {
  private readonly minRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(private readonly db: Database, options: EventStoreOptions = {}) {
    this.minRetryDelayMs = options.minRetryDelayMs ?? DEFAULT_MIN_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (this.minRetryDelayMs < 0 || this.maxRetryDelayMs < this.minRetryDelayMs) {
      throw new Error('invalid_retry_delay_bounds');
    }
  }

  async enqueue(event: NormalizedMessage): Promise<'queued' | 'duplicate'> {
    const inserted = await this.db.insert(processedEvents).values({
      eventId: event.eventId,
      messageId: event.messageId,
      payload: event,
      conversationKey: event.conversationKey,
      status: 'queued',
    }).onConflictDoNothing().returning({ eventId: processedEvents.eventId });

    return inserted.length === 1 ? 'queued' : 'duplicate';
  }

  async claimReady(limit: number, leaseUntil: Date): Promise<StoredEvent[]> {
    if (limit <= 0) return [];

    const result = await this.db.execute(sql`
      with ranked as materialized (
        select
          event_id,
          row_number() over (
            partition by conversation_key
            order by received_at, event_id
          ) as conversation_position
        from processed_events candidate
        where candidate.status in ('queued', 'processing')
      ), candidates as (
        select event.event_id
        from processed_events event
        inner join ranked on ranked.event_id = event.event_id
        where ranked.conversation_position = 1
          and event.status = 'queued'
          and event.next_attempt_at <= now()
        order by event.received_at, event.event_id
        for update of event skip locked
        limit ${limit}
      )
      update processed_events event
      set
        status = 'processing',
        attempts = event.attempts + 1,
        leased_until = ${leaseUntil},
        updated_at = now()
      from candidates
      where event.event_id = candidates.event_id
      returning
        event.event_id as "eventId",
        event.payload,
        event.attempts
    `);

    return (result.rows as Array<{
      eventId: string;
      payload: NormalizedMessage;
      attempts: number;
    }>).map((row) => ({
      ...row,
      payload: { ...row.payload, occurredAt: new Date(row.payload.occurredAt) },
    }));
  }

  async complete(
    eventId: string,
    claimAttempt: number,
    outcome: { replyMessageId?: string; errorCode?: string },
  ): Promise<void> {
    const updated = await this.db.update(processedEvents).set({
      status: 'completed',
      leasedUntil: null,
      replyMessageId: outcome.replyMessageId,
      outcome,
      updatedAt: new Date(),
    }).where(and(
      eq(processedEvents.eventId, eventId),
      eq(processedEvents.status, 'processing'),
      eq(processedEvents.attempts, claimAttempt),
    )).returning({ eventId: processedEvents.eventId });
    this.assertClaimUpdated(updated);
  }

  async markReplyStarted(
    eventId: string,
    claimAttempt: number,
    key: string,
    attemptedAt: Date,
  ): Promise<void> {
    const updated = await this.db.update(processedEvents).set({
      replyIdempotencyKey: key,
      replyAttemptedAt: attemptedAt,
      updatedAt: new Date(),
    }).where(and(
      eq(processedEvents.eventId, eventId),
      eq(processedEvents.status, 'processing'),
      eq(processedEvents.attempts, claimAttempt),
    )).returning({ eventId: processedEvents.eventId });
    this.assertClaimUpdated(updated);
  }

  async markReplyUncertain(eventId: string, claimAttempt: number): Promise<void> {
    const updated = await this.db.update(processedEvents).set({
      status: 'failed',
      leasedUntil: null,
      outcome: { errorCode: 'reply_uncertain' },
      updatedAt: new Date(),
    }).where(and(
      eq(processedEvents.eventId, eventId),
      eq(processedEvents.status, 'processing'),
      eq(processedEvents.attempts, claimAttempt),
    )).returning({ eventId: processedEvents.eventId });
    this.assertClaimUpdated(updated);
  }

  async retry(
    eventId: string,
    claimAttempt: number,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    const updated = await this.db.update(processedEvents).set({
      status: 'queued',
      leasedUntil: null,
      nextAttemptAt: sql`least(
        greatest(${nextAttemptAt}, now() + (${this.minRetryDelayMs} * interval '1 millisecond')),
        now() + (${this.maxRetryDelayMs} * interval '1 millisecond')
      )`,
      outcome: { errorCode },
      updatedAt: new Date(),
    }).where(and(
      eq(processedEvents.eventId, eventId),
      eq(processedEvents.status, 'processing'),
      eq(processedEvents.attempts, claimAttempt),
    )).returning({ eventId: processedEvents.eventId });
    this.assertClaimUpdated(updated);
  }

  async recoverExpiredLeases(now: Date, limit: number): Promise<number> {
    if (limit <= 0) return 0;

    const result = await this.db.execute(sql`
      with expired as (
        select event_id
        from processed_events
        where status = 'processing'
          and leased_until <= ${now}
        order by leased_until, event_id
        for update skip locked
        limit ${limit}
      )
      update processed_events event
      set
        status = 'queued',
        leased_until = null,
        next_attempt_at = now(),
        updated_at = now()
      from expired
      where event.event_id = expired.event_id
      returning event.event_id
    `);

    return result.rows.length;
  }

  private assertClaimUpdated(updated: Array<{ eventId: string }>) {
    if (updated.length !== 1) throw new StaleEventClaimError();
  }

}
