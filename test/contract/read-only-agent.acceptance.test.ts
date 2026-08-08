import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceRegistry } from '../../src/agent/sources.js';
import { createKnowledgeTools } from '../../src/agent/tools.js';
import type { AgentReply } from '../../src/agent/run.js';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import type { FeishuMessenger } from '../../src/feishu/client.js';
import { MembershipPolicy } from '../../src/feishu/membership.js';
import { normalizeMessageEvent } from '../../src/feishu/normalize-event.js';
import { LarkKnowledgeService } from '../../src/lark/knowledge-service.js';
import { PostgresAllowedChatStore } from '../../src/storage/allowed-chat-store.js';
import { PostgresConversationStore } from '../../src/storage/conversation-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
import { MessageWorker } from '../../src/worker/message-worker.js';

const BOT_OPEN_ID = 'ou_minori';

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt_group_1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
    message: {
      message_id: 'om_group_1', chat_id: 'oc_team', chat_type: 'group',
      message_type: 'text', create_time: '1785888000000',
      content: JSON.stringify({ text: '@_user_1 show the roadmap' }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
    },
    ...overrides,
  };
}

class FakeMessenger implements FeishuMessenger {
  readonly replies: Array<{ messageId: string; text: string; key: string }> = [];
  readonly reactions = new Set<string>();
  readonly accepted = new Map<string, string>();

  async replyText(messageId: string, text: string, key: string) {
    this.replies.push({ messageId, text, key });
    const prior = this.accepted.get(key);
    if (prior) return prior;
    const replyId = `reply_${this.accepted.size + 1}`;
    this.accepted.set(key, replyId);
    return replyId;
  }
  async addReaction(messageId: string) {
    const id = `typing_${messageId}`;
    this.reactions.add(id);
    return id;
  }
  async removeReaction(_messageId: string, reactionId: string) {
    this.reactions.delete(reactionId);
  }
}

