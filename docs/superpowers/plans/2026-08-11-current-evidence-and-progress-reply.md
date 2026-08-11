# Current Evidence and Delayed Progress Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent historical context from being presented as a live result and send one durable, ordinary progress reply when a supported member message is still processing after 20 seconds.

**Architecture:** Keep evidence correctness as one shared Agent-instruction boundary used by both message and Scheduled Runs. Add a small progress-reply controller beside `MessageWorker`; it starts from the event's durable `received_at`, claims an at-most-once progress attempt through two nullable PostgreSQL fields, sends concurrently with Agent work, and settles visible delivery before final reply delivery. A still-pending marker cannot send after settlement, and post-send message-ID confirmation does not block the final reply. Scheduled Runs and unsupported message types never instantiate this controller.

**Tech Stack:** TypeScript 7, Node.js 22+, Vercel AI SDK 7, Vitest 4, Drizzle ORM/Kit, PostgreSQL 17 Testcontainers, Feishu Node SDK.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-11-current-evidence-and-progress-reply-design.md`.
- Historical content may be cited but must not be presented as a live result from the current run.
- Current/latest state, permissions, versions, and read failures require current-run evidence or an explicit not-verified-live qualifier.
- Member-provided current facts may be used with attribution but are not independently confirmed until a tool verifies them.
- Cached or timestamped evidence must retain its own freshness qualifier.
- The evidence rule applies to message-triggered and Scheduled Runs; no intent classifier, forced tool route, response validator, or exact member-facing wording is added.
- Progress Reply applies only to supported member-triggered private and group events.
- Progress Reply delay is fixed at exactly `20_000` ms and is not configurable.
- Progress Reply text is exactly `我还在处理这条请求，完成后会继续回复。`.
- Progress Reply is an ordinary non-topic reply to the original trigger message.
- At most one progress attempt is made per event; no progress retry is allowed after an attempt marker exists.
- Progress delivery uses the existing Feishu 30-second request timeout; final delivery waits only for an already-started Feishu send, not a blocked marker or post-send confirmation write.
- The existing Processing Reaction remains attached until the existing terminal cleanup path.
- Persist only `progress_attempted_at` and `progress_message_id`; do not persist the fixed body, idempotency key, provider error, or failure category.
- Do not append Progress Reply to Retained Conversation History. Do not add filtering when it later appears in Live Group History.
- Progress transport is not a Persistent Agent Write and does not cross the Write Replay Boundary.
- Scheduled Task execution and delivery behavior remain unchanged.
- Use additive nullable migrations compatible with the currently supported rollback image.
- TDD each slice, run `git diff --check`, and commit after each independently green task.

---

### Task 1: Add the shared current-evidence instruction boundary

**Files:**
- Modify: `src/agent/instructions.ts`
- Create: `test/agent/current-evidence.test.ts`

**Interfaces:**
- Consumes: existing exported constant `TEAM_AGENT_INSTRUCTIONS: string`.
- Produces: the same `TEAM_AGENT_INSTRUCTIONS` export with one semantic evidence rule shared by every `ToolLoopAgent` run.
- Does not produce: a classifier, middleware validator, mandatory tool call, or exact response template.

- [ ] **Step 1: Write the failing instruction contract**

Create `test/agent/current-evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TEAM_AGENT_INSTRUCTIONS } from '../../src/agent/instructions.js';

