# Read-Only Team Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently useful release: an approved Feishu group member can converse with an AI SDK Agent that searches and reads team knowledge through Lark CLI and returns source-linked answers.

The Agent remains useful for open-ended general assistance without forcing every turn through knowledge retrieval. Team Knowledge Claims, however, require retrieval and source attribution.

**Architecture:** A Feishu long-connection gateway persists normalized events to Neon and returns within the platform's three-second event window. A single-process worker claims persisted events, validates group membership, runs a read-only `ToolLoopAgent`, and replies through the Feishu Node SDK. Lark CLI is available only through a typed command catalog executed with `spawn(..., { shell: false })` as the dedicated user.

**Tech Stack:** Node.js 22 LTS, TypeScript ESM, npm, Vercel AI SDK with `@ai-sdk/openai`, OpenAI Responses API, Feishu Node SDK, official Lark CLI, Neon PostgreSQL, Drizzle ORM, Fastify, Zod, Pino, Vitest, Docker Compose on an existing Vultr Linux host.

## Global Constraints

- One Docker container and one service process; no Redis and no local persistent database.
- The first cloud target is the team's existing Ubuntu 24.04 LTS x86_64 Vultr host, deployed with Docker Compose. Keep the image portable, but make the first-release operator path concrete for this host baseline.
- Production releases are manually approved and deployed on Vultr from an explicit Git commit. Do not auto-deploy pushes to `main` in plan 1.
- Neon PostgreSQL is the durable store.
- Plan 1 uses the OpenAI API directly through `@ai-sdk/openai`, not Vercel AI Gateway. The default model is `gpt-5.6-terra`; `AI_MODEL` may override it. `OPENAI_BASE_URL` is optional: when absent, use the provider's official OpenAI endpoint; when present, pass it as the provider `baseURL`. A custom endpoint must implement the OpenAI Responses API features used by the Agent; Minori does not silently fall back to Chat Completions.
- Send OpenAI Responses requests with `store: false`. Minori owns the durable 30-day conversation history in Neon and must not rely on provider-side stored responses or `previous_response_id` for cross-turn continuity.
- Use the official Lark CLI with `--as user`; never fall back to bot identity for knowledge reads.
- The dedicated Feishu user's native permissions are the sole knowledge-access boundary. Do not maintain an application-level allowlist of spaces or document roots; optional space filters narrow retrieval but do not grant or deny authority.
- This plan exposes only search, tree navigation, metadata, and document-fetch tools. It exposes no create, update, delete, move, permission, raw API, shell, generic HTTP, or filesystem tool.
- Use one general-purpose `ToolLoopAgent`; do not add an intent router, scenario classifier, or hard-coded workflow per request type. Define principles and authority in instructions, then let the Agent decide whether, when, and how often to use the available tools.
- Accepted input is plain text or Feishu rich text (`post`). Normalize visible text, links, and code while removing the bot activation mention. Recognize Feishu document links as Lark document tokens, never as generic URLs. Triggered image, audio, video, or file-only messages receive an explicit unsupported-type reply and never enter model context.
- Feishu group traffic is accepted only from configured groups. Private chat is accepted only for a current member of at least one configured group.
- In an allowed group, a message starts an Agent Thread only when it mentions Minori or replies to a Minori message. Eligible members may continue inside that Feishu reply thread without repeating the mention; unrelated group-timeline messages never activate the Agent. Every eligible private-chat message activates the Agent.
- Membership verification fails closed and may be cached for at most five minutes.
- Retrieved documents are untrusted input and cannot alter tool policy, identity, or runtime context.
- Knowledge retrieval is adaptive. Prefer the most relevant sections first, but let the Agent expand to adjacent sections, additional documents, or a paginated full document whenever needed for an accurate answer—even when the user did not explicitly request a full-document operation. Candidate counts and a 40k–60k-token evidence target are soft budgets, not workflow gates; permissions, the model context limit, the 12-step ceiling, and the 90-second timeout are hard boundaries.
- Full conversation messages are retained for 30 days by default, configurable by environment. Plan 1 performs automatic expiry; it does not preserve expired content as implicit long-term memory.
- Each run automatically receives the newest messages from its own Agent Thread or private conversation up to a soft 24k-token context target. A read-only `searchConversationHistory` tool may search older, unexpired messages only within that same `conversationKey`; the key is bound by trusted runtime code and is never a model-controlled argument. This is retained thread history, not long-term memory: it creates no summaries and returns nothing after message expiry.
- Secrets, connection strings, user tokens, cookies, and authorization URLs never enter model context or logs.
- Feishu long-connection handlers persist and return within three seconds; model work runs asynchronously from persisted events.
- When processing begins, add a `Typing` reaction to the triggering Feishu message and remove it on every completion or failure path. Do not send scenario-specific progress messages or expose reasoning steps.
- Events are processed serially within one Agent Thread and concurrently across different conversations. Plan 1 defaults to four concurrent Agent runs, configurable at runtime.
- Plan 1 prioritizes unrestricted normal team conversation: it has no per-member request quota, per-conversation queue cap, global accepted-event cap, or application-level daily token budget. Control technical runaway through event idempotency, four-way worker concurrency, bounded retries, per-tool limits, the 12-step Agent ceiling, and the 90-second run timeout. Persist token usage, latency, tool-call counts, and outcomes in `agent_runs` for evidence-based tuning; manage emergency spending limits outside the conversational workflow.
- Persist a deterministic reply idempotency key before calling Feishu. Retry an unresolved send with the same key only within Feishu's one-hour deduplication window; after that, mark it as an Uncertain Reply, remove any Processing Reaction, emit a redacted structured error, and never resend the old answer automatically.
- Plan 1 has no dedicated operations chat or proactive alerting channel. Operational failures appear in redacted structured logs and readiness state; user-visible failures are answered briefly in the originating conversation when safe.
- Use TDD for every behavior and commit after each task.