describe('read-only team Agent release contract', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let allowedChats: PostgresAllowedChatStore;
  let conversations: PostgresConversationStore;
  let events: PostgresEventStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    allowedChats = new PostgresAllowedChatStore(database.db);
    conversations = new PostgresConversationStore(database.db);
    events = new PostgresEventStore(database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 });
  });

  beforeEach(async () => {
    await database.pool.query('truncate table processed_events, messages, conversations, allowed_chats cascade');
    await allowedChats.configure(['oc_team']);
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('answers eligible group and private messages with fixture-backed sources', async () => {
    const searchFixture = JSON.parse(await readFile(
      resolve('test/fixtures/lark/drive-search.json'), 'utf8',
    )) as { data: unknown };
    const documentFixture = JSON.parse(await readFile(
      resolve('test/fixtures/lark/docs-fetch.json'), 'utf8',
    )) as { data: unknown };
    const executor = {
      run: vi.fn(async (command: { id: string }) => command.id === 'drive.search'
        ? searchFixture.data
        : documentFixture.data),
    };
    const reader = new LarkKnowledgeService(executor);
    const fakeModel = vi.fn(async (message: NormalizedMessage): Promise<AgentReply> => {
      const link = message.content.kind === 'text' ? message.content.feishuLinks[0] : undefined;
      const doc = link ?? (await reader.search({ query: 'roadmap' }))[0]!.token;
      const fetched = await reader.fetchDocument({ doc });
      return {
        text: 'The read-only Agent launches first [1].',
        sources: [{ id: 1, title: fetched.title, url: fetched.url }],
        usage: {},
      };
    });
    const messenger = new FakeMessenger();
    const membership = new MembershipPolicy({
      allowedChats,
      members: { listOpenIds: vi.fn(async () => new Set(['ou_member'])) },
    });
    const worker = new MessageWorker({
      eventStore: events, membership, conversations, messenger,
      runAgent: fakeModel,
      logger: { warn: vi.fn(), info: vi.fn() },
      concurrency: 4,
    });

    const group = normalizeMessageEvent(rawEvent(), { botOpenId: BOT_OPEN_ID })!;
    const rich = normalizeMessageEvent(rawEvent({
      event_id: 'evt_group_2',
      message: {
        message_id: 'om_group_2', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'post', create_time: '1785888001000', root_id: 'om_group_1',
        content: JSON.stringify({ content: [[
          { tag: 'a', text: 'roadmap', href: 'https://acme.feishu.cn/docx/doxcnRoadmap' },
        ]] }),
      },
    }), { botOpenId: BOT_OPEN_ID, knownAgentThread: true })!;
    const privateMessage: NormalizedMessage = {
      ...group,
      eventId: 'evt_private', messageId: 'om_private', chatId: 'oc_private',
      conversationKey: 'oc_private', chatType: 'p2p', rootId: undefined,
    } as NormalizedMessage;
    const unsupported: NormalizedMessage = {
      ...group,
      eventId: 'evt_file', messageId: 'om_file', conversationKey: 'oc_team:om_file',
      rootId: 'om_file', content: { kind: 'unsupported', sourceMessageType: 'file' },
    };
    const disallowed: NormalizedMessage = {
      ...group,
      eventId: 'evt_bad', messageId: 'om_bad', chatId: 'oc_bad',
      conversationKey: 'oc_bad:om_bad', rootId: 'om_bad',
    };
    const outsider: NormalizedMessage = {
      ...privateMessage,
      eventId: 'evt_outsider', messageId: 'om_outsider', senderOpenId: 'ou_outsider',
    };

    expect(group.content).toEqual({
      kind: 'text', text: 'show the roadmap', feishuLinks: [],
    });
    expect(rich.content).toEqual({
      kind: 'text', text: 'roadmap',
      feishuLinks: ['https://acme.feishu.cn/docx/doxcnRoadmap'],
    });

    expect(await events.enqueue(group)).toBe('queued');
    expect(await events.enqueue(group)).toBe('duplicate');
    for (const event of [rich, privateMessage, unsupported, disallowed, outsider]) {
      await events.enqueue(event);
    }

    const claimBatches: string[][] = [];
    for (;;) {
      const claimed = await events.claimReady(4, new Date(Date.now() + 60_000));
      if (claimed.length === 0) break;
      claimBatches.push(claimed.map((event) => event.eventId));
      await Promise.all(claimed.map((event) => worker.process(event)));
    }

    expect(fakeModel).toHaveBeenCalledTimes(3);
    expect(executor.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'drive.search' }));
    expect(executor.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'docs.fetch' }));
    expect(messenger.replies).toHaveLength(4);
    expect(messenger.replies.filter((reply) => reply.text.includes('Sources:'))).toHaveLength(3);
    expect(messenger.replies.some(
      (reply) => reply.text.includes('https://acme.feishu.cn/docx/doxcnRoadmap'),
    )).toBe(true);
    expect(messenger.replies.some((reply) => reply.text.includes('暂不支持'))).toBe(true);
    expect(messenger.replies.some((reply) => reply.messageId === 'om_bad')).toBe(false);
    expect(messenger.replies.some((reply) => reply.messageId === 'om_outsider')).toBe(false);
    expect(messenger.reactions.size).toBe(0);
    expect(claimBatches[0]).toEqual(expect.arrayContaining(['evt_group_1', 'evt_private']));
    expect(claimBatches[0]).not.toContain('evt_group_2');

    const toolNames = Object.keys(createKnowledgeTools(
      reader,
      { search: vi.fn(async () => []) },
      new SourceRegistry(),
      { run: (_input, operation) => operation() },
    ));
    expect(toolNames).toEqual([
      'searchKnowledge', 'fetchDocument', 'listKnowledgeSpaces',
      'listKnowledgeNodes', 'getKnowledgeNode', 'createDocument',
      'appendDocument', 'patchDocument', 'searchConversationHistory',
    ]);
    expect(toolNames.join(' ')).not.toMatch(
      /delete|move|overwrite|permission|sharing|raw|shell|http|filesystem/iu,
    );
  });

  it('expires old message bodies and replays a recent uncertain transport result only once', async () => {
    const messenger = new FakeMessenger();
    const originalReply = messenger.replyText.bind(messenger);
    let loseConfirmation = true;
    messenger.replyText = vi.fn(async (messageId, text, key) => {
      const replyId = await originalReply(messageId, text, key);
      if (loseConfirmation) {
        loseConfirmation = false;
        throw new Error('confirmation_lost');
      }
      return replyId;
    });
    const membership = new MembershipPolicy({
      allowedChats,
      members: { listOpenIds: vi.fn(async () => new Set(['ou_member'])) },
    });
    const worker = new MessageWorker({
      eventStore: events, membership, conversations, messenger,
      runAgent: vi.fn(async () => ({ text: 'safe answer', sources: [], usage: {} })),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const incoming = normalizeMessageEvent(rawEvent(), { botOpenId: BOT_OPEN_ID })!;
    await events.enqueue(incoming);
    const [first] = await events.claimReady(1, new Date(Date.now() + 60_000));
    await worker.process(first!);
    const restartedEvents = new PostgresEventStore(
      database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    const restartedWorker = new MessageWorker({
      eventStore: restartedEvents,
      membership,
      conversations: new PostgresConversationStore(database.db),
      messenger,
      runAgent: vi.fn(async () => ({ text: 'safe answer', sources: [], usage: {} })),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const [recovered] = await restartedEvents.claimReady(1, new Date(Date.now() + 60_000));
    await restartedWorker.process(recovered!);

    expect(messenger.replies).toHaveLength(2);
    expect(messenger.replies[0]!.key).toBe(messenger.replies[1]!.key);
    expect(messenger.accepted.size).toBe(1);

    const conversationId = await conversations.getOrCreateConversation({
      conversationKey: 'oc_retention', chatId: 'oc_retention', type: 'p2p',
    });
    await conversations.append({
      messageId: 'om_expired', conversationId, role: 'user', content: 'expired secret',
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    await conversations.purgeExpired(new Date('2026-07-01T00:00:00Z'));
    expect(await conversations.search('oc_retention', 'expired secret', 5)).toEqual([]);
  });

  it('claims four independent Agent Threads while preserving same-thread order', async () => {
    const root = normalizeMessageEvent(rawEvent(), { botOpenId: BOT_OPEN_ID })!;
    const followUp: NormalizedMessage = {
      ...root,
      eventId: 'evt_group_2',
      messageId: 'om_group_2',
    };
    const privateMessages = ['a', 'b', 'c'].map((suffix): NormalizedMessage => ({
      ...root,
      eventId: `evt_private_${suffix}`,
      messageId: `om_private_${suffix}`,
      chatId: `oc_private_${suffix}`,
      chatType: 'p2p',
      conversationKey: `oc_private_${suffix}`,
    }));
    for (const event of [root, followUp, ...privateMessages]) await events.enqueue(event);

    const firstBatch = await events.claimReady(4, new Date(Date.now() + 60_000));

    expect(firstBatch.map((event) => event.eventId)).toEqual(expect.arrayContaining([
      'evt_group_1', 'evt_private_a', 'evt_private_b', 'evt_private_c',
    ]));
    expect(firstBatch.map((event) => event.eventId)).not.toContain('evt_group_2');

    let active = 0;
    let peak = 0;
    let releaseAll!: () => void;
    const allStarted = new Promise<void>((resolve) => { releaseAll = resolve; });
    const runAgent = vi.fn(async (): Promise<AgentReply> => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 4) releaseAll();
      await allStarted;
      active -= 1;
      return { text: 'concurrent answer', sources: [], usage: {} };
    });
    const worker = new MessageWorker({
      eventStore: events,
      membership: { authorize: vi.fn(async () => ({ allowed: true as const })) },
      conversations,
      messenger: new FakeMessenger(),
      runAgent,
      logger: { warn: vi.fn(), info: vi.fn() },
      concurrency: 4,
    });
    await Promise.all(firstBatch.map((event) => worker.process(event)));
    expect(peak).toBe(4);

    const secondBatch = await events.claimReady(1, new Date(Date.now() + 60_000));
    expect(secondBatch[0]?.eventId).toBe('evt_group_2');
  });

  it('does not resend after the one-hour Feishu deduplication window', async () => {
    const messenger = new FakeMessenger();
    messenger.reactions.add('typing_stale');
    const restartedEvents = new PostgresEventStore(
      database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    const worker = new MessageWorker({
      eventStore: restartedEvents,
      membership: { authorize: vi.fn(async () => ({ allowed: true as const })) },
      conversations,
      messenger,
      runAgent: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      now: () => new Date('2026-08-05T02:00:01Z'),
    });
    const incoming = normalizeMessageEvent(rawEvent({ event_id: 'evt_uncertain' }), {
      botOpenId: BOT_OPEN_ID,
    })!;
    await events.enqueue(incoming);
    await events.claimReady(1, new Date('2026-08-05T01:30:00Z'));
    await events.saveProcessingReaction('evt_uncertain', 1, 'typing_stale');
    await events.markReplyStarted(
      'evt_uncertain', 1, 'minori-old-key', new Date('2026-08-05T01:00:00Z'), 'old answer',
    );
    expect(await restartedEvents.recoverExpiredLeases(
      new Date('2026-08-05T02:00:01Z'), 1,
    )).toBe(1);
    const [recovered] = await restartedEvents.claimReady(1, new Date(Date.now() + 60_000));

    await worker.process(recovered!);

    expect(messenger.replies).toEqual([]);
    expect(messenger.reactions.size).toBe(0);
    expect(await restartedEvents.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
  });
});
