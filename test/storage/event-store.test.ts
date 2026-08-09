import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
import { processedEvents } from '../../src/storage/schema.js';

describe('PostgresEventStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresEventStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    store = new PostgresEventStore(database.db);
  });

  beforeEach(async () => {
    await database.pool.query('truncate table processed_events cascade');
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  function event(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
    return {
      eventId: 'evt_1',
      messageId: 'om_1',
      chatId: 'oc_1',
      conversationKey: 'oc_1',
      senderOpenId: 'ou_1',
      chatType: 'group',
      content: { kind: 'text', text: 'hello', feishuLinks: [] },
      occurredAt: new Date('2026-08-05T00:00:00Z'),
      ...overrides,
    };
  }

  it('durably accepts an event only once under concurrent delivery', async () => {
    const incoming = event();

    const [first, second] = await Promise.all([store.enqueue(incoming), store.enqueue(incoming)]);

    expect([first, second].sort()).toEqual(['duplicate', 'queued']);
  });

  it('serializes one Group Context while claiming independent conversations together', async () => {
    await store.enqueue(event());
    await store.enqueue(event({ eventId: 'evt_2', messageId: 'om_2', conversationKey: 'oc_1' }));
    await store.enqueue(event({
      eventId: 'evt_3',
      messageId: 'om_3',
      chatId: 'oc_2',
      conversationKey: 'oc_2',
    }));

    const leaseUntil = new Date(Date.now() + 60_000);
    const firstClaim = await store.claimReady(4, leaseUntil);

    expect(firstClaim.map((claimed) => claimed.eventId).sort()).toEqual(['evt_1', 'evt_3']);
    expect(firstClaim.every((claimed) => claimed.attempts === 1)).toBe(true);
    expect(firstClaim.every((claimed) => claimed.payload.occurredAt instanceof Date)).toBe(true);
    expect(await store.claimReady(4, leaseUntil)).toEqual([]);

    await store.complete('evt_1', 1, { replyMessageId: 'om_reply_1' });

    const secondClaim = await store.claimReady(4, leaseUntil);
    expect(secondClaim.map((claimed) => claimed.eventId)).toEqual(['evt_2']);
  });

  it('does not let concurrent workers claim two events from one Group Context', async () => {
    await store.enqueue(event({ messageId: 'om_1' }));
    await store.enqueue(event({ eventId: 'evt_2', messageId: 'om_2', conversationKey: 'oc_1' }));
    const leaseUntil = new Date(Date.now() + 60_000);

    const claims = await Promise.all([
      store.claimReady(1, leaseUntil),
      store.claimReady(1, leaseUntil),
    ]);

    expect(claims.flat().map((claimed) => claimed.eventId)).toEqual(['evt_1']);
  });

  it('retries after a bounded minimum delay without losing its attempt count', async () => {
    const boundedStore = new PostgresEventStore(database.db, {
      minRetryDelayMs: 20,
      maxRetryDelayMs: 1_000,
    });
    await boundedStore.enqueue(event());
    const first = await boundedStore.claimReady(1, new Date(Date.now() + 60_000));
    expect(first[0]?.attempts).toBe(1);

    await boundedStore.retry('evt_1', 1, 'model_unavailable', new Date(Date.now() - 1));
    expect(await boundedStore.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const second = await boundedStore.claimReady(1, new Date(Date.now() + 60_000));
    expect(second[0]?.attempts).toBe(2);
  });

  it('recovers only expired processing leases', async () => {
    await store.enqueue(event());
    await store.enqueue(event({
      eventId: 'evt_2',
      messageId: 'om_2',
      conversationKey: 'oc_2',
      chatId: 'oc_2',
    }));
    const now = new Date();
    await store.claimReady(1, new Date(now.getTime() - 1));
    await store.claimReady(1, new Date(now.getTime() + 60_000));

    expect(await store.recoverExpiredLeases(now, 10)).toBe(1);

    const recovered = await store.claimReady(1, new Date(now.getTime() + 60_000));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.attempts).toBe(2);
    expect(await store.recoverExpiredLeases(now, 10)).toBe(0);
  });

  it('does not let a later event overtake an older delayed retry', async () => {
    await store.enqueue(event());
    await store.claimReady(1, new Date(Date.now() + 60_000));
    await store.retry('evt_1', 1, 'temporary_failure', new Date(Date.now() + 60_000));
    await store.enqueue(event({ eventId: 'evt_2', messageId: 'om_2' }));

    expect(await store.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('does not let a later event overtake an expired claim before recovery', async () => {
    await store.enqueue(event());
    await store.enqueue(event({ eventId: 'evt_2', messageId: 'om_2' }));
    await store.claimReady(1, new Date(Date.now() - 1));

    expect(await store.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('rejects a stale worker after an expired event is reclaimed', async () => {
    await store.enqueue(event());
    expect(await store.attachProcessingReaction('evt_1', 'reaction_1')).toBe(true);
    const first = await store.claimReady(1, new Date(Date.now() - 1));
    expect(first[0]?.attempts).toBe(1);
    await store.recoverExpiredLeases(new Date(), 1);
    const second = await store.claimReady(1, new Date(Date.now() + 60_000));
    expect(second[0]?.attempts).toBe(2);

    await expect(store.complete('evt_1', 1, { replyMessageId: 'stale_reply' }))
      .rejects.toThrow('stale_event_claim');
    expect(await store.complete('evt_1', 2, { replyMessageId: 'current_reply' })).toEqual({
      processingReactionId: 'reaction_1',
    });
  });

  it('bounds an excessively distant retry time', async () => {
    const boundedStore = new PostgresEventStore(database.db, {
      minRetryDelayMs: 0,
      maxRetryDelayMs: 50,
    });
    await boundedStore.enqueue(event());
    await boundedStore.claimReady(1, new Date(Date.now() + 60_000));

    await boundedStore.retry('evt_1', 1, 'temporary_failure', new Date(Date.now() + 60_000));
    expect(await boundedStore.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect((await boundedStore.claimReady(1, new Date(Date.now() + 60_000)))[0]?.attempts).toBe(2);
  });

  it('records an Uncertain Reply as terminal and never reclaims it', async () => {
    await store.enqueue(event());
    await store.claimReady(1, new Date(Date.now() + 60_000));

    await store.markReplyStarted('evt_1', 1, 'reply-key-1', new Date());
    expect(await store.markReplyUncertain('evt_1', 1)).toEqual({});

    expect(await store.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('returns persisted reaction and reply metadata after lease recovery', async () => {
    await store.enqueue(event());
    expect(await store.attachProcessingReaction('evt_1', 'reaction_1')).toBe(true);
    await store.claimReady(1, new Date(Date.now() - 1));
    const attemptedAt = new Date('2026-08-05T01:02:03Z');

    await store.markReplyStarted('evt_1', 1, 'reply-key-1', attemptedAt, 'prepared reply');
    await store.retry('evt_1', 1, 'reply_failed', new Date(Date.now() - 1));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const [recovered] = await store.claimReady(1, new Date(Date.now() + 60_000));
    expect(recovered).toMatchObject({
      eventId: 'evt_1',
      attempts: 2,
      processingReactionId: 'reaction_1',
      replyIdempotencyKey: 'reply-key-1',
      preparedReplyText: 'prepared reply',
    });
    expect(recovered?.replyAttemptedAt).toEqual(attemptedAt);
  });

  it('returns the durable write replay boundary on a recovered claim', async () => {
    const immediateStore = new PostgresEventStore(database.db, {
      minRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    await immediateStore.enqueue(event());
    await immediateStore.claimReady(1, new Date(Date.now() + 60_000));
    const writeStartedAt = new Date('2026-08-05T01:02:03Z');
    await database.db.update(processedEvents).set({ writeStartedAt })
      .where(eq(processedEvents.eventId, 'evt_1'));
    await immediateStore.retry('evt_1', 1, 'worker_crashed', new Date());

    const [recovered] = await immediateStore.claimReady(1, new Date(Date.now() + 60_000));

    expect(recovered?.writeStartedAt).toEqual(writeStartedAt);
  });

  it('transfers reaction ownership once to the terminal transition', async () => {
    await store.enqueue(event());
    expect(await store.attachProcessingReaction('evt_1', 'reaction_1')).toBe(true);
    await store.claimReady(1, new Date(Date.now() + 60_000));

    expect(await store.complete('evt_1', 1, { replyMessageId: 'om_reply' })).toEqual({
      processingReactionId: 'reaction_1',
    });
    expect(await store.attachProcessingReaction('evt_1', 'late_reaction')).toBe(false);
  });

  it('leaves exactly one cleanup owner when attachment races terminal completion', async () => {
    await store.enqueue(event());
    await store.claimReady(1, new Date(Date.now() + 60_000));

    const [terminal, attached] = await Promise.all([
      store.complete('evt_1', 1, { replyMessageId: 'om_reply' }),
      store.attachProcessingReaction('evt_1', 'racing_reaction'),
    ]);

    if (attached) {
      expect(terminal).toEqual({ processingReactionId: 'racing_reaction' });
    } else {
      expect(terminal).toEqual({});
    }
    expect(await store.attachProcessingReaction('evt_1', 'late_reaction')).toBe(false);
  });

  it('returns the persisted reaction when an active claim becomes uncertain', async () => {
    await store.enqueue(event());
    expect(await store.attachProcessingReaction('evt_1', 'reaction_1')).toBe(true);
    await store.claimReady(1, new Date(Date.now() + 60_000));

    expect(await store.markReplyUncertain('evt_1', 1)).toEqual({
      processingReactionId: 'reaction_1',
    });
    expect(await store.attachProcessingReaction('evt_1', 'late_reaction')).toBe(false);
  });
});