---

## Scope Decomposition

This is plan 1 of 3:

1. **This plan:** cloud-running read-only Team Agent with Feishu, Neon, AI SDK, Lark search/read, citations, Docker, persistent Lark credentials, and real cloud acceptance.
2. **Next plan:** autonomous create/append/patch with write auditing and conflict handling.
3. **Final plan:** durable schedules and extended operational hardening.

Completing this plan produces deployable, useful software without waiting for write or scheduling capabilities.

Opt-in long-term memory is future scope. Plan 1 must not add memory tables, summaries, or hidden retention that survives conversation-message expiry.

## File Map

```text
src/runtime/config.ts              Parse environment exactly once.
src/runtime/logger.ts              Structured logger and redaction.
src/runtime/health.ts              Liveness/readiness HTTP routes.
src/contracts/messages.ts          Stable normalized message contract.
src/storage/schema.ts              Plan-1 PostgreSQL tables only.
src/storage/database.ts            Pool and Drizzle lifecycle.
src/storage/event-store.ts         Durable event claim/complete/retry.
src/storage/conversation-store.ts  Conversation and message history.
src/storage/allowed-chat-store.ts  Configured group lookup.
src/storage/retention.ts           Automatic expiry of conversation bodies.
src/lark/command-catalog.ts         Typed IDs to exact CLI argv.
src/lark/runner.ts                  Safe subprocess execution.
src/lark/read-service.ts            Domain-shaped search/fetch/tree API.
src/feishu/normalize-event.ts       SDK event to durable event conversion.
src/feishu/membership.ts            Group and private-chat eligibility.
src/feishu/client.ts                SDK calls for members and replies.
src/feishu/gateway.ts               WS registration and fast persistence.
src/agent/model.ts                  AI SDK model selection.
src/agent/context-window.ts         Recent context selection and token estimate.
src/agent/instructions.ts           Read-only Agent policy.
src/agent/tools.ts                  Strict Lark read tools.
src/agent/run.ts                    Context loading, Agent run, sources.
src/worker/message-worker.ts        Claim, authorize, run, reply, complete.
src/app.ts                          Dependency composition and lifecycle.
src/main.ts                         Process entrypoint and signal handling.
```

Tests mirror these folders under `test/`. External contracts use fixtures under `test/fixtures/`; real Feishu/Lark tests are opt-in.

### Task 1: Bootstrap a validated, observable service

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `.gitignore`, `.env.example`
- Create: `src/runtime/config.ts`, `src/runtime/logger.ts`, `src/runtime/health.ts`
- Create: `src/app.ts`, `src/main.ts`
- Test: `test/runtime/config.test.ts`, `test/runtime/health.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): AppConfig`
- Produces: `createLogger(level): Logger`
- Produces: `buildHealthServer(probes): FastifyInstance`

- [ ] **Step 1: Initialize npm and install the exact dependency set**

```bash
npm init -y
npm pkg set type=module private=true engines.node='>=22'
npm install ai @ai-sdk/openai @larksuiteoapi/node-sdk @larksuite/cli drizzle-orm fastify pg pino zod
npm install --save-dev @testcontainers/postgresql @types/node @types/pg drizzle-kit tsx typescript vitest
npm pkg set scripts.dev='tsx watch src/main.ts' scripts.build='tsc -p tsconfig.json' scripts.start='node dist/main.js' scripts.typecheck='tsc --noEmit' scripts.test='vitest run' scripts.test:integration='vitest run --config vitest.integration.config.ts' scripts.verify='npm run typecheck && npm test && npm run build'
```

Expected: `package-lock.json` pins the resolved versions and `package.json` contains no credentials.

- [ ] **Step 2: Write failing configuration tests**

```ts
// test/runtime/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';

describe('loadConfig', () => {
  it('starts in unconfigured mode without external secrets', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      port: 3000,
      allowedChatIds: [],
      larkCliBin: 'lark-cli',
      larkConfigDir: '/var/lib/minori/lark',
    });
  });

  it('splits and deduplicates allowed chat ids', () => {
    expect(loadConfig({ ALLOWED_CHAT_IDS: 'oc_a, oc_b,oc_a' }).allowedChatIds)
      .toEqual(['oc_a', 'oc_b']);
  });

  it('defaults to Terra and accepts an optional OpenAI-compatible base URL', () => {
    expect(loadConfig({ OPENAI_BASE_URL: 'https://llm.example.com/v1' })).toMatchObject({
      aiModel: 'gpt-5.6-terra',
      openaiBaseUrl: 'https://llm.example.com/v1',
    });
  });
});
```

- [ ] **Step 3: Run the tests and observe the missing module failure**

Run: `npm test -- test/runtime/config.test.ts`  
Expected: FAIL because `src/runtime/config.ts` does not exist.

- [ ] **Step 4: Implement the configuration contract**

