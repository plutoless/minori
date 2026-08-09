import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresConversationStore } from '../../src/storage/conversation-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';

describe('PostgresConversationStore', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let store: PostgresConversationStore;
  const now = new Date('2026-08-05T12:00:00Z');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
  });

  beforeEach(async () => {
    await database.pool.query('truncate table messages, conversations cascade');
    store = new PostgresConversationStore(database.db, {
      estimateTokens: (text) => text.length,
      now: () => now,
      retentionMs: 30 * 24 * 60 * 60 * 1_000,
    });
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('creates one stable conversation identity under concurrent discovery', async () => {
    const input = { conversationKey: 'oc_1', chatId: 'oc_1', type: 'group' as const };

    const [first, second] = await Promise.all([
      store.getOrCreateConversation(input),
      store.getOrCreateConversation(input),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the newest messages within the soft budget in chronological order', async () => {
    const conversationId = await store.getOrCreateConversation({
      conversationKey: 'oc_1',
      chatId: 'oc_1',
      type: 'group',
    });
    await store.append({
      messageId: 'om_1', conversationId, role: 'user', senderOpenId: 'ou_1',
      content: '1111', createdAt: new Date('2026-08-05T10:00:00Z'),
    });
    await store.append({
      messageId: 'om_2', conversationId, role: 'assistant',
      content: '2222', createdAt: new Date('2026-08-05T10:01:00Z'),
    });
    await store.append({
      messageId: 'om_3', conversationId, role: 'user', senderOpenId: 'ou_1',
      content: '3333', createdAt: new Date('2026-08-05T10:02:00Z'),
    });

    const recent = await store.recentWithinBudget('oc_1', 8, 'om_3');
    const smallestWindow = await store.recentWithinBudget('oc_1', 1, 'om_3');

    expect(recent.map((message) => message.messageId)).toEqual(['om_2', 'om_3']);
    expect(smallestWindow.map((message) => message.messageId)).toEqual(['om_3']);
  });

  it('ignores duplicate Feishu messages instead of replacing their content', async () => {
    const conversationId = await store.getOrCreateConversation({
      conversationKey: 'oc_1', chatId: 'oc_1', type: 'group',
    });
    const original = {
      messageId: 'om_1', conversationId, role: 'user' as const, senderOpenId: 'ou_1',
      content: 'original', createdAt: new Date('2026-08-05T10:00:00Z'),
    };

    await store.append(original);
    await store.append({ ...original, content: 'replacement' });

    const recent = await store.recentWithinBudget('oc_1', 100, 'om_1');
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe('original');
  });

  it('searches Chinese and English only inside the current Retained Conversation History', async () => {
    const firstId = await store.getOrCreateConversation({
      conversationKey: 'oc_1', chatId: 'oc_1', type: 'group',
    });
    const secondId = await store.getOrCreateConversation({
      conversationKey: 'oc_2', chatId: 'oc_2', type: 'group',
    });
    await store.append({
      messageId: 'om_1', conversationId: firstId, role: 'user', senderOpenId: 'ou_1',
      content: 'Project Alpha launch decision', createdAt: new Date('2026-08-05T10:00:00Z'),
    });
    await store.append({
      messageId: 'om_2', conversationId: firstId, role: 'assistant',
      content: '发布方案已经确认', createdAt: new Date('2026-08-05T10:01:00Z'),
    });
    await store.append({
      messageId: 'om_private', conversationId: secondId, role: 'user', senderOpenId: 'ou_2',
      content: 'Project Alpha private secret 发布方案', createdAt: new Date('2026-08-05T10:02:00Z'),
    });

    const english = await store.search('oc_1', 'alpha', 10);
    const chinese = await store.search('oc_1', '发布方案', 10);

    expect(english.map((message) => message.messageId)).toEqual(['om_1']);
    expect(chinese.map((message) => message.messageId)).toEqual(['om_2']);
    expect(JSON.stringify([...english, ...chinese])).not.toContain('private secret');
  });

  it('preserves the explicit current trigger despite out-of-order timestamps', async () => {
    const conversationId = await store.getOrCreateConversation({
      conversationKey: 'oc_1', chatId: 'oc_1', type: 'group',
    });
    await store.append({
      messageId: 'om_future', conversationId, role: 'assistant',
      content: 'future', createdAt: new Date('2026-08-05T11:00:00Z'),
    });
    await store.append({
      messageId: 'om_trigger', conversationId, role: 'user', senderOpenId: 'ou_1',
      content: 'trigger', createdAt: new Date('2026-08-05T10:00:00Z'),
    });

    const recent = await store.recentWithinBudget('oc_1', 1, 'om_trigger');

    expect(recent.map((message) => message.messageId)).toEqual(['om_trigger']);
  });

  it('purges expired bodies without removing newer conversation messages', async () => {
    const longRetentionStore = new PostgresConversationStore(database.db, {
      estimateTokens: (text) => text.length,
      now: () => now,
      retentionMs: 365 * 24 * 60 * 60 * 1_000,
    });
    const conversationId = await longRetentionStore.getOrCreateConversation({
      conversationKey: 'oc_1', chatId: 'oc_1', type: 'group',
    });
    await longRetentionStore.append({
      messageId: 'om_old', conversationId, role: 'user', senderOpenId: 'ou_1',
      content: 'expired detail', createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    await longRetentionStore.append({
      messageId: 'om_new', conversationId, role: 'assistant',
      content: 'current detail', createdAt: new Date('2026-08-01T00:00:00Z'),
    });

    expect(await longRetentionStore.purgeExpired(new Date('2026-07-01T00:00:00Z'))).toBe(1);

    expect(await longRetentionStore.search('oc_1', 'expired', 10)).toEqual([]);
    expect((await longRetentionStore.search('oc_1', 'current', 10))[0]?.messageId)
      .toBe('om_new');
  });
});
