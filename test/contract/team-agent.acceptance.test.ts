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
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import type { FeishuMessenger } from '../../src/feishu/client.js';
import { FeishuGateway } from '../../src/feishu/gateway.js';
import { normalizeMessageEvent } from '../../src/feishu/normalize-event.js';
import { LarkKnowledgeService, type KnowledgeService } from '../../src/lark/knowledge-service.js';
import { PostgresAgentRunStore } from '../../src/storage/agent-run-store.js';
import { PostgresConversationStore } from '../../src/storage/conversation-store.js';
import { createDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { PostgresEventStore } from '../../src/storage/event-store.js';
import { agentRuns, toolRuns } from '../../src/storage/schema.js';
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
      const doc = link ?? (await reader.search({ query: 'roadmap' }))[0]!.token;
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
    expect(messenger.replies.some(
      (reply) => reply.text.includes('https://acme.feishu.cn/docx/doxcnRoadmap'),
    )).toBe(true);
    expect(messenger.replies.some((reply) => reply.text.includes('暂不支持'))).toBe(true);
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

  it('keeps durable Typing through retry and restart until the terminal reply', async () => {
    const messenger = new FakeMessenger();
    const gateway = new FeishuGateway({
      botOpenId: BOT_OPEN_ID,
      botAppId: 'cli_minori',
      eventStore: events,
      messageContext: { isBotMessage: vi.fn(async () => false) },
      threads: conversations,
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
      search: vi.fn(async () => []),
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
          },
        }, {
          model,
          service: knowledge,
          eventId: message.eventId,
          claimAttempt,
          modelName: '5.6-terra',
          maxSteps: 20,
          timeoutMs: 180_000,
          agentRunStore: runStore,
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