```ts
// src/runtime/config.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url().optional(),
  FEISHU_APP_ID: z.string().min(1).optional(),
  FEISHU_APP_SECRET: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  AI_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  CONVERSATION_CONTEXT_TOKEN_TARGET: z.coerce.number().int().positive().default(24_000),
  ALLOWED_CHAT_IDS: z.string().default(''),
  LARK_CLI_BIN: z.string().default('lark-cli'),
  LARKSUITE_CLI_CONFIG_DIR: z.string().default('/var/lib/minori/lark'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
    openaiApiKey: parsed.OPENAI_API_KEY,
    openaiBaseUrl: parsed.OPENAI_BASE_URL,
    aiModel: parsed.AI_MODEL,
    conversationContextTokenTarget: parsed.CONVERSATION_CONTEXT_TOKEN_TARGET,
    allowedChatIds: [...new Set(parsed.ALLOWED_CHAT_IDS.split(',').map(v => v.trim()).filter(Boolean))],
    larkCliBin: parsed.LARK_CLI_BIN,
    larkConfigDir: parsed.LARKSUITE_CLI_CONFIG_DIR,
  };
}
```

- [ ] **Step 5: Write and implement health tests**

```ts
// test/runtime/health.test.ts
import { expect, it } from 'vitest';
import { buildHealthServer } from '../../src/runtime/health.js';

it('reports component readiness without exposing details', async () => {
  const app = buildHealthServer({ database: async () => 'unconfigured' });
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  expect(response.json()).toEqual({ status: 'degraded', components: { database: 'unconfigured' } });
  await app.close();
});
```

Implement `buildHealthServer(probes: Record<string, () => Promise<'ok' | 'degraded' | 'unconfigured'>>)` and `/health/live` returning `{status:'ok'}`. Readiness covers database, Feishu connection, Lark authentication, model configuration, and retention maintenance using status categories only. Create a Pino logger with `redact` paths for `*.appSecret`, `*.token`, `*.authorization`, `*.databaseUrl`, and `*.authorizationUrl`.

At process startup, a bounded model preflight validates that the configured base URL supports the Responses API contract required by the selected model, including structured tool calls. Cache that result for readiness reporting so health polling does not generate model requests or cost. An endpoint that only supports Chat Completions reports the model component as `degraded`; it does not trigger protocol fallback. The preflight logs only a redacted error category and never logs credentials or response bodies that may contain provider details.

- [ ] **Step 6: Add minimal process lifecycle and verify**

`src/app.ts` must return `{ start(): Promise<void>; stop(): Promise<void> }`. `src/main.ts` loads config once, starts health, and handles `SIGTERM`/`SIGINT` by awaiting `stop()`.