describe('current evidence instructions', () => {
  it('keeps historical and member-provided facts from becoming unverified live claims', () => {
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'Do not present historical content as a live result from the current run.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'For claims about the current or latest state, permissions, versions, or read failures, use evidence actually obtained in this run or clearly say the claim was not verified live.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'Preserve cache, timestamp, and as-of qualifiers; never make evidence sound fresher than it is.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'You may use a member statement as input, but unless a tool verifies it, attribute it to the member rather than claiming independent confirmation.',
    );
  });

  it('does not turn the evidence rule into a routed conversation flow', () => {
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'Use tools when they help complete the member\'s request; there is no required workflow.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).not.toMatch(
      /intent classifier|always call a tool|mandatory search sequence|response validator/iu,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/agent/current-evidence.test.ts
```

Expected: the first test fails because the four evidence clauses are absent; the existing open-ended-flow assertion passes.

- [ ] **Step 3: Add the minimal shared instruction text**

In `src/agent/instructions.ts`, immediately after `Use tools when they help complete the member's request; there is no required workflow.`, add exactly:

```ts
Do not present historical content as a live result from the current run.
For claims about the current or latest state, permissions, versions, or read failures, use evidence actually obtained in this run or clearly say the claim was not verified live.
Preserve cache, timestamp, and as-of qualifiers; never make evidence sound fresher than it is.
You may use a member statement as input, but unless a tool verifies it, attribute it to the member rather than claiming independent confirmation.
```

Do not add runtime code to `run.ts`; `createTeamAgentWithBudget` already supplies the same instructions to message and Scheduled Runs.

- [ ] **Step 4: Run the Agent instruction and injection tests**

Run:

```bash
npx vitest run test/agent/current-evidence.test.ts test/agent/injection.test.ts test/agent/run.test.ts
```

Expected: all tests pass. Existing tool authority, group context, Scheduled Run, and prompt-injection boundaries remain green.

- [ ] **Step 5: Commit the evidence slice**

```bash
git add src/agent/instructions.ts test/agent/current-evidence.test.ts
git commit -m "feat: require current evidence for live claims"
```

---

### Task 2: Persist one claim-fenced progress attempt

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/event-store.ts`
- Modify: `test/storage/event-store.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Create: `drizzle/0011_progress_reply.sql`
- Create: `drizzle/meta/0011_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces `StoredEvent.receivedAt: Date`.
- Produces optional `StoredEvent.progressAttemptedAt?: Date` and `StoredEvent.progressMessageId?: string`.
- Produces `EventStore.markProgressAttempted(eventId: string, claimAttempt: number, attemptedAt: Date): Promise<boolean>`.
- Produces `EventStore.confirmProgressSent(eventId: string, claimAttempt: number, messageId: string): Promise<boolean>`.
- `false` from either method means the caller no longer owns the eligible state and must not retry or throw a business failure.

- [ ] **Step 1: Write the failing PostgreSQL contracts**

Add these cases to `test/storage/event-store.test.ts`:

```ts
it('marks one progress attempt before final reply start and confirms its message ID', async () => {
  await store.enqueue(event());
  const [claimed] = await store.claimReady(1, new Date(Date.now() + 60_000));
  const attemptedAt = new Date('2026-08-11T10:00:20.000Z');

  expect(claimed?.receivedAt).toBeInstanceOf(Date);
  expect(await store.markProgressAttempted('evt_1', 1, attemptedAt)).toBe(true);
  expect(await store.markProgressAttempted('evt_1', 1, attemptedAt)).toBe(false);
  expect(await store.confirmProgressSent('evt_1', 1, 'om_progress_1')).toBe(true);

  const row = await database.db.select({
    progressAttemptedAt: processedEvents.progressAttemptedAt,
    progressMessageId: processedEvents.progressMessageId,
  }).from(processedEvents).where(eq(processedEvents.eventId, 'evt_1'));
  expect(row).toEqual([{ progressAttemptedAt: attemptedAt, progressMessageId: 'om_progress_1' }]);
});

it('rejects progress after final reply start or stale lease recovery', async () => {
  await store.enqueue(event());
  await store.claimReady(1, new Date(Date.now() - 1));
  await store.recoverExpiredLeases(new Date(), 1);
  await store.claimReady(1, new Date(Date.now() + 60_000));

  expect(await store.markProgressAttempted('evt_1', 1, new Date())).toBe(false);
  await store.markReplyStarted('evt_1', 2, 'reply-key', new Date(), 'answer');
  expect(await store.markProgressAttempted('evt_1', 2, new Date())).toBe(false);
});

it('returns progress metadata after retry without retaining a progress body', async () => {
  const immediate = new PostgresEventStore(database.db, {
    minRetryDelayMs: 0, maxRetryDelayMs: 0,
  });
  await immediate.enqueue(event());
  await immediate.claimReady(1, new Date(Date.now() + 60_000));
  const attemptedAt = new Date('2026-08-11T10:00:20.000Z');
  await immediate.markProgressAttempted('evt_1', 1, attemptedAt);
  await immediate.confirmProgressSent('evt_1', 1, 'om_progress_1');
  await immediate.retry('evt_1', 1, 'agent_failed', new Date());

  const [recovered] = await immediate.claimReady(1, new Date(Date.now() + 60_000));
  expect(recovered).toMatchObject({
    progressAttemptedAt: attemptedAt,
    progressMessageId: 'om_progress_1',
  });
  expect(JSON.stringify(recovered)).not.toContain('我还在处理');
});
```

In `test/contract/team-agent.acceptance.test.ts`, extend the rollback-compatibility case with a previous-image-shaped event insert that omits both new columns:

```ts
const legacyEvent = await database.pool.query<{ attemptedAt: Date | null; messageId: string | null }>(`
  insert into processed_events (
    event_id, message_id, payload, conversation_key, status
  ) values (
    'evt_rollback_probe', 'om_rollback_probe',
    '{"eventId":"evt_rollback_probe","messageId":"om_rollback_probe","chatId":"oc_rollback_probe","conversationKey":"oc_rollback_probe","senderOpenId":"ou_probe","chatType":"p2p","content":{"kind":"text","text":"probe","feishuLinks":[]},"occurredAt":"2026-08-11T00:00:00.000Z"}'::jsonb,
    'oc_rollback_probe', 'queued'
  ) returning progress_attempted_at as "attemptedAt", progress_message_id as "messageId"
`);
expect(legacyEvent.rows).toEqual([{ attemptedAt: null, messageId: null }]);
```

- [ ] **Step 2: Run the storage test and confirm RED**

Run with a working local Docker runtime:

```bash
npx vitest run --config vitest.integration.config.ts test/storage/event-store.test.ts test/contract/team-agent.acceptance.test.ts
```

Expected: TypeScript/runtime failures report the missing schema fields and `EventStore` methods.

- [ ] **Step 3: Add the nullable schema fields and public store interface**

In `src/storage/schema.ts`, add immediately after `processingReactionId`:

```ts
progressAttemptedAt: timestamp('progress_attempted_at', { withTimezone: true }),
progressMessageId: text('progress_message_id'),
```

In `src/storage/event-store.ts`:

```ts
export type StoredEvent = {
  eventId: string;
  payload: NormalizedMessage;
  attempts: number;
  receivedAt: Date;
  processingReactionId?: string;
  progressAttemptedAt?: Date;
  progressMessageId?: string;
  // existing fields remain unchanged
};
```

Add to `EventStore`:

```ts
markProgressAttempted(
  eventId: string,
  claimAttempt: number,
  attemptedAt: Date,
): Promise<boolean>;
confirmProgressSent(
  eventId: string,
  claimAttempt: number,
  messageId: string,
): Promise<boolean>;
```

Extend `claimReady`'s `returning`, row type, and mapping with `received_at`, `progress_attempted_at`, and `progress_message_id`, converting timestamp values to `Date` exactly as the existing reply/write fields do.

- [ ] **Step 4: Implement the two conditional store mutations**

Import `isNotNull` and add to `PostgresEventStore`:

```ts
async markProgressAttempted(
  eventId: string,
  claimAttempt: number,
  attemptedAt: Date,
): Promise<boolean> {
  const updated = await this.db.update(processedEvents).set({
    progressAttemptedAt: attemptedAt,
    updatedAt: new Date(),
  }).where(and(
    eq(processedEvents.eventId, eventId),
    eq(processedEvents.status, 'processing'),
    eq(processedEvents.attempts, claimAttempt),
    isNull(processedEvents.replyAttemptedAt),
    isNull(processedEvents.progressAttemptedAt),
  )).returning({ eventId: processedEvents.eventId });
  return updated.length === 1;
}

async confirmProgressSent(
  eventId: string,
  claimAttempt: number,
  messageId: string,
): Promise<boolean> {
  const updated = await this.db.update(processedEvents).set({
    progressMessageId: messageId,
    updatedAt: new Date(),
  }).where(and(
    eq(processedEvents.eventId, eventId),
    eq(processedEvents.status, 'processing'),
    eq(processedEvents.attempts, claimAttempt),
    isNotNull(processedEvents.progressAttemptedAt),
    isNull(processedEvents.progressMessageId),
    isNull(processedEvents.replyAttemptedAt),
  )).returning({ eventId: processedEvents.eventId });
  return updated.length === 1;
}
```

Do not place progress state in `outcome`; that JSON is reserved for terminal/reply information and would make the transport state harder to query atomically.

- [ ] **Step 5: Generate and inspect the additive migration**

Run:

```bash
npx drizzle-kit generate --name progress_reply
```

Expected `drizzle/0011_progress_reply.sql`:

```sql
ALTER TABLE "processed_events" ADD COLUMN "progress_attempted_at" timestamp with time zone;
ALTER TABLE "processed_events" ADD COLUMN "progress_message_id" text;
```

Inspect the generated snapshot and journal. Confirm the migration contains no `DROP`, `RENAME`, `NOT NULL`, default body text, or changes to `allowed_chats`.

- [ ] **Step 6: Run the focused PostgreSQL and rollback contracts**

```bash
npx vitest run --config vitest.integration.config.ts test/storage/event-store.test.ts test/contract/team-agent.acceptance.test.ts
npm run typecheck
```

Expected: both suites and typecheck pass; the previous-image-shaped insert returns two null progress fields.

- [ ] **Step 7: Commit the persistence slice**

```bash
git add src/storage/schema.ts src/storage/event-store.ts \
  test/storage/event-store.test.ts test/contract/team-agent.acceptance.test.ts \
  drizzle/0011_progress_reply.sql drizzle/meta/0011_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: persist delayed progress reply state"
```

---

### Task 3: Send one delayed Progress Reply from MessageWorker

**Files:**
- Create: `src/worker/progress-reply.ts`
- Create: `test/worker/progress-reply.test.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/restart-recovery.test.ts`

**Interfaces:**
- Consumes the Task 2 `StoredEvent` progress/received fields and two `EventStore` methods.
- Produces `PROGRESS_REPLY_DELAY_MS = 20_000` and fixed `PROGRESS_REPLY_TEXT`.
- Produces `startProgressReply(event, dependencies): ProgressReplyHandle`.
- Produces `ProgressReplyHandle.settle(): Promise<void>`, which cancels an unstarted timer, prevents a pending marker from starting delivery, or waits for an already-started Feishu send. Post-send confirmation remains best-effort and non-blocking.
- Does not alter `FeishuMessenger`, `ScheduledTaskWorker`, `ConversationStore`, or final reply retry semantics.

- [ ] **Step 1: Write the focused controller tests**

Create `test/worker/progress-reply.test.ts` with this complete fixture and the following cases:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredEvent } from '../../src/storage/event-store.js';
import {
  PROGRESS_REPLY_TEXT,
  startProgressReply,
} from '../../src/worker/progress-reply.js';

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: 'evt_1', attempts: 1,
    receivedAt: new Date('2026-08-11T10:00:00.000Z'),
    payload: {
      eventId: 'evt_1', messageId: 'om_1', chatId: 'oc_1',
      conversationKey: 'oc_1', senderOpenId: 'ou_1', chatType: 'p2p',
      content: { kind: 'text', text: 'summarize the wiki', feishuLinks: [] },
      occurredAt: new Date('2026-08-11T10:00:00.000Z'),
    },
    ...overrides,
  };
}

function setup(overrides: Partial<StoredEvent> = {}) {
  const calls: string[] = [];
  const eventStore = {
    markProgressAttempted: vi.fn(async () => { calls.push('mark'); return true; }),
    confirmProgressSent: vi.fn(async () => { calls.push('confirm'); return true; }),
  };
  const messenger = {
    replyText: vi.fn(async () => { calls.push('send'); return 'om_progress_1'; }),
  };
  const logger = { warn: vi.fn() };
  return {
    event: event(overrides), calls, eventStore, messenger, logger,
    dependencies: {
      eventStore, messenger, logger,
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
  vi.setSystemTime(new Date('2026-08-11T10:00:00Z'));
  const state = setup();
  const handle = startProgressReply(state.event, state.dependencies);
  await vi.advanceTimersByTimeAsync(19_999);
  await handle.settle();
  expect(state.eventStore.markProgressAttempted).not.toHaveBeenCalled();
  expect(state.messenger.replyText).not.toHaveBeenCalled();
});

it('marks before sending exactly once at 20 seconds', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T10:00:00Z'));
  const state = setup();
  const handle = startProgressReply(state.event, state.dependencies);
  await vi.advanceTimersByTimeAsync(20_000);
  await handle.settle();
  expect(state.calls).toEqual(['mark', 'send', 'confirm']);
  expect(state.messenger.replyText).toHaveBeenCalledWith(
    'om_1', PROGRESS_REPLY_TEXT, expect.stringMatching(/^minori-progress-[a-f0-9]{32}$/u),
  );
});

it('starts immediately for a claim received more than 20 seconds ago', async () => {
  const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
  const handle = startProgressReply(state.event, {
    ...state.dependencies, now: () => new Date('2026-08-11T10:00:00.000Z'),
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
      ...state.dependencies, now: () => new Date('2026-08-11T10:00:00.000Z'),
    }).settle();
    expect(state.messenger.replyText).not.toHaveBeenCalled();
  }
});

it('logs one stable failure and never rejects the worker path', async () => {
  const state = setup({ receivedAt: new Date('2026-08-11T09:59:00.000Z') });
  state.messenger.replyText.mockRejectedValueOnce(new Error('provider secret'));
  await expect(startProgressReply(state.event, {
    ...state.dependencies, now: () => new Date('2026-08-11T10:00:00.000Z'),
  }).settle())
    .resolves.toBeUndefined();
  expect(state.logger.warn).toHaveBeenCalledWith(
    { eventId: 'evt_1', errorCode: 'progress_reply_failed' },
    'progress reply failed',
  );
  expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain('provider secret');
});
});
```

- [ ] **Step 2: Run the controller test and confirm RED**

```bash
npx vitest run test/worker/progress-reply.test.ts
```

Expected: module-not-found for `src/worker/progress-reply.ts`.

- [ ] **Step 3: Implement the small progress controller**

Create `src/worker/progress-reply.ts` with these public constants/types:

```ts
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
```

Use this deterministic key:

```ts
function progressReplyKey(eventId: string) {
  const digest = createHash('sha256')
    .update(`progress:v1:${eventId}`).digest('hex').slice(0, 32);
  return `minori-progress-${digest}`;
}
```

Implement `startProgressReply` as:

```ts
const NO_PROGRESS: ProgressReplyHandle = {
  async settle() {},
};

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
```

Do not pass the progress send through the Agent abort signal: once its durable marker exists, it receives the existing bounded Feishu send attempt even if the Agent finishes concurrently.

- [ ] **Step 4: Add failing MessageWorker ordering and recovery tests**

Update `FakeEventStore` in `test/worker/message-worker.test.ts` and the fake stores in `test/worker/restart-recovery.test.ts` with:

```ts
async markProgressAttempted() { this.calls.push('markProgress'); return true; }
async confirmProgressSent() { this.calls.push('confirmProgress'); return true; }
```

Add `receivedAt` to every constructed `StoredEvent`. Import `PROGRESS_REPLY_TEXT`, then add these concrete Worker cases to `test/worker/message-worker.test.ts`:

```ts
it('waits for an in-flight progress reply before final reply delivery', async () => {
  const setup = dependencies();
  setup.eventStore.terminalProcessingReactionId = 'reaction_1';
  let resolveProgress!: (messageId: string) => void;
  setup.messenger.replyText
    .mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveProgress = resolve;
    }))
    .mockResolvedValueOnce('om_reply_1');
  const worker = new MessageWorker(setup.options);

  const processing = worker.process({
    eventId: 'evt_1', payload: message(), attempts: 1,
    receivedAt: new Date('2026-08-05T00:59:00.000Z'),
    processingReactionId: 'reaction_1',
  });
  await vi.waitFor(() => expect(setup.messenger.replyText).toHaveBeenCalledOnce());
  expect(setup.messenger.replyText).toHaveBeenNthCalledWith(
    1, 'om_1', PROGRESS_REPLY_TEXT,
    expect.stringMatching(/^minori-progress-[a-f0-9]{32}$/u),
  );
  expect(setup.eventStore.marked).toBeUndefined();
  expect(setup.messenger.removeReaction).not.toHaveBeenCalled();

  resolveProgress('om_progress_1');
  await processing;
  expect(setup.messenger.replyText).toHaveBeenCalledTimes(2);
  expect(setup.messenger.replyText.mock.calls[1]?.[1]).toContain(
    '发布说明和设计稿都已核对。',
  );
  expect(setup.eventStore.calls.indexOf('confirmProgress'))
    .toBeLessThan(setup.eventStore.calls.indexOf('markReplyStarted'));
  expect(setup.messenger.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
});

it('continues to one final reply when progress delivery fails', async () => {
  const setup = dependencies();
  setup.messenger.replyText
    .mockRejectedValueOnce(new Error('provider secret'))
    .mockResolvedValueOnce('om_reply_1');

  await new MessageWorker(setup.options).process({
    eventId: 'evt_1', payload: message(), attempts: 1,
    receivedAt: new Date('2026-08-05T00:59:00.000Z'),
  });

  expect(setup.messenger.replyText).toHaveBeenCalledTimes(2);
  expect(setup.eventStore.completed).toEqual({ replyMessageId: 'om_reply_1' });
  expect(setup.options.logger.warn).toHaveBeenCalledWith(
    { eventId: 'evt_1', errorCode: 'progress_reply_failed' },
    'progress reply failed',
  );
  expect(JSON.stringify(setup.options.logger.warn.mock.calls)).not.toContain('provider secret');
});

it('does not append Progress Reply to Retained Conversation History', async () => {
  const setup = dependencies();
  await new MessageWorker(setup.options).process({
    eventId: 'evt_1', payload: message(), attempts: 1,
    receivedAt: new Date('2026-08-05T00:59:00.000Z'),
  });

  expect(setup.appended.map(({ messageId, role }) => ({ messageId, role }))).toEqual([
    { messageId: 'om_1', role: 'user' },
    { messageId: 'om_reply_1', role: 'assistant' },
  ]);
  expect(setup.appended.map(({ content }) => content)).not.toContain(PROGRESS_REPLY_TEXT);
});
```

Add this restart case to `test/worker/restart-recovery.test.ts` and make that file's `runAgent` return the shown completed reply:

```ts
it('does not repeat a Progress Reply after its durable attempt marker', async () => {
  const state = setup(new Date('2026-08-05T01:00:00.000Z'));
  state.runAgent.mockResolvedValueOnce({
    text: 'final answer', sources: [], usage: {},
    outcome: 'completed', writeAttempts: [],
  });
  const event = recovered({
    receivedAt: new Date('2026-08-05T00:00:00.000Z'),
    progressAttemptedAt: new Date('2026-08-05T00:00:20.000Z'),
    progressMessageId: undefined,
    replyIdempotencyKey: undefined,
    replyAttemptedAt: undefined,
    preparedReplyText: undefined,
  });

  await state.worker.process(event);

  expect(state.eventStore.markProgressAttempted).not.toHaveBeenCalled();
  expect(state.messenger.replyText).toHaveBeenCalledOnce();
  expect(state.messenger.replyText.mock.calls[0]?.[1]).toBe('final answer');
});
```

- [ ] **Step 5: Run the Worker tests and confirm RED**

```bash
npx vitest run test/worker/progress-reply.test.ts \
  test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
```

Expected: controller tests pass after Step 3; worker ordering/recovery tests fail because `MessageWorker` has not started or settled a Progress Reply.

- [ ] **Step 6: Wire the controller into MessageWorker**

In `src/worker/message-worker.ts`:

- import `startProgressReply` and `ProgressReplyHandle`;
- create one handle at the start of `process(event)`;
- pass it through `processWithinDeadline`, `prepareReply`, and `persistPreparedReply`;
- call `await progress.settle()` immediately before `markReplyStarted`; and
- call `await progress.settle()` again in `process`'s `finally` block so retry/error exits cancel an unstarted timer and drain an in-flight send.

The `process` entry becomes:

```ts
async process(event: StoredEvent): Promise<void> {
  const signal = AbortSignal.timeout(this.processingDeadlineMs);
  const state = { replyStarted: event.replyAttemptedAt !== undefined };
  const progress = startProgressReply(event, {
    eventStore: this.options.eventStore,
    messenger: this.options.messenger,
    logger: this.options.logger,
    now: this.now,
  });
  try {
    await this.processWithinDeadline(event, signal, state, progress);
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
  } finally {
    await progress.settle();
  }
}
```

Add `progress: ProgressReplyHandle` as the last argument of `processWithinDeadline`,
`prepareReply`, and `persistPreparedReply`, passing the same handle unchanged.

The key change inside `persistPreparedReply` is:

```ts
private async persistPreparedReply(
  event: StoredEvent,
  text: string,
  signal: AbortSignal,
  state: { replyStarted: boolean },
  progress: ProgressReplyHandle,
) {
  await progress.settle();
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
```

For a recovered `replyAttemptedAt`, `startProgressReply` returns a no-op handle, so the existing final-reply replay path remains unchanged. Do not call the controller from `src/schedule/worker.ts`.

- [ ] **Step 7: Run all focused progress and Worker tests**

```bash
npx vitest run test/worker/progress-reply.test.ts \
  test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
npm run typecheck
```

Expected: all pass. Verify call order is progress marker -> progress send -> progress confirm -> final marker -> final send -> conversation append -> complete -> reaction remove.

- [ ] **Step 8: Commit the Worker slice**

```bash
git add src/worker/progress-reply.ts src/worker/message-worker.ts \
  test/worker/progress-reply.test.ts test/worker/message-worker.test.ts \
  test/worker/restart-recovery.test.ts
git commit -m "feat: send one delayed progress reply"
```

---

### Task 4: Align active guidance and run the full release gate

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-07-team-agent-design.md`
- Modify: `test/scripts/release-contract.test.ts`
- Verify only: `docs/superpowers/specs/2026-08-11-current-evidence-and-progress-reply-design.md`
- Verify only: `CONTEXT.md`

**Interfaces:**
- Produces active operator/product guidance for the evidence rule and Progress Reply.
- Produces a release contract that prevents an accidental environment knob, Scheduled Run progress, periodic updates, or Retained Conversation History persistence.
- Does not create a tag, publish an image, grant Production Approval, or mutate Vultr.

- [ ] **Step 1: Write the failing active-guidance contract**

Add to `test/scripts/release-contract.test.ts`:

```ts
it('documents one fixed delayed Progress Reply without changing Scheduled Runs', async () => {
  const readme = await text('README.md');
  const activeDesign = await text('docs/superpowers/specs/2026-08-07-team-agent-design.md');
  const localEnvironment = await text('.env.example');
  const productionEnvironment = await text('deploy/vultr/env.example');

  for (const guidance of [readme, activeDesign]) {
    expect(guidance).toContain('Progress Reply');
    expect(guidance).toContain('20 seconds');
    expect(guidance).toContain('我还在处理这条请求，完成后会继续回复。');
    expect(guidance).toContain('not appended to Retained Conversation History');
    expect(guidance).toContain('Scheduled Runs do not send Progress Replies');
  }
  for (const environment of [localEnvironment, productionEnvironment]) {
    expect(environment).not.toContain('PROGRESS_REPLY');
  }
});

it('documents historical evidence without introducing a mandatory tool workflow', async () => {
  const readme = await text('README.md');
  const activeDesign = await text('docs/superpowers/specs/2026-08-07-team-agent-design.md');
  for (const guidance of [readme, activeDesign]) {
    expect(guidance).toContain('Historical content may be cited');
    expect(guidance).toContain('not been verified live');
    expect(guidance).toContain('no intent classifier');
  }
});
```

- [ ] **Step 2: Run the release contract and confirm RED**

```bash
npx vitest run test/scripts/release-contract.test.ts
```

Expected: the two new cases fail because active guidance does not yet describe this feature.

- [ ] **Step 3: Update active guidance without duplicating implementation detail**

In the README conversation behavior section and the active team-agent design:

- describe historical evidence in the same semantic wording as the approved design;
- state that supported member events still running after 20 seconds receive exactly one fixed Progress Reply;
- state the exact copy;
- state that Processing Reaction remains until terminal cleanup;
- state that Progress Reply is not appended to Retained Conversation History;
- state that Feishu may return it later as powerless Live Group History; and
- state that Scheduled Runs do not send Progress Replies.

Do not document database column names, timers, environment variables, or internal error categories in README.

- [ ] **Step 4: Run all focused contracts**

```bash
npx vitest run test/agent/current-evidence.test.ts \
  test/worker/progress-reply.test.ts test/worker/message-worker.test.ts \
  test/worker/restart-recovery.test.ts test/scripts/release-contract.test.ts
npx vitest run --config vitest.integration.config.ts \
  test/storage/event-store.test.ts test/contract/team-agent.acceptance.test.ts
```

Expected: all focused unit, release, PostgreSQL, and rollback contracts pass.

- [ ] **Step 5: Run complete local verification**

```bash
npm run verify
npm run test:integration
git diff --check
```

Expected: TypeScript app/scripts checks, all unit tests, build, all PostgreSQL/contract integration tests, and diff hygiene pass. If Testcontainers cannot access Docker, restore the local runtime and rerun; do not report skipped database tests as passed.

- [ ] **Step 6: Perform the implementation self-review**

Check the final diff against every Global Constraint and explicitly verify:

```bash
rg -n "PROGRESS_REPLY|progress.*body|progress.*error|setInterval" \
  .env.example deploy/vultr/env.example src test drizzle README.md
```

Expected findings:

- no progress environment variable;
- no persisted progress body/error field;
- no periodic progress interval;
- no changes under `src/schedule/worker.ts`;
- exactly two nullable progress columns;
- one fixed copy and one deterministic progress-key namespace;
- final reply key/retry behavior unchanged.

- [ ] **Step 7: Commit the guidance and release gate**

```bash
git add README.md docs/superpowers/specs/2026-08-07-team-agent-design.md \
  test/scripts/release-contract.test.ts
git commit -m "docs: publish current evidence and progress reply behavior"
```

## Release handoff after implementation

Implementation completion stops with a clean, fully verified commit. Creating a protected release tag and granting GitHub Production Approval remain separate explicit operator actions.

After an authorized release, sanitized live acceptance consists of:

1. one supported request completing before 20 seconds, with no Progress Reply;
2. one supported request deliberately lasting beyond 20 seconds, with one Progress Reply followed by one final reply;
3. Processing Reaction removed only at terminal completion;
4. no progress/reaction failure category in sanitized logs; and
5. exact deployed digest/revision, healthy status, zero restart, and readiness 200.

Acceptance evidence must not contain message bodies, prompts, member names, Open IDs, provider output, OAuth data, environment values, credentials, or document contents. Do not tag, deploy, or run live acceptance without the corresponding user authorization.
