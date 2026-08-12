import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceRegistry } from '../../src/agent/sources.js';
import { createKnowledgeTools } from '../../src/agent/tools.js';
import { runKnowledgeAgent, type AgentReply } from '../../src/agent/run.js';
import { budgetExhaustedText } from '../../src/agent/run-outcome.js';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import type { FeishuMessenger } from '../../src/feishu/client.js';
import { FeishuGateway } from '../../src/feishu/gateway.js';
import type { GroupContextSource } from '../../src/feishu/group-context.js';
import { normalizeMessageEvent } from '../../src/feishu/normalize-event.js';
import { LarkKnowledgeService, type KnowledgeService } from '../../src/lark/knowledge-service.js';
import { PostgresAgentRunStore } from '../../src/storage/agent-run-store.js';
import { PostgresConversationStore } from '../../src/storage/conversation-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
import { agentRuns, processedEvents, toolRuns } from '../../src/storage/schema.js';
import { MessageWorker } from '../../src/worker/message-worker.js';

const BOT_OPEN_ID = 'ou_minori';
const noWriteAttempts = async () => [];

const modelUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function generated(
  content: LanguageModelV4GenerateResult['content'],
  finish: 'stop' | 'tool-calls',
): LanguageModelV4GenerateResult {
  return { content, finishReason: { unified: finish, raw: finish }, usage: modelUsage, warnings: [] };
}

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
  readonly replies: Array<{
    messageId: string;
    text: string;
    key: string;
    format: 'rich' | 'control';
  }> = [];
  readonly reactions = new Set<string>();
  readonly accepted = new Map<string, string>();

  async replyText(messageId: string, text: string, key: string) {
    return this.reply(messageId, text, key, 'control');
  }
  async replyRichContent(messageId: string, text: string, key: string) {
    return this.reply(messageId, text, key, 'rich');
  }
  private async reply(
    messageId: string,
    text: string,
    key: string,
    format: 'rich' | 'control',
  ) {
    this.replies.push({ messageId, text, key, format });
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

describe('open team Agent release contract', () => {
  let container: StartedPostgreSqlContainer;
  let database: DatabaseHandle;
  let conversations: PostgresConversationStore;
  let events: PostgresEventStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    database = createDatabase(container.getConnectionUri());
    await migrate(database.db, { migrationsFolder: resolve('drizzle') });
    conversations = new PostgresConversationStore(database.db);
    events = new PostgresEventStore(database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 });
  });

  beforeEach(async () => {
    await database.pool.query(
      'truncate table tool_runs, agent_runs, processed_events, messages, conversations cascade',
    );
  });

  it('keeps recovery policy inside the open Agent instead of exporting operation routers', async () => {
    const sourceFiles = (await readdir(resolve('src'), { recursive: true }))
      .filter((path) => path.endsWith('.ts'));
    const source = (await Promise.all(sourceFiles.map(
      (path) => readFile(resolve('src', path), 'utf8'),
    ))).join('\n');

    expect(source).not.toMatch(
      /export\s+(?:async\s+)?(?:function|class|const|type|interface)\s+(?:reconcileCreate|reconcileAppend|reconcilePatch|confirmationParser|recoveryRouter)\b/u,
    );
  });

  afterAll(async () => {
    await database?.close();
    await container?.stop();
  });

  it('keeps the legacy admission table writable for previous-release rollback', async () => {
    const relation = await database.pool.query<{ tableName: string | null }>(
      `select to_regclass('public.allowed_chats')::text as "tableName"`,
    );
    expect(relation.rows[0]?.tableName).toBe('allowed_chats');

    // Mirrors the fixed-point admission-store configuration startup contract.
    await database.pool.query('update allowed_chats set enabled = false, updated_at = now()');
    await database.pool.query(`
      insert into allowed_chats (chat_id, enabled, updated_at)
      values ('oc_rollback_probe', true, now())
      on conflict (chat_id) do update
      set enabled = excluded.enabled, updated_at = excluded.updated_at
    `);
    const configured = await database.pool.query<{ enabled: boolean }>(
      `select enabled from allowed_chats where chat_id = 'oc_rollback_probe'`,
    );
    expect(configured.rows).toEqual([{ enabled: true }]);

    const legacyRun = await database.pool.query<{ claimAttempt: number | null }>(`
      insert into agent_runs (model, outcome)
      values ('rollback-probe', 'running')
      returning claim_attempt as "claimAttempt"
    `);
    expect(legacyRun.rows).toEqual([{ claimAttempt: null }]);

    const legacyEvent = await database.pool.query<{
      attemptedAt: Date | null;
      messageId: string | null;
    }>(`
      insert into processed_events (
        event_id, message_id, payload, conversation_key, status
      ) values (
        'evt_rollback_probe', 'om_rollback_probe',
        '{"eventId":"evt_rollback_probe","messageId":"om_rollback_probe","chatId":"oc_rollback_probe","conversationKey":"oc_rollback_probe","senderOpenId":"ou_probe","chatType":"p2p","content":{"kind":"text","text":"probe","feishuLinks":[]},"occurredAt":"2026-08-11T00:00:00.000Z"}'::jsonb,
        'oc_rollback_probe', 'queued'
      ) returning progress_attempted_at as "attemptedAt", progress_message_id as "messageId"
    `);
    expect(legacyEvent.rows).toEqual([{ attemptedAt: null, messageId: null }]);

    const failureDetail = await database.pool.query<{ errorMessage: string | null }>(`
      select error_message as "errorMessage"
      from agent_runs where model = 'rollback-probe'
    `);
    expect(failureDetail.rows).toEqual([{ errorMessage: null }]);
  });

  it('answers delivered external group and private messages with fixture-backed sources', async () => {
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
      const doc = link ?? (await reader.search({ query: 'roadmap' })).results[0]!.token;
      const fetched = await reader.fetchDocument({ doc });
      return {
        text: 'The Team Agent launches first [1].',
        sources: [{ id: 1, title: fetched.title, url: fetched.url }],
        usage: {},
        outcome: 'completed',
        writeAttempts: [],
      };
    });
    const messenger = new FakeMessenger();
    const worker = new MessageWorker({
      eventStore: events, conversations, messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: fakeModel,
      logger: { warn: vi.fn(), info: vi.fn() },
      concurrency: 4,
    });

    const group = normalizeMessageEvent(rawEvent({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_external' } },
    }), { botOpenId: BOT_OPEN_ID })!;
    const rich = normalizeMessageEvent(rawEvent({
      event_id: 'evt_group_2',
      message: {
        message_id: 'om_group_2', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'post', create_time: '1785888001000',
        content: JSON.stringify({ content: [[
          { tag: 'a', text: 'roadmap', href: 'https://acme.feishu.cn/docx/doxcnRoadmap' },
        ]] }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    }), { botOpenId: BOT_OPEN_ID })!;
    const privateMessage: NormalizedMessage = {
      ...group,
      eventId: 'evt_private', messageId: 'om_private', chatId: 'oc_private',
      conversationKey: 'oc_private', chatType: 'p2p',
    } as NormalizedMessage;
    const unsupported: NormalizedMessage = {
      ...group,
      eventId: 'evt_file', messageId: 'om_file', conversationKey: 'oc_team',
      content: { kind: 'unsupported', sourceMessageType: 'file' },
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
    for (const event of [rich, privateMessage, unsupported]) {
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
    expect(messenger.replies.filter((reply) => reply.text.includes('Sources:'))
      .every((reply) => reply.format === 'rich')).toBe(true);
    expect(messenger.replies.some(
      (reply) => reply.text.includes('https://acme.feishu.cn/docx/doxcnRoadmap'),
    )).toBe(true);
    expect(messenger.replies.some(
      (reply) => reply.text.includes('暂不支持') && reply.format === 'control',
    )).toBe(true);
    expect(messenger.replies.some((reply) => reply.messageId === 'om_group_1')).toBe(true);
    expect(messenger.replies.some((reply) => reply.messageId === 'om_private')).toBe(true);
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

  it('uses current Wiki tokens through the real Agent and stores counts only', async () => {
    const rawResults = Array.from({ length: 10 }, (_, index) => index < 8
      ? {
        entity_type: 'WIKI',
        result_meta: {
          token: `wikcnCurrent${index}`,
          url: `https://acme.feishu.cn/wiki/wikcnCurrent${index}`,
        },
        title: `Fixture page ${index}`,
      }
      : { entity_type: 'WIKI', title: `Malformed fixture ${index}` });
    const executor = {
      run: vi.fn(async (command: { id: string; doc?: string }) => {
        if (command.id === 'drive.search') return { results: rawResults };
        if (command.id === 'docs.fetch' && command.doc === 'wikcnCurrent0') {
          return {
            document: {
              document_id: 'wikcnCurrent0',
              revision_id: 1,
              title: 'Fixture page 0',
              url: 'https://acme.feishu.cn/wiki/wikcnCurrent0',
              content: '# Fixture page 0\n\nCurrent planning evidence.',
            },
          };
        }
        throw new Error('unexpected_fixture_command');
      }),
    };
    const knowledge = new LarkKnowledgeService(executor);
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_search_current', toolName: 'searchKnowledge',
          input: JSON.stringify({ query: 'current planning' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_fetch_current', toolName: 'fetchDocument',
          input: JSON.stringify({
            doc: 'wikcnCurrent0', mode: 'relevant', query: 'current planning',
          }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'Current planning evidence [1].' }], 'stop'),
      ],
    });
    const runStore = new PostgresAgentRunStore(database.db);
    const messenger = new FakeMessenger();
    const operationalError = vi.fn();
    const worker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger,
      loadWriteAttempts: (eventId) => runStore.listWriteAttempts(eventId),
      logger: { warn: vi.fn(), info: vi.fn() },
      runAgent: (message, claimAttempt, signal) => {
        if (message.content.kind !== 'text') throw new Error('unsupported_agent_input');
        return runKnowledgeAgent({
          prompt: message.content.text,
          history: [],
          trigger: {
            kind: 'feishu_member',
            senderOpenId: message.senderOpenId,
            chatId: message.chatId,
            chatType: message.chatType,
            occurredAt: message.occurredAt,
          },
        }, {
          model,
          service: knowledge,
          eventId: message.eventId,
          claimAttempt,
          modelName: '5.6-terra',
          maxSteps: 40,
          timeoutMs: 300_000,
          botOpenId: BOT_OPEN_ID,
          botAppId: 'cli_minori',
          agentRunStore: runStore,
          onOperationalError: operationalError,
          conversationKey: message.conversationKey,
          triggerMessageId: message.messageId,
          conversationStore: conversations,
        }, signal);
      },
    });
    const incoming = normalizeMessageEvent(rawEvent({
      event_id: 'evt_current_wiki_search',
      message: {
        message_id: 'om_current_wiki_search', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888001500',
        content: JSON.stringify({ text: '@_user_1 check current planning' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    }), { botOpenId: BOT_OPEN_ID })!;

    await events.enqueue(incoming);
    const [claimed] = await events.claimReady(1, new Date(Date.now() + 60_000));
    await worker.process(claimed!);

    expect(executor.run).toHaveBeenCalledWith({
      id: 'docs.fetch', doc: 'wikcnCurrent0',
    }, expect.any(AbortSignal));
    expect(JSON.stringify(model.doGenerateCalls)).toContain(
      '"status":"partial","results"',
    );
    expect(JSON.stringify(model.doGenerateCalls)).toContain(
      '"rawCount":10,"validCount":8,"omittedCount":2',
    );
    let audits: typeof toolRuns.$inferSelect[] = [];
    await vi.waitFor(async () => {
      const [run] = await database.db.select().from(agentRuns)
        .where(eq(agentRuns.eventId, incoming.eventId));
      audits = run
        ? await database.db.select().from(toolRuns).where(eq(toolRuns.agentRunId, run.id))
        : [];
      expect(audits).toHaveLength(1);
    });
    expect(audits[0]).toMatchObject({
      toolName: 'searchKnowledge',
      success: true,
      errorCategory: null,
      sanitizedSummary: 'raw=10 valid=8 omitted=2',
      targetIdentifiers: null,
      resultIdentifiers: null,
    });
    expect(JSON.stringify(audits[0])).not.toMatch(
      /current planning|Fixture page|wikcnCurrent|https?:|open[_ ]?id|oauth/iu,
    );
    const [event] = await database.db.select().from(processedEvents)
      .where(eq(processedEvents.eventId, incoming.eventId));
    expect(event?.writeStartedAt).toBeNull();
    await expect(runStore.listWriteAttempts(incoming.eventId)).resolves.toEqual([]);
    expect(operationalError).not.toHaveBeenCalled();
  });

  it('uses transient paginated Group Context while persisting only invocations and replies', async () => {
    const groupContextSource: GroupContextSource = {
      open: vi.fn((input) => {
        let pageCallCount = 1;
        const initialMessages = input.triggerMessageId === 'om_context_1'
          ? [
            {
              speakerName: 'Alice', role: 'user' as const, content: 'Initial Alice context.',
              occurredAt: new Date('2026-08-08T09:55:00.000Z'),
            },
            {
              speakerName: 'Bob', role: 'user' as const,
              content: '[未读取：image 消息]',
              occurredAt: new Date('2026-08-08T09:56:00.000Z'),
            },
            {
              speakerName: 'Minori', role: 'assistant' as const,
              content: 'Earlier Minori context.',
              occurredAt: new Date('2026-08-08T09:57:00.000Z'),
            },
          ]
          : [{
            speakerName: 'Alice', role: 'user' as const, content: 'Second invocation context.',
            occurredAt: new Date('2026-08-08T10:00:30.000Z'),
          }];
        return {
          loadInitial: vi.fn(async (signal?: AbortSignal) => {
            signal?.throwIfAborted();
            return {
              messages: initialMessages,
              currentSenderName: input.triggerMessageId === 'om_context_1' ? 'Carol' : 'Dave',
              audit: {
                status: 'loaded' as const,
                messageCount: initialMessages.length,
                pageCallCount,
                cutoff: new Date(input.cutoff),
              },
            };
          }),
          readEarlier: vi.fn(async (_page, signal?: AbortSignal) => {
            signal?.throwIfAborted();
            pageCallCount += 1;
            return {
              messages: [{
                speakerName: 'Eve', role: 'user' as const,
                content: 'Transient older-page decision.',
                occurredAt: new Date('2026-08-08T09:00:00.000Z'),
              }],
              audit: {
                status: 'loaded' as const,
                messageCount: initialMessages.length + 1,
                pageCallCount,
                cutoff: new Date(input.cutoff),
              },
            };
          }),
        };
      }),
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_earlier_group',
          toolName: 'readEarlierGroupHistory', input: JSON.stringify({ limit: 20 }),
        }], 'tool-calls'),
        generated([{ type: 'text', text: 'First group answer.' }], 'stop'),
        generated([{ type: 'text', text: 'Second group answer.' }], 'stop'),
      ],
    });
    const knowledge: KnowledgeService = {
      search: vi.fn(async () => ({
        status: 'complete' as const,
        results: [], rawCount: 0, validCount: 0, omittedCount: 0,
      })),
      fetchDocument: vi.fn(),
      listSpaces: vi.fn(async () => []),
      listNodes: vi.fn(async () => []),
      getNode: vi.fn(),
      createDocument: vi.fn(),
      appendDocument: vi.fn(),
      patchDocument: vi.fn(),
    };
    const runStore = new PostgresAgentRunStore(database.db);
    const messenger = new FakeMessenger();
    const worker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger,
      loadWriteAttempts: (eventId) => runStore.listWriteAttempts(eventId),
      logger: { warn: vi.fn(), info: vi.fn() },
      runAgent: (message, claimAttempt, signal) => {
        if (message.content.kind !== 'text') throw new Error('unsupported_agent_input');
        return runKnowledgeAgent({
          prompt: message.content.text,
          history: [],
          trigger: {
            kind: 'feishu_member',
            senderOpenId: message.senderOpenId,
            chatId: message.chatId,
            chatType: message.chatType,
            occurredAt: message.occurredAt,
          },
        }, {
          model,
          service: knowledge,
          eventId: message.eventId,
          claimAttempt,
          modelName: '5.6-terra',
          maxSteps: 40,
          timeoutMs: 300_000,
          botOpenId: BOT_OPEN_ID,
          botAppId: 'cli_minori',
          groupContextSource,
          agentRunStore: runStore,
          onOperationalError: vi.fn(),
          conversationKey: message.conversationKey,
          triggerMessageId: message.messageId,
          conversationStore: conversations,
        }, signal);
      },
    });
    const groupMention = normalizeMessageEvent(rawEvent({
      event_id: 'evt_context_1',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_current_1' } },
      message: {
        message_id: 'om_context_1', parent_id: 'om_root_a',
        chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1786202400000',
        content: JSON.stringify({ text: '@_user_1 summarize above' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    }), { botOpenId: BOT_OPEN_ID })!;
    const groupReply = normalizeMessageEvent(rawEvent({
      event_id: 'evt_context_2',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_current_2' } },
      message: {
        message_id: 'om_context_2', parent_id: 'om_minori_reply',
        chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1786202460000',
        content: JSON.stringify({ text: 'what changed?' }),
        mentions: [],
      },
    }), { botOpenId: BOT_OPEN_ID, repliedToBot: true })!;
    const unrelatedTimelineCandidate = normalizeMessageEvent(rawEvent({
      event_id: 'evt_context_noise',
      message: {
        message_id: 'om_context_noise', root_id: 'om_root_a',
        chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1786202470000',
        content: JSON.stringify({ text: 'unrelated timeline message' }),
        mentions: [],
      },
    }), { botOpenId: BOT_OPEN_ID });
    const normalizedTimelineEvents = [
      groupMention,
      groupReply,
      unrelatedTimelineCandidate,
    ].filter((event): event is NormalizedMessage => event !== null);
    const unrelatedTimelineEvent = normalizedTimelineEvents.find(
      (event) => event.eventId === 'evt_context_noise',
    );

    expect(groupMention.conversationKey).toBe('oc_team');
    expect(groupReply.conversationKey).toBe('oc_team');
    expect(unrelatedTimelineEvent).toBeUndefined();
    await events.enqueue(groupMention);
    await events.enqueue(groupReply);
    const firstBatch = await events.claimReady(4, new Date(Date.now() + 60_000));
    expect(firstBatch.map(({ eventId }) => eventId)).toEqual(['evt_context_1']);
    await worker.process(firstBatch[0]!);
    const secondBatch = await events.claimReady(4, new Date(Date.now() + 60_000));
    expect(secondBatch.map(({ eventId }) => eventId)).toEqual(['evt_context_2']);
    await worker.process(secondBatch[0]!);

    expect(groupContextSource.open).toHaveBeenCalledTimes(2);
    const modelContext = JSON.stringify(model.doGenerateCalls);
    expect(modelContext).toContain('[Live Group History][Alice]');
    expect(modelContext).toContain('[Live Group History][Bob]');
    expect(modelContext).toContain('[Current Invocation][Carol] summarize above');
    expect(modelContext).toContain('Transient older-page decision.');
    expect(modelContext).not.toContain('ou_current');

    const persisted = await database.pool.query<{
      messageId: string; role: string; content: string | null;
    }>(`select message_id as "messageId", role, content
        from messages order by sequence`);
    expect(persisted.rows.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
      { messageId: 'om_context_1', role: 'user' },
      { messageId: 'reply_1', role: 'assistant' },
      { messageId: 'om_context_2', role: 'user' },
      { messageId: 'reply_2', role: 'assistant' },
    ]);
    const persistedBodies = JSON.stringify(persisted.rows);
    expect(persistedBodies).not.toContain('Initial Alice context.');
    expect(persistedBodies).not.toContain('Transient older-page decision.');
    expect(persistedBodies).not.toContain('Alice');
    expect(persistedBodies).not.toContain('Bob');
    expect(persistedBodies).not.toContain('Carol');
    const persistedOrdinaryHistoryRows = async () => (await database.pool.query(
      `select message_id from messages
       where content in (
         'Initial Alice context.',
         '[未读取：image 消息]',
         'Earlier Minori context.',
         'Second invocation context.',
         'Transient older-page decision.'
       )`,
    )).rows;
    expect(await persistedOrdinaryHistoryRows()).toHaveLength(0);

    const runs = await database.db.select().from(agentRuns);
    expect(runs.map((run) => ({
      eventId: run.eventId,
      status: run.groupHistoryStatus,
      messages: run.groupHistoryMessageCount,
      pages: run.groupHistoryPageCount,
    }))).toEqual(expect.arrayContaining([
      { eventId: 'evt_context_1', status: 'loaded', messages: 4, pages: 2 },
      { eventId: 'evt_context_2', status: 'loaded', messages: 1, pages: 1 },
    ]));
  });

  it('keeps durable Typing through retry and restart until the terminal reply', async () => {
    const messenger = new FakeMessenger();
    const gateway = new FeishuGateway({
      botOpenId: BOT_OPEN_ID,
      botAppId: 'cli_minori',
      eventStore: events,
      messageContext: { isBotMessage: vi.fn(async () => false) },
      reactions: messenger,
      signalWorker: vi.fn(),
      logger: pino({ level: 'silent' }),
    });

    await gateway.handle(rawEvent({ event_id: 'evt_typing_lifecycle' }));
    expect(messenger.reactions).toEqual(new Set(['typing_om_group_1']));

    const [first] = await events.claimReady(1, new Date(Date.now() + 60_000));
    const firstWorker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: vi.fn(async () => { throw new Error('transient_model_failure'); }),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await firstWorker.process(first!);
    expect(messenger.reactions).toEqual(new Set(['typing_om_group_1']));

    const restartedEvents = new PostgresEventStore(
      database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    const [recovered] = await restartedEvents.claimReady(1, new Date(Date.now() + 60_000));
    const restartedWorker = new MessageWorker({
      eventStore: restartedEvents,
      conversations: new PostgresConversationStore(database.db),
      messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: vi.fn(async () => ({
        text: 'recovered answer', sources: [], usage: {},
        outcome: 'completed' as const, writeAttempts: [],
      })),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await restartedWorker.process(recovered!);

    expect(messenger.replies).toHaveLength(1);
    expect(messenger.replies[0]?.format).toBe('rich');
    expect(messenger.reactions.size).toBe(0);
    expect(await restartedEvents.claimReady(1, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('accepts a delivered group request and completes an audited create-append-patch flow', async () => {
    const canonicalUrl = 'https://acme.feishu.cn/docx/doxcnRelease';
    let document = {
      token: 'doxcnRelease', title: 'Release candidate', url: canonicalUrl,
      markdown: '', revisionId: 0,
    };
    let fetchedRevisionBeforePatch: number | undefined;
    const knowledge: KnowledgeService = {
      search: vi.fn(async () => ({
        status: 'complete' as const,
        results: [], rawCount: 0, validCount: 0, omittedCount: 0,
      })),
      fetchDocument: vi.fn(async () => {
        fetchedRevisionBeforePatch = document.revisionId;
        return { ...document };
      }),
      listSpaces: vi.fn(async () => []),
      listNodes: vi.fn(async () => []),
      getNode: vi.fn(),
      createDocument: vi.fn(async (input: {
        title: string; content: string; parentToken?: string;
      }) => {
        expect(input).toEqual({
          title: 'Release candidate',
          content: '# Release candidate\nDraft phrase.',
          parentToken: 'fldcnFixture',
        });
        document = { ...document, title: input.title, markdown: input.content, revisionId: 1 };
        return { operation: 'create' as const, ...document };
      }),
      appendDocument: vi.fn(async (input: { doc: string; content: string }) => {
        expect(input).toEqual({
          doc: 'doxcnRelease', content: '\n## Acceptance\nSecond section.',
        });
        document = {
          ...document,
          markdown: `${document.markdown}${input.content}`,
          revisionId: 2,
        };
        return { operation: 'append' as const, ...document };
      }),
      patchDocument: vi.fn(async (input: {
        doc: string; pattern: string; replacement: string;
      }) => {
        expect(input).toEqual({
          doc: 'doxcnRelease', pattern: 'Draft phrase.', replacement: 'Approved phrase.',
        });
        expect(fetchedRevisionBeforePatch).toBe(document.revisionId);
        expect(document.markdown.split(input.pattern)).toHaveLength(2);
        document = {
          ...document,
          markdown: document.markdown.replace(input.pattern, input.replacement),
          revisionId: 3,
        };
        return { operation: 'patch' as const, ...document };
      }),
    };
    const runStore = new PostgresAgentRunStore(database.db);
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([{
          type: 'tool-call', toolCallId: 'call_create', toolName: 'createDocument',
          input: JSON.stringify({
            title: 'Release candidate',
            content: '# Release candidate\nDraft phrase.',
            parentToken: 'fldcnFixture',
          }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_append', toolName: 'appendDocument',
          input: JSON.stringify({
            doc: 'doxcnRelease', content: '\n## Acceptance\nSecond section.',
          }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_get_current', toolName: 'fetchDocument',
          input: JSON.stringify({ doc: 'doxcnRelease', mode: 'full' }),
        }], 'tool-calls'),
        generated([{
          type: 'tool-call', toolCallId: 'call_patch', toolName: 'patchDocument',
          input: JSON.stringify({
            doc: 'doxcnRelease',
            pattern: 'Draft phrase.',
            replacement: 'Approved phrase.',
          }),
        }], 'tool-calls'),
        generated([{
          type: 'text',
          text: `Updated the release candidate: ${canonicalUrl}`,
        }], 'stop'),
      ],
    });
    const messenger = new FakeMessenger();
    const worker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger,
      loadWriteAttempts: (eventId) => runStore.listWriteAttempts(eventId),
      logger: { warn: vi.fn(), info: vi.fn() },
      runAgent: (message, claimAttempt, signal) => {
        if (message.content.kind !== 'text') throw new Error('unsupported_agent_input');
        return runKnowledgeAgent({
          prompt: message.content.text,
          history: [],
          trigger: {
            kind: 'feishu_member',
            senderOpenId: message.senderOpenId,
            chatId: message.chatId,
            chatType: message.chatType,
            occurredAt: message.occurredAt,
          },
        }, {
          model,
          service: knowledge,
          eventId: message.eventId,
          claimAttempt,
          modelName: '5.6-terra',
          maxSteps: 20,
          timeoutMs: 180_000,
          botOpenId: BOT_OPEN_ID,
          botAppId: 'cli_minori',
          agentRunStore: runStore,
          onOperationalError: vi.fn(),
          conversationKey: message.conversationKey,
          triggerMessageId: message.messageId,
          conversationStore: conversations,
        }, signal);
      },
    });
    const incoming = normalizeMessageEvent(rawEvent({
      event_id: 'evt_write_flow',
      message: {
        message_id: 'om_write_flow', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888002000',
        content: JSON.stringify({ text: '@_user_1 update the release candidate' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    }), { botOpenId: BOT_OPEN_ID })!;

    expect(await events.enqueue(incoming)).toBe('queued');
    const [claimed] = await events.claimReady(1, new Date(Date.now() + 60_000));
    await worker.process(claimed!);

    expect(document).toMatchObject({
      markdown: '# Release candidate\nApproved phrase.\n## Acceptance\nSecond section.',
      revisionId: 3,
    });
    expect(messenger.replies).toHaveLength(1);
    expect(messenger.replies[0]?.text).toContain(canonicalUrl);
    expect(messenger.replies[0]?.text).toContain(`Sources:\n[1] Release candidate — ${canonicalUrl}`);
    expect(knowledge.fetchDocument).toHaveBeenCalledOnce();
    expect(model.doGenerateCalls).toHaveLength(5);
    const toolNames = model.doGenerateCalls[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames.sort()).toEqual([
      'appendDocument', 'createDocument', 'fetchDocument', 'getKnowledgeNode',
      'listKnowledgeNodes', 'listKnowledgeSpaces', 'patchDocument',
      'searchConversationHistory', 'searchKnowledge',
    ]);
    expect(toolNames.join(' ')).not.toMatch(
      /delete|move|overwrite|permission|sharing|raw|shell|http|filesystem/iu,
    );
    const [run] = await database.db.select().from(agentRuns)
      .where(eq(agentRuns.eventId, 'evt_write_flow'));
    expect(run).toMatchObject({
      model: '5.6-terra', outcome: 'completed', toolCallCount: 4,
      inputTokens: 50, outputTokens: 20,
    });
    const audits = await database.db.select().from(toolRuns)
      .where(eq(toolRuns.agentRunId, run!.id));
    expect(audits).toHaveLength(3);
    expect(audits.map((audit) => ({ toolName: audit.toolName, success: audit.success })))
      .toEqual(expect.arrayContaining([
        { toolName: 'createDocument', success: true },
        { toolName: 'appendDocument', success: true },
        { toolName: 'patchDocument', success: true },
      ]));
  });

  it('recovers a crash after a write with one truthful receipt and zero Agent replays', async () => {
    const incoming = normalizeMessageEvent(rawEvent({
      event_id: 'evt_write_crash',
      message: {
        message_id: 'om_write_crash', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888003000',
        content: JSON.stringify({ text: '@_user_1 create the crash plan' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    }), { botOpenId: BOT_OPEN_ID })!;
    await events.enqueue(incoming);
    await events.claimReady(1, new Date(Date.now() - 1));
    const runStore = new PostgresAgentRunStore(database.db);
    const run = await runStore.start({
      eventId: incoming.eventId, claimAttempt: 1, model: '5.6-terra',
    });
    const write = await runStore.beginWrite(run.id, {
      toolName: 'createDocument',
      targetIdentifiers: {},
      sanitizedSummary: 'created one document',
    });
    await runStore.finishWrite(write.id, {
      outcome: 'succeeded',
      resultIdentifiers: {
        token: 'doxcnCrash',
        title: 'Crash plan',
        url: 'https://acme.feishu.cn/docx/doxcnCrash',
        revisionId: '1',
      },
    });

    expect(await events.recoverExpiredLeases(new Date(), 1)).toBe(1);
    const [recovered] = await events.claimReady(1, new Date(Date.now() + 60_000));
    const messenger = new FakeMessenger();
    const runAgent = vi.fn();
    const worker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger,
      loadWriteAttempts: (eventId) => runStore.listWriteAttempts(eventId),
      runAgent,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await worker.process(recovered!);

    expect(recovered?.writeStartedAt).toBeInstanceOf(Date);
    expect(runAgent).not.toHaveBeenCalled();
    expect(messenger.replies).toHaveLength(1);
    expect(messenger.replies[0]).toMatchObject({ messageId: 'om_write_crash' });
    expect(messenger.replies[0]?.key).toMatch(/^minori-/u);
    expect(messenger.replies[0]?.text).toContain('写入开始后中断');
    expect(messenger.replies[0]?.text).toContain('https://acme.feishu.cn/docx/doxcnCrash');
  });

  it('expires old message bodies and replays a recent uncertain transport result only once', async () => {
    const messenger = new FakeMessenger();
    const originalReply = messenger.replyRichContent.bind(messenger);
    let loseConfirmation = true;
    messenger.replyRichContent = vi.fn(async (messageId, text, key) => {
      const replyId = await originalReply(messageId, text, key);
      if (loseConfirmation) {
        loseConfirmation = false;
        throw new Error('confirmation_lost');
      }
      return replyId;
    });
    const worker = new MessageWorker({
      eventStore: events, conversations, messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: vi.fn(async () => ({
        text: 'safe answer', sources: [], usage: {},
        outcome: 'completed' as const, writeAttempts: [],
      })),
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
      conversations: new PostgresConversationStore(database.db),
      messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: vi.fn(async () => ({
        text: 'safe answer', sources: [], usage: {},
        outcome: 'completed' as const, writeAttempts: [],
      })),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const [recovered] = await restartedEvents.claimReady(1, new Date(Date.now() + 60_000));
    await restartedWorker.process(recovered!);

    expect(messenger.replies).toHaveLength(2);
    expect(messenger.replies.every((reply) => reply.format === 'rich')).toBe(true);
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

  it('leaves the fifth independent Feishu-delivered conversation durably queued', async () => {
    const root = normalizeMessageEvent(rawEvent(), { botOpenId: BOT_OPEN_ID })!;
    const privateMessages = ['a', 'b', 'c', 'd', 'e'].map((suffix): NormalizedMessage => ({
      ...root,
      eventId: `evt_private_${suffix}`,
      messageId: `om_private_${suffix}`,
      chatId: `oc_private_${suffix}`,
      chatType: 'p2p',
      conversationKey: `oc_private_${suffix}`,
    }));
    for (const event of privateMessages) await events.enqueue(event);

    const firstBatch = await events.claimReady(4, new Date(Date.now() + 60_000));

    expect(firstBatch).toHaveLength(4);
    const firstIds = new Set(firstBatch.map((event) => event.eventId));
    const queuedId = privateMessages.find((event) => !firstIds.has(event.eventId))!.eventId;

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
      return {
        text: 'concurrent answer', sources: [], usage: {},
        outcome: 'completed', writeAttempts: [],
      };
    });
    const worker = new MessageWorker({
      eventStore: events,
      conversations,
      messenger: new FakeMessenger(),
      loadWriteAttempts: noWriteAttempts,
      runAgent,
      logger: { warn: vi.fn(), info: vi.fn() },
      concurrency: 4,
    });
    await Promise.all(firstBatch.map((event) => worker.process(event)));
    expect(peak).toBe(4);

    const secondBatch = await events.claimReady(1, new Date(Date.now() + 60_000));
    expect(secondBatch[0]?.eventId).toBe(queuedId);
  });

  it('sends one explicit continuation reply for each execution budget without retry', async () => {
    const root = normalizeMessageEvent(rawEvent(), { botOpenId: BOT_OPEN_ID })!;
    const budgetEvents: NormalizedMessage[] = [
      {
        ...root,
        eventId: 'evt_step_limit', messageId: 'om_step_limit',
        chatId: 'oc_step_limit', chatType: 'p2p', conversationKey: 'oc_step_limit',
      },
      {
        ...root,
        eventId: 'evt_timeout', messageId: 'om_timeout',
        chatId: 'oc_timeout', chatType: 'p2p', conversationKey: 'oc_timeout',
      },
    ];
    for (const event of budgetEvents) await events.enqueue(event);
    const messenger = new FakeMessenger();
    const runAgent = vi.fn(async (message: NormalizedMessage): Promise<AgentReply> => {
      const outcome = message.eventId === 'evt_step_limit'
        ? 'step_limit_reached' as const
        : 'timeout_reached' as const;
      return {
        text: budgetExhaustedText(outcome, []),
        sources: [], usage: {}, outcome, writeAttempts: [],
      };
    });
    const worker = new MessageWorker({
      eventStore: events, conversations, messenger, runAgent,
      loadWriteAttempts: noWriteAttempts,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    const claimed = await events.claimReady(2, new Date(Date.now() + 60_000));
    await Promise.all(claimed.map((event) => worker.process(event)));

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(messenger.replies).toHaveLength(2);
    expect(messenger.replies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: 'om_step_limit',
        text: expect.stringContaining('执行步数上限'),
      }),
      expect.objectContaining({
        messageId: 'om_timeout',
        text: expect.stringContaining('执行时间上限'),
      }),
    ]));
    expect(messenger.replies.every((reply) => reply.text.includes('请回复“继续”'))).toBe(true);
    expect(await events.claimReady(2, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('does not resend after the one-hour Feishu deduplication window', async () => {
    const messenger = new FakeMessenger();
    messenger.reactions.add('typing_stale');
    const restartedEvents = new PostgresEventStore(
      database.db, { minRetryDelayMs: 0, maxRetryDelayMs: 0 },
    );
    const worker = new MessageWorker({
      eventStore: restartedEvents,
      conversations,
      messenger,
      loadWriteAttempts: noWriteAttempts,
      runAgent: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn() },
      now: () => new Date('2026-08-05T02:00:01Z'),
    });
    const incoming = normalizeMessageEvent(rawEvent({ event_id: 'evt_uncertain' }), {
      botOpenId: BOT_OPEN_ID,
    })!;
    await events.enqueue(incoming);
    await events.claimReady(1, new Date('2026-08-05T01:30:00Z'));
    await events.attachProcessingReaction('evt_uncertain', 'typing_stale');
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