Run: `npm run verify`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src test
git commit -m "chore: bootstrap team agent runtime"
```

### Task 2: Persist normalized events and conversations in PostgreSQL

**Files:**
- Create: `src/contracts/messages.ts`
- Create: `drizzle.config.ts`, `src/storage/schema.ts`, `src/storage/database.ts`
- Create: `src/storage/event-store.ts`, `src/storage/conversation-store.ts`, `src/storage/allowed-chat-store.ts`
- Create: `vitest.integration.config.ts`
- Test: `test/storage/event-store.test.ts`, `test/storage/conversation-store.test.ts`
- Generated: `drizzle/**`

**Interfaces:**
- Produces: `EventStore.enqueue(event): Promise<'queued' | 'duplicate'>`
- Produces: `EventStore.claimReady(limit, leaseUntil): Promise<StoredEvent[]>`
- Produces: `EventStore.complete(eventId, claimAttempt, outcome): Promise<void>`
- Produces: `EventStore.markReplyStarted(eventId, claimAttempt, key, attemptedAt): Promise<void>`
- Produces: `EventStore.markReplyUncertain(eventId, claimAttempt): Promise<void>`
- Produces: `EventStore.retry(eventId, claimAttempt, errorCode, nextAttemptAt): Promise<void>`
- Produces: `EventStore.recoverExpiredLeases(now, limit): Promise<number>`
- Produces: `ConversationStore.append(message): Promise<void>`
- Produces: `ConversationStore.recentWithinBudget(conversationKey, tokenTarget, triggerMessageId): Promise<StoredMessage[]>`
- Produces: `ConversationStore.search(conversationKey, query, limit): Promise<StoredMessageExcerpt[]>`
- Produces: `ConversationStore.purgeExpired(before): Promise<number>`
- Produces: `AllowedChatStore.isAllowed(chatId): Promise<boolean>`

```ts
// attempts is also the fencing token for this claim. Every ownership-sensitive
// update must present the value returned by claimReady.
export type StoredEvent = { eventId: string; payload: NormalizedMessage; attempts: number };
export type StoredMessage = {
  messageId: string; conversationId: string; role: 'user' | 'assistant';
  senderOpenId?: string; content: string; createdAt: Date;
};
export type StoredMessageExcerpt = Pick<StoredMessage, 'messageId' | 'role' | 'createdAt'> & {
  excerpt: string;
};
export interface EventStore {
  enqueue(event: NormalizedMessage): Promise<'queued' | 'duplicate'>;
  claimReady(limit: number, leaseUntil: Date): Promise<StoredEvent[]>;
  complete(eventId: string, claimAttempt: number, outcome: { replyMessageId?: string; errorCode?: string }): Promise<void>;
  markReplyStarted(eventId: string, claimAttempt: number, key: string, attemptedAt: Date): Promise<void>;
  markReplyUncertain(eventId: string, claimAttempt: number): Promise<void>;
  retry(eventId: string, claimAttempt: number, errorCode: string, nextAttemptAt: Date): Promise<void>;
  recoverExpiredLeases(now: Date, limit: number): Promise<number>;
}
export interface ConversationStore {
  append(message: StoredMessage): Promise<void>;
  recentWithinBudget(conversationKey: string, tokenTarget: number, triggerMessageId: string): Promise<StoredMessage[]>;
  search(conversationKey: string, query: string, limit: number): Promise<StoredMessageExcerpt[]>;
  purgeExpired(before: Date): Promise<number>;
}
export interface AllowedChatStore { isAllowed(chatId: string): Promise<boolean> }
```

- [ ] **Step 1: Write failing durable-enqueue and lease integration tests**

```ts
const event = {
  eventId: 'evt_1', messageId: 'om_1', chatId: 'oc_1', conversationKey: 'oc_1:om_root',
  senderOpenId: 'ou_1', chatType: 'group' as const,
  content: { kind: 'text' as const, text: 'hello', feishuLinks: [] },
  occurredAt: new Date('2026-08-05T00:00:00Z'),
};
const [first, second] = await Promise.all([store.enqueue(event), store.enqueue(event)]);
expect([first, second].sort()).toEqual(['duplicate', 'queued']);
```

Also enqueue two events for the same Agent Thread and one event for a different conversation. Assert one `claimReady(4, leaseUntil)` call claims the first same-thread event plus the independent event, but not the second same-thread event. After completion, the second event becomes claimable. Use `@testcontainers/postgresql` in `beforeAll`, apply migrations once, and close the container in `afterAll`.

Create the shared contract before the test so every later task imports the same type:

```ts
// src/contracts/messages.ts
export type NormalizedMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  conversationKey: string;
  rootId?: string;
  senderOpenId: string;
  chatType: 'group' | 'p2p';
  content:
    | { kind: 'text'; text: string; feishuLinks: string[] }
    | { kind: 'unsupported'; sourceMessageType: string };
  occurredAt: Date;
};
```

- [ ] **Step 2: Run the integration test and observe failure**

Run: `npm run test:integration -- test/storage/event-store.test.ts`  
Expected: FAIL because the schema and store do not exist.

- [ ] **Step 3: Define the plan-1 schema**

Create tables with UUID primary keys and timezone-aware timestamps:

```ts
export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  messageId: text('message_id').notNull(),
  payload: jsonb('payload').$type<NormalizedMessage>().notNull(),
  conversationKey: text('conversation_key').notNull(),
  status: text('status').$type<'queued' | 'processing' | 'completed' | 'failed'>().notNull(),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  processingReactionId: text('processing_reaction_id'),
  replyIdempotencyKey: text('reply_idempotency_key'),
  replyAttemptedAt: timestamp('reply_attempted_at', { withTimezone: true }),
  replyMessageId: text('reply_message_id'),
  outcome: jsonb('outcome').$type<{ replyMessageId?: string; errorCode?: string }>(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Also define `allowed_chats`, `conversations`, `messages`, `agent_runs`, and `tool_runs`. `agent_runs` records model name, input/output tokens when reported, latency, tool-call count, and outcome without storing secrets or provider reasoning. Do not add quota counters, write tables, or schedule tables in this plan.

- [ ] **Step 4: Implement durable enqueue and atomic worker leases**

```ts
const inserted = await db.insert(processedEvents).values({
  eventId: event.eventId,
  messageId: event.messageId,
  payload: event,
  conversationKey: event.conversationKey,
  status: 'queued',
}).onConflictDoNothing().returning({ eventId: processedEvents.eventId });
return inserted.length === 1 ? 'queued' : 'duplicate';
```

Implement `claimReady` as one transaction using row locking with `SKIP LOCKED`. It ranks every unfinished event in each conversation so a delayed retry or expired-but-not-yet-recovered claim cannot be overtaken, then claims only an oldest event that is `queued` and due. It changes claimed rows to `processing`, increments attempts, and sets `leased_until`. Treat the returned `attempts` value as a fencing token: `complete`, reply-state updates, and `retry` must match `event_id`, `status='processing'`, and that claim attempt, rejecting stale workers. Clamp retries to the configured minimum and maximum backoff. Implement `recoverExpiredLeases` by returning expired `processing` rows to `queued`; do not wait for an arbitrary age threshold when a valid lease exists.

- [ ] **Step 5: Add conversation round-trip, scoped search, and retention tests**

Test that `recentWithinBudget(conversationKey, tokenTarget, triggerMessageId)` selects the newest messages at or before the explicit trigger that fit the supplied soft budget and returns them chronologically, always preserving that trigger even when timestamps arrive out of order. Test that `search(conversationKey, query, limit)` returns matching unexpired messages from that conversation and cannot return messages from another Agent Thread or private chat, even when their text matches exactly. The query supports Chinese and English text without depending on language-specific PostgreSQL tokenization. Also assert that an existing Feishu message ID is not inserted twice. Test that `purgeExpired(before)` deletes message bodies older than the cutoff without deleting newer messages or retaining derived summaries. Implement the unique constraint, scoped repository queries, a conservative injectable token estimator, and an internal retention service that runs once at startup and then daily using the configured retention period. Wire it into the application lifecycle and health probes. The service is operational maintenance, not a user-created scheduled task.

- [ ] **Step 6: Generate migrations and verify**

```bash
npx drizzle-kit generate --name plan1_initial
npm run test:integration
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add drizzle.config.ts drizzle src/storage test/storage vitest.integration.config.ts package.json package-lock.json
git commit -m "feat: persist conversations and feishu events"
```

### Task 3: Add a shell-free Lark CLI read adapter

**Files:**
- Create: `src/lark/command-catalog.ts`, `src/lark/runner.ts`, `src/lark/errors.ts`, `src/lark/read-service.ts`
- Test: `test/lark/command-catalog.test.ts`, `test/lark/runner.test.ts`, `test/lark/read-service.contract.test.ts`
- Create fixtures: `test/fixtures/lark/*.json`

**Interfaces:**
- Produces: `LarkRunner.run<T>(command, signal?): Promise<T>`
- Produces: `KnowledgeReader.search`, `fetchDocument`, `listSpaces`, `listNodes`, `getNode`

- [ ] **Step 1: Write failing argv-injection tests**

```ts
expect(buildInvocation({ id: 'drive.search', query: 'x; $(touch /tmp/pwned)' })).toEqual({
  args: ['drive', '+search', '--query', 'x; $(touch /tmp/pwned)', '--format', 'json', '--as', 'user'],
});
```

Also assert `docs.fetch` maps to `docs +fetch --doc <value> --doc-format markdown --format json --as user` and that TypeScript cannot construct an unknown command ID.

- [ ] **Step 2: Implement the closed command catalog**

Define this union and no generic command variant:

```ts
export type LarkCommand =
  | { id: 'auth.status' }
  | { id: 'drive.search'; query: string; spaceIds?: string[] }
  | { id: 'docs.fetch'; doc: string }
  | { id: 'wiki.spaceList' }
  | { id: 'wiki.nodeList'; spaceId: string; parentNodeToken?: string }
  | { id: 'wiki.nodeGet'; nodeToken: string };
```

Append optional `--space-ids` as a comma-joined literal argument. Always append `--format json --as user` except `auth.status`, which uses `auth status --format json`.

- [ ] **Step 3: Write failing runner tests with an injected spawn function**

Test success, structured CLI error, malformed JSON, timeout, cancellation, and maximum output. Assert the spawn options contain `shell: false` and `LARKSUITE_CLI_CONFIG_DIR`.

- [ ] **Step 4: Implement `LarkRunner`**

```ts
export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null) => void): this;
}

export interface LarkExecutor {
  run<T>(command: LarkCommand, signal?: AbortSignal): Promise<T>;
}

export type LarkRunnerOptions = {
  binary: string;
  configDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  spawn: typeof import('node:child_process').spawn;
};
```

Implement `run` with this state machine:

```ts
const { args } = buildInvocation(command);
const child = this.options.spawn(this.options.binary, args, {
  shell: false,
  env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: this.options.configDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
let size = 0;
const collect = (target: Buffer[]) => (chunk: Buffer) => {
  size += chunk.byteLength;
  if (size > this.options.maxOutputBytes) child.kill('SIGKILL');
  else target.push(chunk);
};
child.stdout.on('data', collect(stdout));
child.stderr.on('data', collect(stderr));
const timer = setTimeout(() => child.kill('SIGKILL'), this.options.timeoutMs);
signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
const code = await new Promise<number | null>(resolve => child.once('close', resolve));
clearTimeout(timer);
if (size > this.options.maxOutputBytes) throw new LarkCliError('output_limit');
const envelope = larkEnvelopeSchema.parse(JSON.parse(Buffer.concat(stdout).toString('utf8')));
if (code !== 0 || !envelope.ok) throw LarkCliError.fromEnvelope(envelope);
return envelope.data as T;
```

Tests require timeout and caller abort to produce distinct `LarkCliError` codes; store a termination reason before killing the process and check it before parsing output.

- [ ] **Step 5: Implement domain-shaped read methods**

```ts
export interface KnowledgeReader {
  search(input: { query: string; spaceIds?: string[] }): Promise<Array<{ title: string; url: string; token: string; type: string }>>;
  fetchDocument(input: { doc: string }): Promise<{ title: string; url: string; markdown: string }>;
  listSpaces(): Promise<Array<{ spaceId: string; name: string }>>;
  listNodes(input: { spaceId: string; parentNodeToken?: string }): Promise<Array<{ nodeToken: string; title: string; objType: string }>>;
  getNode(input: { nodeToken: string }): Promise<{ nodeToken: string; objToken: string; objType: string; title: string }>;
}
```

Parse fixture envelopes into these types with Zod. Reject shape drift as `LarkContractError`.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- test/lark && npm run typecheck`  
Expected: PASS.

```bash
git add src/lark test/lark test/fixtures/lark
git commit -m "feat: add safe lark knowledge reader"
```

### Task 4: Accept only eligible Feishu messages

**Files:**
- Create: `src/feishu/normalize-event.ts`, `src/feishu/membership.ts`, `src/feishu/client.ts`, `src/feishu/gateway.ts`
- Test: `test/feishu/normalize-event.test.ts`, `test/feishu/membership.test.ts`, `test/feishu/gateway.test.ts`

**Interfaces:**
- Produces: `normalizeMessageEvent(data): NormalizedMessage | null`
- Produces: `MembershipPolicy.authorize(message): Promise<AuthorizationResult>`
- Produces: `FeishuMessenger.replyText(messageId, text, idempotencyKey): Promise<string>`
- Produces: `FeishuMessenger.addReaction(messageId, emojiType): Promise<string | null>`
- Produces: `FeishuMessenger.removeReaction(messageId, reactionId): Promise<void>`
- Consumes: `EventStore.enqueue`
- Consumes: `NormalizedMessage` from `src/contracts/messages.ts`

```ts
export type AuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: 'chat_not_allowed' | 'not_team_member' | 'membership_unavailable' };
export interface ChatMemberSource { listOpenIds(chatId: string): Promise<Set<string>> }
export interface FeishuMessenger {
  replyText(messageId: string, text: string, idempotencyKey: string): Promise<string>;
  addReaction(messageId: string, emojiType: 'Typing'): Promise<string | null>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}
```

- [ ] **Step 1: Define and test normalized messages**

Import `NormalizedMessage` from `src/contracts/messages.ts`. Test plain text; rich-text visible text, links, and code blocks; removal of the activation mention; Feishu document-link extraction; malformed JSON content; missing sender; `root_id`/`parent_id` extraction; bot mentions; replies to Minori; and unsupported message types. Malformed or irrelevant events return `null` without throwing. An otherwise valid, triggered image, audio, video, or file-only event returns `content.kind='unsupported'` so the worker can reply explicitly. Derive conversation identity as the private-chat ID for `p2p`, and as the Agent Thread root message ID for group conversations.

- [ ] **Step 2: Write membership policy tests**

Use an injected `ChatMemberSource.listOpenIds(chatId)` and clock. Cover allowed group, disallowed group, eligible private chat, ineligible private chat, five-minute cache expiry, and API failure returning `{allowed:false, reason:'membership_unavailable'}`.

- [ ] **Step 3: Implement membership using the SDK contract**

`FeishuClient.listMemberOpenIds` calls:

```ts
client.im.v1.chatMembers.get({
  path: { chat_id: chatId },
  params: { member_id_type: 'open_id', page_size: 100, page_token: token },
});
```

Follow `has_more/page_token` until complete. Cache a `Set<string>` per allowed chat for 300,000 ms. Private authorization succeeds when the sender appears in any allowed-chat set.

Implement message reactions through `client.im.v1.messageReaction.create` and `.delete`. Creating returns the `reaction_id` needed for deletion. Reaction API failures are logged with stable, non-secret error codes but do not fail the Agent run.

Implement replies through `client.im.v1.message.reply` with a deterministic `uuid` of at most 50 characters supplied by the worker. The same logical event and reply version must always produce the same key.

- [ ] **Step 4: Write a fast-gateway test**

Given a new valid SDK event, assert the gateway calls `eventStore.enqueue(normalized)` and resolves before a fake downstream worker promise. Given a duplicate, assert it does not enqueue again. In group chat, assert that a direct mention can start an Agent Thread, a reply inside that thread can continue it without another mention, and an unrelated group-timeline message is ignored. In private chat, assert every eligible message is accepted.

- [ ] **Step 5: Implement long-connection registration**

Use `WSClient` and `EventDispatcher.register({'im.message.receive_v1': handler})`. The handler normalizes, persists, signals the in-process worker, and returns immediately. It never awaits model or Lark work.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- test/feishu && npm run typecheck`  
Expected: PASS.

```bash
git add src/feishu test/feishu
git commit -m "feat: gate feishu messages by team membership"
```

### Task 5: Build the read-only AI SDK Agent

**Files:**
- Create: `src/agent/model.ts`, `src/agent/context-window.ts`, `src/agent/instructions.ts`, `src/agent/tools.ts`, `src/agent/run.ts`, `src/agent/sources.ts`
- Test: `test/agent/context-window.test.ts`, `test/agent/tools.test.ts`, `test/agent/run.test.ts`, `test/agent/injection.test.ts`

**Interfaces:**
- Produces: `createReadOnlyAgent(deps): ToolLoopAgent`
- Produces: `runKnowledgeAgent(input): Promise<AgentReply>`
- Consumes: `KnowledgeReader`, `ConversationStore`

```ts
export type AgentReply = {
  text: string;
  sources: Array<{ id: number; title: string; url: string }>;
  usage: { inputTokens?: number; outputTokens?: number };
};
export type AgentRunInput = {
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  trigger: { kind: 'feishu_member'; senderOpenId: string; chatId: string };
};
export interface KnowledgeAgent { run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentReply> }
```

- [ ] **Step 1: Write tool-authority tests**

Assert `createReadTools(reader, scopedHistory)` returns exactly `searchKnowledge`, `fetchDocument`, `listKnowledgeSpaces`, `listKnowledgeNodes`, `getKnowledgeNode`, and `searchConversationHistory`. Assert there is no tool containing `create`, `update`, `delete`, `move`, `permission`, `shell`, `http`, or `file`. The history tool input contains only a query and result limit; it cannot accept a chat ID, conversation key, user ID, retention override, raw SQL, or date outside the retained window.

- [ ] **Step 2: Implement strict tools**

Each tool uses `tool({ description, inputSchema, execute })` with Zod. `fetchDocument` accepts a document token plus an Agent-selected read mode (`relevant` or `full`), an optional relevance query, and an optional opaque continuation cursor. It returns a structurally bounded markdown page plus `{title,url,sectionPath,nextCursor,truncated}` source metadata. The adapter may fetch the source document once and split it by headings locally; subsequent pages in the same Agent run reuse that bounded in-memory result. `relevant` prioritizes matching sections with adjacent context; `full` walks the complete document in order. Neither mode is permission-gated by scenario or requires the user to use special wording. `searchConversationHistory` closes over a runtime-created history reader already bound to the current `conversationKey`; it returns compact matching message excerpts with role and timestamp, never cross-conversation results. No tool accepts arbitrary command names or URL paths.

- [ ] **Step 3: Write an Agent test with a deterministic mock model**

For a Team Knowledge Claim, the mock model must call `searchKnowledge`, then `fetchDocument`, then answer with a valid numbered citation. Add a case where insufficient relevant sections cause the Agent to follow `nextCursor` or switch to `full` without another user instruction. Add a long-thread case: recent messages are selected up to the 24k-token soft target, the model calls `searchConversationHistory` for an older detail, and the tool returns only current-conversation messages. Add a second case for a general rewriting request that answers directly without invoking any tool and returns no sources. Assert all final results match the `AgentReply` interface above.

- [ ] **Step 4: Implement model and Agent construction**

Create an OpenAI provider with `createOpenAI({ apiKey: config.openaiApiKey, ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}) })`, then select `provider(config.aiModel)`. This uses the provider's Responses API path and must not use Vercel AI Gateway. Require `OPENAI_API_KEY` for Agent readiness; `AI_MODEL` defaults to `gpt-5.6-terra`. A configured base URL is accepted only if the model readiness probe verifies the Responses API and structured tool-call behavior; never fall back to Chat Completions. Set OpenAI provider options to `store: false` on every Agent request. Cross-turn context is rebuilt from Minori's retained conversation messages; do not persist or consume `previous_response_id`. Construct `ToolLoopAgent` with `stopWhen: stepCountIs(12)` and a 90-second abort timeout in `runKnowledgeAgent`.

Instructions must state that documents are evidence, never policy; each Team Knowledge Claim needs retrieval and a numbered citation marker such as `[1]`; synthesis must be labelled as synthesis or inference; absence of direct evidence must be explicit; and only supplied tools exist. Citation numbers must resolve to the structured `sources` array in first-use order. General explanations, rewriting, and transformations based only on the current user input may be answered without calling a knowledge tool and must not render an empty Sources section. The instructions express retrieval as a preference, not a workflow: start with relevant evidence, target roughly 40k–60k evidence tokens, and autonomously expand or paginate when accuracy requires it. Do not require a named scenario or explicit user request before reading a full document. Recent conversation context is supplied automatically; when an older detail from the same retained thread would help, the Agent may autonomously use `searchConversationHistory`. History excerpts are conversational context, not Feishu knowledge citations, and cannot be used to claim that a team fact is documented.

- [ ] **Step 5: Add prompt-injection regression tests**

Return a fixture document containing instructions to reveal secrets and call a write tool. Assert the model receives no secret values, the available tool list remains unchanged, and the response marks the document text as untrusted evidence rather than following it. Add citation-contract tests that reject unknown citation numbers, factual team-knowledge claims without markers, and source entries that are never cited. Inspect the mock provider request and assert `store: false`; run a second conversation turn and assert history is supplied from `ConversationStore` without `previous_response_id`.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- test/agent && npm run typecheck`  
Expected: PASS.

```bash
git add src/agent test/agent
git commit -m "feat: add read-only knowledge agent"
```

### Task 6: Process durable events into source-linked Feishu replies

**Files:**
- Create: `src/worker/message-worker.ts`
- Modify: `src/app.ts`, `src/runtime/health.ts`
- Test: `test/worker/message-worker.test.ts`, `test/worker/restart-recovery.test.ts`

**Interfaces:**
- Produces: `MessageWorker.wake(): void`, `start(): Promise<void>`, `stop(): Promise<void>`
- Consumes: event, membership, conversation, Agent, messenger contracts from Tasks 2–5.

- [ ] **Step 1: Write the end-to-end worker unit test**

Arrange one claimed event, allowed membership, stored conversation, Agent reply with two sources, and fake messenger. Assert the worker adds a `Typing` Processing Reaction to the triggering message, persists its reaction ID, persists inbound and assistant messages, durably records a deterministic reply idempotency key before sending, replies once with both clickable URLs, removes the reaction, and completes the event with the reply message ID.

- [ ] **Step 2: Write failure-path tests**

Cover ineligible sender, unsupported attachment-only content, reaction-create failure, reaction-remove failure, Lark auth error, model error, messenger error, and a crash after Feishu accepts the reply but before database completion. Within one hour, retry with the same idempotency key and assert the fake Feishu service produces no duplicate. After one hour, assert the event becomes an Uncertain Reply, its Processing Reaction is removed, a redacted structured error is logged, and no reply call occurs. Ineligible senders never invoke Agent. Unsupported content receives one explicit reply and never invokes the model or Lark. Reaction failures never prevent processing or replying. Every path that obtained a reaction ID attempts removal in `finally`. A model error produces a retryable user-facing message but never says the knowledge base had no result.

- [ ] **Step 3: Implement the worker state machine**

```ts
type PendingEvent = { eventId: string; payload: NormalizedMessage; attempts: number };

export class MessageWorker {
  async process(event: PendingEvent): Promise<void> {
    // authorize -> persist inbound -> load history -> run Agent -> format -> reply -> persist -> complete
  }
}
```

Run a configurable pool of four Agent workers by default. Each worker claims durable events through `claimReady`; the store guarantees that only one event per conversation key is processing at a time while different conversations may run concurrently. Before replying, derive and persist a stable key from the event ID and reply version, then pass it as Feishu's `uuid`. On startup and periodically, recover only expired leases. If an unresolved reply attempt is still inside the one-hour deduplication window, retry with the same key; if the window has expired, mark `reply_uncertain` and do not send. Recovery removes persisted Processing Reactions so a crash does not leave a permanent `Typing` badge. Cap pre-reply attempts at 3, use bounded retry backoff, and record stable error codes.

- [ ] **Step 4: Implement source formatting**

Validate citation markers against the structured source set, then append a compact numbered `Sources` section only when sources exist. Deduplicate by URL while preserving first-use numbering and keep the Agent's answer intact. Never print raw tool JSON or document bodies. If the citation contract is invalid, perform one bounded repair pass; if it remains invalid, return a safe response that says the evidence could not be reliably attributed rather than emitting uncited claims.

- [ ] **Step 5: Compose dependencies and readiness**

`src/app.ts` creates the pool, stores, retention service, Lark runner, Feishu client, membership policy, Agent, worker, gateway, and health server. Readiness is `ok` only when database, Feishu config/connection, Lark auth status, and model config are all `ok`.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`  
Expected: PASS.

```bash
git add src/app.ts src/runtime/health.ts src/worker test/worker
git commit -m "feat: reply to feishu with grounded knowledge"
```

### Task 7: Package, authenticate, and prove the first release

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`
- Create: `deploy/vultr/compose.production.yaml`, `deploy/vultr/env.example`
- Create: `scripts/deploy-vultr.sh`, `scripts/rollback-vultr.sh`
- Create: `scripts/lark-auth.ts`, `scripts/verify-runtime.ts`
- Create: `README.md`
- Create: `test/contract/read-only-agent.acceptance.test.ts`
- Modify: `package.json`, `.env.example`

**Interfaces:**
- Produces operator commands: `npm run lark:auth`, `npm run runtime:verify`
- Produces one non-root runtime image.

- [ ] **Step 1: Add the auth bootstrap script**

The script spawns `lark-cli config init --new`, then `lark-cli auth login --recommend --no-wait`, prints only the verification URL to the operator terminal, and finally runs `lark-cli auth status --format json`. It sets `LARKSUITE_CLI_CONFIG_DIR` from validated config and never logs token fields.

- [ ] **Step 2: Add a multi-stage Dockerfile**

Builder runs `npm ci` and `npm run build`. Runtime copies `dist`, production dependencies, and the locally pinned `lark-cli` binary, creates UID 10001, uses `/var/lib/minori/lark` as the credential mount, and sets `CMD ["node","dist/main.js"]`.

- [ ] **Step 3: Add Docker Compose for local validation**

Compose loads `.env`, mounts `minori-lark-auth:/var/lib/minori/lark`, exposes only the health port, and uses a read-only root filesystem with `/tmp` as `tmpfs`. It does not run PostgreSQL locally; it connects to Neon through `DATABASE_URL`. `deploy/vultr/env.example` documents `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and `AI_MODEL=gpt-5.6-terra`; secrets stay out of Compose YAML and Git.

- [ ] **Step 4: Write the acceptance contract**

The test uses fake Feishu transport, fake model, fixture Lark CLI, and real disposable PostgreSQL. It verifies: allowed group conversation, eligible private conversation, disallowed user rejection, text and rich-text normalization, explicit unsupported-attachment response, direct Feishu document-link reading, iterative search/fetch, source URLs, duplicate-event idempotency, one-hour reply deduplication and post-window Uncertain Reply handling, restart recovery, same-thread ordering with four-way cross-thread concurrency, 30-day message expiry, and absence of write tools or implicit long-term-memory storage.

- [ ] **Step 5: Document exact operator setup**

README sections: Neon creation/migration, Feishu app long connection and `im.message.receive_v1`, bot availability, the `im:message.reactions:write_only` permission, dedicated-user Lark OAuth, required configuration, allowed group IDs, direct OpenAI API setup, optional Responses-compatible `OPENAI_BASE_URL`, local tests, Docker run, Vultr host bootstrap, explicit-commit deployment and rollback, one command for recent redacted errors, credential rotation, and troubleshooting for database/model/Lark auth states. Plan 1 documents no proactive alert channel.

- [ ] **Step 6: Run the full verification**

```bash
npm run verify
npm run test:integration
docker compose build
docker compose run --rm app npm run runtime:verify
```

Expected: all automated suites pass; runtime verification reports configured component states without secret values.

- [ ] **Step 7: Run opt-in real acceptance**

With test credentials, send one group question and one eligible private question. Confirm the Agent reads a real document and returns a working source link. Record the test message IDs and document URLs in a local, gitignored acceptance log.

- [ ] **Step 8: Deploy and prove the cloud runtime**

Deploy the same image to the existing Vultr Linux host with Docker Compose, Neon, model, Feishu app, allowed-chat configuration, `restart: unless-stopped`, and a host directory such as `/opt/minori/lark` bind-mounted at `/var/lib/minori/lark`. Bind the health port to host `127.0.0.1` only; Feishu messaging uses the outbound long connection and requires no public webhook. The deployment command requires an explicit Git commit SHA, builds and tags the candidate before touching the running container, applies backward-compatible migrations, replaces the service only after preflight checks, and restores the previous image when readiness fails. It writes a sanitized local release record containing commit SHA, image tag, timestamp, operator, and result. Complete dedicated-user OAuth through an operator-only bootstrap, verify readiness, verify the configured provider supports Responses plus structured tool calls (and rejects a Chat-Completions-only fixture without fallback), run the real group and private-chat acceptance checks, confirm model requests use `store: false`, reboot or restart the service, and verify that credentials, queued events, conversation continuity, and Processing Reaction cleanup survive. Record only sanitized deployment evidence.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml scripts README.md test/contract package.json package-lock.json .env.example
git commit -m "docs: package read-only team agent release"
```

## Plan Completion Gate

Before starting the autonomous-write plan, verify:

- all seven task commits exist;
- `npm run verify` and integration tests pass;
- the container runs read-only as non-root;
- a real approved Feishu group and eligible private chat both work;
- a real Lark search/fetch returns a clickable source;
- the Vultr-hosted service remains connected, preserves Lark credentials, exposes no public health port, and passes the same checks after a forced container or host restart;
- no write-capable tool is present in the Agent tool registry.

Only then write `docs/superpowers/plans/2026-08-05-autonomous-knowledge-writes.md`.
