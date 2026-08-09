# Open Team Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the already-authenticated Minori candidate as an open Feishu Team Agent whose admission follows Feishu delivery, whose queued messages receive immediate lightweight acknowledgement, and whose execution limits and write failures never cause blind whole-run replay.

**Architecture:** Keep the existing Feishu long connection, Vercel AI SDK `ToolLoopAgent`, typed Lark CLI knowledge adapter, Neon-backed conversation queue, and one-container Vultr release. Remove the duplicate membership/allowed-chat layer, move Processing Reaction ownership to durable event acceptance, and make Agent-run outcomes explicit. A durable Write Replay Boundary prevents lease recovery or transient errors from repeating a run after a Typed Knowledge Write starts, while recovery decisions inside a later Continuation Run remain Agent-managed.

**Tech Stack:** Node.js 22, TypeScript 7, Vercel AI SDK 7, `@ai-sdk/openai` Responses API, `@larksuiteoapi/node-sdk`, Lark CLI 1.0.84, PostgreSQL 17/Neon, Drizzle ORM, Vitest, Testcontainers, Docker Compose, Ubuntu 24.04 LTS x86_64.

## Global Constraints

- Feishu message delivery is the sole admission boundary. Do not add `ALLOWED_CHAT_IDS`, a user allowlist, group-membership lookup, or internal-versus-external check.
- A Feishu Delivered Member may be an external collaborator and receives the Dedicated Knowledge User's Knowledge Boundary rather than requester-scoped document permissions.
- Conversation and recovery remain Agent-managed. Do not add an intent router, scenario state machine, fixed reconciliation sequence, or mandatory confirmation step.
- The Initial Typed Write Set remains exactly `createDocument`, `appendDocument`, and `patchDocument`. Do not add rename, move, trash, complete-content update, permission, sharing, raw API, shell, arbitrary HTTP, or filesystem tools in this plan.
- Default Agent limits remain 20 model/tool steps and 180,000 ms; configuration bounds remain 1–100 steps and 10,000–900,000 ms.
- Step-limit and timeout exhaustion are explicit Execution Budget Exhaustion outcomes: they are terminal for that Agent run, preserve prior writes, do not automatically rerun, and invite an explicit Continuation Run.
- Before the first Typed Knowledge Write, a transient model or read-only-tool failure may retry the whole Agent run. After the Write Replay Boundary, the whole run must never replay automatically, including after process or lease recovery.
- Feishu reply transport retries remain idempotent through the existing stable key and one-hour deduplication window.
- Accepted events enter the Durable Conversation Queue in PostgreSQL, are serialized per conversation, and execute with global concurrency 4 by default; do not add per-user or per-group quotas.
- Add `Typing` only after durable acceptance. Keep it through queueing and retry, then remove it after reply or terminal failure.
- Keep `store: false` on every model request. The configured endpoint remains the trusted Model Data Boundary; do not add redaction, keyword blocking, or a classification gateway.
- Neon remains the trusted Persistence Data Boundary. Conversation bodies remain searchable for 30 days; do not persist complete retrieved documents, raw tool output, hidden reasoning, credentials, or prompt/model bodies in audit metadata.
- Preserve the verified Lark runtime contract: one existing Feishu App, `strict-mode=user`, `HOME=/var/lib/minori/lark/home`, TLS verification, UID/GID `10001:10001`, and the existing protected Lark volume.
- Preserve the release ordering contract: Build the exact commit, bootstrap OAuth, and only then deploy. OAuth is already healthy for this release, so Task 5 verifies the persisted identity instead of repeating device authorization.
- Keep every candidate migration backward compatible with the supported previous image because deployment migrates before replacement and rollback does not downgrade the database. Destructive contract cleanup waits until the rollback floor has advanced.
- Local Compose contract checks use `MINORI_ENV_FILE=./env.example`; production always uses `/opt/minori/minori.env`.
- Never print or commit API keys, App Secret, OAuth URLs, device codes, tokens, database URLs, environment values, or credential-file contents.
- Every implementation slice uses red-green TDD, runs its focused tests, runs `npm run verify`, and commits before the next slice begins.

---

## File structure

**Admission and configuration**

- Delete `src/feishu/membership.ts` and `src/storage/allowed-chat-store.ts`. Feishu delivery plus existing mention/thread normalization becomes the complete admission interface.
- Simplify `src/feishu/gateway.ts` so it persists every normalized trigger event and owns immediate Processing Reaction creation.
- Simplify `src/feishu/client.ts` to messaging, message-context lookup, and reactions; remove chat-member enumeration.
- Simplify `src/runtime/config.ts`, `src/storage/runtime.ts`, and `src/app.ts` so no allowed-chat configuration or store is constructed.

**Durable lifecycle**

- Extend `src/storage/event-store.ts` to attach a reaction to any live queued/processing event and to return the persisted reaction when a terminal transition wins the row lock.
- Create `src/agent/run-outcome.ts` as the single home for Agent completion kinds, write-attempt receipts, and deterministic interruption/exhaustion copy.
- Extend `src/storage/agent-run-store.ts` to durably mark the Write Replay Boundary, persist result identifiers, and load sanitized write attempts after a crash.
- Extend `src/agent/run.ts` to classify natural completion, step exhaustion, timeout exhaustion, and interruption after a write without encoding recovery strategy.
- Simplify `src/worker/message-worker.ts` so it never rechecks membership, retains `Typing` across queue retries, and never invokes the Agent for a recovered event that already crossed the Write Replay Boundary.

**Schema and release**

- `drizzle/0002_open_admission.sql` records the open-admission release without dropping the obsolete `allowed_chats` table. The new runtime never reads it; the physical table remains inert until the supported rollback floor advances beyond the fixed-point image.
- `drizzle/0003_write_replay_boundary.sql` adds `processed_events.write_started_at` and `tool_runs.result_identifiers`.
- Unit and integration tests prove open admission, reaction timing, explicit budget outcomes, safe pre-write retry, blocked post-write replay, and restart recovery.
- README, environment examples, canonical design, and release acceptance describe one open-admission runtime and one exact-commit Vultr deployment.

---

### Task 1: Remove the duplicate membership and allowed-chat boundary

**Files:**
- Delete: `src/feishu/membership.ts`
- Delete: `src/storage/allowed-chat-store.ts`
- Delete: `test/feishu/membership.test.ts`
- Delete: `test/storage/allowed-chat-store.test.ts`
- Modify: `src/runtime/config.ts`
- Modify: `src/feishu/client.ts`
- Modify: `src/feishu/gateway.ts`
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/runtime.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `src/app.ts`
- Create: `drizzle/0002_open_admission.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0002_snapshot.json`
- Modify: `test/runtime/config.test.ts`
- Modify: `test/feishu/client.test.ts`
- Modify: `test/feishu/gateway.test.ts`
- Modify: `test/storage/storage-runtime.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/restart-recovery.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Modify: `.env.example`
- Modify: `deploy/vultr/env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `FeishuGatewayDependencies` with no `membership` dependency.
- Produces: `MessageWorkerOptions` with no `membership` dependency.
- Produces: `StorageRuntime` with `eventStore`, `conversationStore`, and `agentRunStore` only.
- Consumes: existing trigger normalization: every private message, direct mention, reply to Minori, and continuation inside a known Agent Thread.

- [ ] **Step 1: Write failing open-admission tests**

Replace the gateway private-message authorization test with:

```ts
it('accepts every delivered private message without a membership lookup', async () => {
  const { gateway: instance, enqueue } = gateway();

  await instance.handle(rawMessage({ messageId: 'om_dm_external', chatType: 'p2p' }));

  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
    messageId: 'om_dm_external',
    conversationKey: 'oc_dm',
    senderOpenId: 'ou_member',
  }));
});
```

Add a group assertion using a raw event whose sender is `ou_external` and whose message directly mentions Minori. Assert that it is enqueued. Keep the existing assertions that unrelated group-timeline noise, bot messages, and malformed events are ignored.

In `test/runtime/config.test.ts` replace the allowed-chat assertions with:

```ts
const config = loadConfig({
  NODE_ENV: 'test',
  ALLOWED_CHAT_IDS: 'obsolete-value-must-be-ignored',
});
expect(config).not.toHaveProperty('allowedChatIds');
```

In worker tests, remove every `membership` fixture and add one test proving a claimed private event reaches `runAgent` without any authorization dependency.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm test -- test/runtime/config.test.ts test/feishu/gateway.test.ts test/worker/message-worker.test.ts test/storage/storage-runtime.test.ts
```

Expected: FAIL because config still exposes `allowedChatIds` and both gateway and worker still require `membership`.

- [ ] **Step 3: Remove membership from the runtime call graph**

Make `FeishuGatewayDependencies` contain:

```ts
export type FeishuGatewayDependencies = {
  botOpenId: string;
  botAppId: string;
  eventStore: GatewayEventStore;
  messageContext: MessageContextSource;
  threads: AgentThreadSource;
  signalWorker(): void | Promise<void>;
  logger: Logger;
};
```

After normalization succeeds, enqueue directly:

```ts
if (!normalized) return;
const status = await this.dependencies.eventStore.enqueue(normalized);
if (status === 'duplicate') return;
```

Remove `membership` from `MessageWorkerOptions` and delete the complete authorization block before conversation persistence. Remove `MembershipPolicy` construction from `src/app.ts`.

In `src/feishu/client.ts` remove `ChatMemberSource`, `chatMembers.get` from `FeishuSdk`, `implements ChatMemberSource`, and `listOpenIds`. Keep `replyText`, `isBotMessage`, `addReaction`, and `removeReaction` unchanged.

- [ ] **Step 4: Remove allowed-chat configuration and storage**

Delete `ALLOWED_CHAT_IDS` from the Zod schema and delete `allowedChatIds` from `loadConfig`. Remove `PostgresAllowedChatStore` and `allowedChatStore` from `StorageRuntime` and `createStorageRuntime`.

Rename the `allowedChats` schema export to an explicitly deprecated rollback-compatibility export, but retain the physical `allowed_chats` table. No current runtime module may import or use it. It exists only because deployment applies migrations before candidate replacement and the supported fixed-point image still writes this table during initialization.

Keep the journal tag `0002_open_admission` and make the migration an intentional no-op with a comment explaining the deferred contract cleanup. The `0002` snapshot must continue to include `public.allowed_chats`. Do not edit prior migrations.

Add an integration regression that applies all candidate migrations, then proves the fixed-point store's startup contract can still update and upsert `allowed_chats`. This protects both the still-running previous image during migration and automatic rollback after candidate readiness failure.

The destructive cleanup is deferred until the supported rollback floor advances beyond `4f936ab`; only that later contract migration may drop the table.

Use Drizzle generation/checking to verify schema metadata remains consistent:

```bash
npm exec drizzle-kit generate -- --name verify_open_admission_compatibility
```

Expected: no schema changes. The journal entry remains tagged `0002_open_admission`.

- [ ] **Step 5: Update integration fixtures and operator documentation**

Remove `PostgresAllowedChatStore`, `MembershipPolicy`, `allowedChats.configure`, `allowed_chats` truncation, and “eligible/disallowed/outsider” expectations from `test/contract/team-agent.acceptance.test.ts`. The external private event and a directly mentioned external group event must both receive replies.

Remove `ALLOWED_CHAT_IDS` from `.env.example` and `deploy/vultr/env.example`. In README:

- describe Feishu App availability and delivered events as the sole admission boundary;
- state that external collaborators may invoke Minori;
- state explicitly that every delivered member receives the Dedicated Knowledge User's Knowledge Boundary, not requester-scoped permissions;
- remove allowed-chat setup and Eligible Member language.

- [ ] **Step 6: Run the complete admission slice**

Run:

```bash
npm test -- test/runtime/config.test.ts test/feishu/client.test.ts test/feishu/gateway.test.ts test/storage/storage-runtime.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
npm run test:integration
npm run verify
```

Expected: all commands PASS; `rg "ALLOWED_CHAT_IDS|MembershipPolicy|AllowedChatStore|Eligible Member" src test README.md .env.example deploy/vultr/env.example` returns no matches.

- [ ] **Step 7: Commit the open-admission slice**

```bash
git add src test drizzle .env.example deploy/vultr/env.example README.md
git commit -m "feat: use Feishu delivery for team agent admission"
```

---

### Task 2: Acknowledge durable queue acceptance with Typing

**Files:**
- Modify: `src/feishu/gateway.ts`
- Modify: `src/storage/event-store.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `src/app.ts`
- Modify: `test/feishu/gateway.test.ts`
- Modify: `test/storage/event-store.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/restart-recovery.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Produces: `GatewayEventStore.attachProcessingReaction(eventId, reactionId): Promise<boolean>`.
- Produces: terminal event-store methods that return `{ processingReactionId?: string }` after winning the active-claim row lock.
- Consumes: `FeishuMessenger.addReaction` and `removeReaction`.
- Preserves: retry transitions retain the persisted reaction; terminal transitions clear and return it.

- [ ] **Step 1: Write failing reaction-timing and queue tests**

In `test/feishu/gateway.test.ts` provide a reaction adapter and assert this order for a new event:

```ts
expect(calls).toEqual([
  'enqueue',
  'addReaction:om_1',
  'attachReaction:evt_om_1:reaction_1',
  'signalWorker',
]);
```

Add assertions that duplicate delivery creates no second reaction, reaction API failure still signals work, and an attach that loses to terminal completion removes the just-created reaction.

In `test/storage/event-store.test.ts` prove:

```ts
expect(await store.attachProcessingReaction('evt_1', 'reaction_1')).toBe(true);
const terminal = await store.complete('evt_1', 1, { replyMessageId: 'om_reply' });
expect(terminal).toEqual({ processingReactionId: 'reaction_1' });
expect(await store.attachProcessingReaction('evt_1', 'late_reaction')).toBe(false);
```

Add a worker test where an Agent failure causes `retry` and does not call `removeReaction`, followed by a recovered successful attempt that removes the same persisted reaction exactly once.

- [ ] **Step 2: Run focused tests and verify the ownership mismatch is red**

Run:

```bash
npm test -- test/feishu/gateway.test.ts test/storage/event-store.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
```

Expected: FAIL because the worker still creates/removes `Typing` per attempt and the gateway cannot attach a durable reaction.

- [ ] **Step 3: Add race-safe reaction attachment and terminal return**

Replace claim-bound `saveProcessingReaction` / `clearProcessingReaction` with:

```ts
attachProcessingReaction(eventId: string, reactionId: string): Promise<boolean>;
```

Its update may succeed only while status is `queued` or `processing` and `processingReactionId` is null. Return `false` after a terminal transition.

Change `complete` and `markReplyUncertain` to run in a transaction:

```ts
const [current] = await tx.select({
  processingReactionId: processedEvents.processingReactionId,
}).from(processedEvents).where(and(
  eq(processedEvents.eventId, eventId),
  eq(processedEvents.status, 'processing'),
  eq(processedEvents.attempts, claimAttempt),
)).for('update');
if (!current) throw new StaleEventClaimError();

await tx.update(processedEvents).set({
  status: terminalStatus,
  processingReactionId: null,
  // existing outcome and reply fields
}).where(eq(processedEvents.eventId, eventId));

return current.processingReactionId
  ? { processingReactionId: current.processingReactionId }
  : {};
```

Keep `retry` from clearing `processingReactionId`.

- [ ] **Step 4: Move reaction creation into durable gateway acceptance**

Add `reactions: Pick<FeishuMessenger, 'addReaction' | 'removeReaction'>` to gateway dependencies. After a non-duplicate enqueue:

```ts
const reactionId = await this.dependencies.reactions.addReaction(
  normalized.messageId,
  'Typing',
);
if (reactionId) {
  let attached = false;
  try {
    attached = await this.dependencies.eventStore.attachProcessingReaction(
      normalized.eventId,
      reactionId,
    );
  } catch {
    this.dependencies.logger.warn(
      { errorCode: 'reaction_state_attach_failed' },
      'reaction state attach failed',
    );
  }
  if (!attached) {
    await this.dependencies.reactions.removeReaction(normalized.messageId, reactionId);
  }
}
```

Signal the worker even when reaction creation or attachment fails. In `src/app.ts` pass the existing Feishu client as `reactions`.

- [ ] **Step 5: Make terminal cleanup own reaction removal**

Delete worker-side `addReaction` and do not remove a persisted reaction at the start of a recovered attempt. After `complete` or `markReplyUncertain` returns, remove the returned reaction best-effort. On `retry`, leave it attached.

Use one helper:

```ts
private async removeTerminalReaction(
  event: StoredEvent,
  terminal: { processingReactionId?: string },
) {
  if (!terminal.processingReactionId) return;
  await this.options.messenger.removeReaction(
    event.payload.messageId,
    terminal.processingReactionId,
  );
}
```

The helper must log only stable reaction error categories and must not change a terminal event back to queued.

- [ ] **Step 6: Run reaction lifecycle verification**

Run:

```bash
npm test -- test/feishu/gateway.test.ts test/storage/event-store.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
npm run test:integration
npm run verify
```

Expected: all PASS; integration proves `Typing` exists after durable enqueue, survives a queued retry/restart, and is absent after the final reply.

- [ ] **Step 7: Commit the durable acknowledgement slice**

```bash
git add src test
git commit -m "feat: acknowledge queued Feishu messages"
```

---

### Task 3: Represent execution budget exhaustion explicitly

**Files:**
- Create: `src/agent/run-outcome.ts`
- Modify: `src/agent/run.ts`
- Modify: `src/agent/instructions.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `src/worker/source-format.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/storage/agent-run-store.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/source-format.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Produces: `AgentReply.outcome` with `completed | step_limit_reached | timeout_reached | interrupted_after_write`.
- Produces: `AgentReply.writeAttempts` as sanitized durable facts for visible continuation context.
- Produces: `AgentRunOutcome` audit values including `step_limit_reached` and `timeout_reached`.
- Consumes: the configured step and timeout limits without adding an intent workflow.

- [ ] **Step 1: Write failing step and timeout behavior tests**

Replace the current max-step test with assertions that a one-step tool-call run:

```ts
const reply = await runKnowledgeAgent(input, dependencies(input.prompt, model, {
  maxSteps: 1,
}));
expect(model.doGenerateCalls).toHaveLength(1);
expect(reply).toMatchObject({
  outcome: 'step_limit_reached',
  writeAttempts: [],
});
expect(reply.text).toContain('执行步数上限');
expect(reply.text).toContain('继续');
expect(audit.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
  outcome: 'step_limit_reached',
}));
```

Replace the timeout rejection test with:

```ts
await expect(runKnowledgeAgent(input, dependencies(input.prompt, model, {
  timeoutMs: 5,
  agentRunStore: audit,
}))).resolves.toMatchObject({
  outcome: 'timeout_reached',
  writeAttempts: [],
});
expect(audit.finish).toHaveBeenCalledWith('run_1', expect.objectContaining({
  outcome: 'timeout_reached',
}));
```

Add a worker test proving both outcomes are sent once and never passed to `eventStore.retry`.

- [ ] **Step 2: Run the focused budget tests and verify red**

Run:

```bash
npm test -- test/agent/run.test.ts test/storage/agent-run-store.test.ts test/worker/message-worker.test.ts test/worker/source-format.test.ts
```

Expected: FAIL because step exhaustion is currently marked `completed` and timeout currently rejects as `aborted`.

- [ ] **Step 3: Create the explicit run-outcome model**

Create `src/agent/run-outcome.ts` with:

```ts
export type AgentReplyOutcome =
  | 'completed'
  | 'step_limit_reached'
  | 'timeout_reached'
  | 'interrupted_after_write';

export type AgentRunOutcome =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'step_limit_reached'
  | 'timeout_reached'
  | 'interrupted_after_write';

export type WriteAttemptReceipt = {
  toolName: 'createDocument' | 'appendDocument' | 'patchDocument';
  outcome: 'succeeded' | 'failed' | 'unknown';
  sanitizedSummary: string;
  targetIdentifiers: Record<string, string>;
  resultIdentifiers?: {
    token: string;
    title: string;
    url: string;
    revisionId: string;
  };
  errorCategory?: string;
};

export function budgetExhaustedText(
  reason: 'step_limit_reached' | 'timeout_reached',
  writeAttempts: WriteAttemptReceipt[],
): string;

export function interruptedAfterWriteText(
  writeAttempts: WriteAttemptReceipt[],
): string;
```

Update `AgentReply` in `src/agent/run.ts` to the exact public result shape:

```ts
export type AgentReply = {
  text: string;
  sources: AgentSource[];
  usage: { inputTokens?: number; outputTokens?: number };
  outcome: AgentReplyOutcome;
  writeAttempts: WriteAttemptReceipt[];
};
```

The copy must name the reached limit, state that no automatic replay occurred, list only sanitized confirmed/failed/unknown write facts and URLs, and invite the member to reply “继续”. Do not serialize prompts, document content, hidden reasoning, or provider errors.

Make `AgentReply` require `outcome` and `writeAttempts` in addition to existing `text`, `sources`, and `usage`. Update existing test fakes to return `outcome: 'completed', writeAttempts: []`.

- [ ] **Step 4: Detect the step stop condition without misclassifying natural completion**

Replace `stepCountIs` with a stateful controller:

```ts
function createStepBudget(maxSteps: number) {
  let exhausted = false;
  return {
    stopWhen: ({ steps }: { steps: Array<unknown> }) => {
      exhausted = steps.length === maxSteps;
      return exhausted;
    },
    exhausted: () => exhausted,
  };
}
```

Pass `budget.stopWhen` to `ToolLoopAgent`. Vercel AI SDK evaluates this condition only when the tool loop would otherwise continue, so a natural text completion on step 20 remains `completed` while a tool-calling step 20 becomes `step_limit_reached`.

- [ ] **Step 5: Distinguish the Agent timeout from external cancellation**

Keep a separate timeout signal:

```ts
const timeoutSignal = AbortSignal.timeout(dependencies.timeoutMs);
const runSignal = signal
  ? AbortSignal.any([signal, timeoutSignal])
  : timeoutSignal;
```

After generation, return a budget-exhausted reply when `stepBudget.exhausted()`. In the catch block, return a timeout-exhausted reply only when `timeoutSignal.aborted`. External cancellation and non-budget failures still throw.

Finalize `agent_runs.outcome` as `step_limit_reached` or `timeout_reached` instead of `completed` / `aborted`. Preserve the independently bounded audit-finalization behavior.

- [ ] **Step 6: Make visible continuation context sufficient**

Add to `TEAM_AGENT_INSTRUCTIONS`:

```text
A prior budget or interruption receipt is visible conversation context, not restored hidden state.
When a member asks to continue, inspect current knowledge as useful and choose the next action yourself.
```

Do not add a “continue” parser. The normal open Agent interprets natural-language continuation from retained conversation history.

- [ ] **Step 7: Run the budget slice**

Run:

```bash
npm test -- test/agent/run.test.ts test/storage/agent-run-store.test.ts test/worker/message-worker.test.ts test/worker/source-format.test.ts
npm run test:integration
npm run verify
```

Expected: all PASS; step and timeout outcomes send truthful replies, retain prior writes, perform no post-deadline write, and never schedule a whole-run retry.

- [ ] **Step 8: Commit explicit budget outcomes**

```bash
git add src test
git commit -m "feat: report agent execution budget exhaustion"
```

---

### Task 4: Enforce the durable Write Replay Boundary

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `src/storage/event-store.ts`
- Modify: `src/agent/run-outcome.ts`
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/run.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `src/app.ts`
- Create: `drizzle/0003_write_replay_boundary.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0003_snapshot.json`
- Modify: `test/storage/agent-run-store.test.ts`
- Modify: `test/storage/event-store.test.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/restart-recovery.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Produces: `processed_events.write_started_at` as the durable no-replay marker.
- Produces: `tool_runs.result_identifiers` for sanitized token/title/URL/revision receipts.
- Produces: `AgentRunStore.listWriteAttempts(eventId): Promise<WriteAttemptReceipt[]>`.
- Produces: `StoredEvent.writeStartedAt?: Date`.
- Consumes: normal Agent tools for Agent-managed Recovery; runtime does not decide how a later Continuation Run reconciles.

- [ ] **Step 1: Write failing durable-boundary tests**

In `test/storage/agent-run-store.test.ts`, after `beginWrite` assert:

```ts
const [eventRow] = await database.db.select().from(processedEvents)
  .where(eq(processedEvents.eventId, 'evt_1'));
expect(eventRow?.writeStartedAt).toBeInstanceOf(Date);
```

Finish a successful write with result identifiers and assert `listWriteAttempts('evt_1')` returns one `succeeded` receipt. Leave another tool row unfinished and assert it returns `unknown` without document body content.

In restart recovery, construct `StoredEvent.writeStartedAt` and assert:

```ts
expect(runAgent).not.toHaveBeenCalled();
expect(eventStore.retry).not.toHaveBeenCalled();
expect(messenger.replyText).toHaveBeenCalledWith(
  'om_1',
  expect.stringContaining('写入开始后中断'),
  expect.stringMatching(/^minori-/u),
);
```

Add two Agent tests:

1. a model failure before any write still rejects and is retryable by the worker;
2. a model failure after a successful create resolves with `outcome: 'interrupted_after_write'`, includes the created URL, and never retries the complete run.

- [ ] **Step 2: Run boundary tests and verify red**

Run:

```bash
npm test -- test/storage/agent-run-store.test.ts test/storage/event-store.test.ts test/agent/run.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
```

Expected: FAIL because no durable write marker/result identifiers exist and lease recovery currently re-invokes the Agent.

- [ ] **Step 3: Add the replay-boundary schema**

Add to `processedEvents`:

```ts
writeStartedAt: timestamp('write_started_at', { withTimezone: true }),
```

Add to `toolRuns`:

```ts
resultIdentifiers: jsonb('result_identifiers').$type<{
  token: string;
  title: string;
  url: string;
  revisionId: string;
}>(),
```

Run:

```bash
npm exec drizzle-kit generate -- --name write_replay_boundary
```

Verify `drizzle/0003_write_replay_boundary.sql` contains:

```sql
ALTER TABLE "processed_events" ADD COLUMN "write_started_at" timestamp with time zone;
ALTER TABLE "tool_runs" ADD COLUMN "result_identifiers" jsonb;
```

- [ ] **Step 4: Mark the boundary atomically with the pending audit**

Change `AgentRunStore.finishWrite` to accept:

```ts
{
  outcome: 'succeeded' | 'failed' | 'unknown';
  errorCategory?: string;
  resultIdentifiers?: {
    token: string;
    title: string;
    url: string;
    revisionId: string;
  };
}
```

Implement `beginWrite` in a database transaction. Insert the pending `tool_runs` row, then update the associated `processed_events` row through the current `agent_runs.event_id`:

```sql
update processed_events event
set write_started_at = coalesce(event.write_started_at, now()),
    updated_at = now()
from agent_runs run
where run.id = $1
  and event.event_id = run.event_id
  and event.status = 'processing'
```

If either the pending tool row or event marker cannot be persisted, roll back and do not invoke Lark. Map `succeeded` to `success=true`, `failed` to `success=false`, and `unknown` to `success=null` plus a stable error category.

- [ ] **Step 5: Persist and load sanitized receipts**

Narrow `KnowledgeWriteAudit.run` to return `KnowledgeWriteResult`:

```ts
export interface KnowledgeWriteAudit {
  run(
    input: KnowledgeWriteAuditInput,
    operation: () => Promise<KnowledgeWriteResult>,
  ): Promise<KnowledgeWriteResult>;
}
```

On success, persist token, title, URL, and stringified revision ID as `resultIdentifiers`. On a normal conflict/failure, persist `failed`. If the Agent signal aborts after the Lark operation began and the final remote result is not observed, persist `unknown` rather than falsely asserting failure.

Implement:

```ts
listWriteAttempts(eventId: string): Promise<WriteAttemptReceipt[]>
```

Order by `tool_runs.started_at` and return only typed tool name, outcome, sanitized summary, target identifiers, result identifiers, and stable error category.

- [ ] **Step 6: Block automatic replay in-process and after lease recovery**

Track whether `createWriteAudit` has crossed the boundary. In `runKnowledgeAgent`:

- non-budget failure before the boundary: finalize `failed` and throw;
- non-budget failure after the boundary: finalize `interrupted_after_write` and return a truthful interruption reply;
- timeout after the boundary: return `timeout_reached` with current receipts;
- never encode create/append/patch-specific reconciliation branches.

Return `writeStartedAt` from `EventStore.claimReady`. Add to worker options:

```ts
loadWriteAttempts(eventId: string): Promise<WriteAttemptReceipt[]>;
```

When a claimed event has `writeStartedAt` but no prepared reply:

```ts
const attempts = await this.options.loadWriteAttempts(event.eventId);
const reply: AgentReply = {
  outcome: 'interrupted_after_write',
  text: interruptedAfterWriteText(attempts),
  sources: [],
  usage: {},
  writeAttempts: attempts,
};
```

Persist and send that reply with the stable reply key. Do not call `runAgent` and do not call `retry`. Pass `agentRunStore.listWriteAttempts` from `src/app.ts`.

- [ ] **Step 7: Prove Agent-managed Recovery stays open**

Add an instruction/test pair proving the model receives the prior visible receipt on the next member message and still has the normal full Initial Typed Write Set. Assert there is no `reconcileCreate`, `reconcileAppend`, `reconcilePatch`, confirmation parser, or recovery router exported from `src`.

The Agent may inspect, search, retry, change approach, or ask the member based on context. Only the old run's automatic replay is forbidden.

- [ ] **Step 8: Run boundary and crash verification**

Run:

```bash
npm test -- test/storage/agent-run-store.test.ts test/storage/event-store.test.ts test/agent/tools.test.ts test/agent/run.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
npm run test:integration
npm run verify
```

Expected: all PASS; a recovered post-write event produces one interruption receipt and zero Agent replays, while a pre-write transient failure may still retry up to the existing third processing attempt.

- [ ] **Step 9: Commit the replay boundary**

```bash
git add src test drizzle
git commit -m "feat: prevent team agent replay after writes"
```

---

### Task 5: Align the release contract and complete live acceptance

**Files:**
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `test/lark/command-catalog.test.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `deploy/vultr/env.example`
- Modify: `docs/superpowers/specs/2026-08-07-team-agent-design.md`
- Modify: `docs/superpowers/plans/2026-08-07-team-agent.md`
- Create locally only, gitignored: `acceptance.local.jsonl`

**Interfaces:**
- Consumes: exact implementation commit containing Tasks 1–4.
- Consumes: existing verified Lark OAuth state under `/opt/minori/lark`.
- Produces: one exact-commit amd64 image and one healthy Minori Compose service on `198.13.34.221`.
- Produces: real private-chat-first, group-thread, knowledge read/write, restart, and credential-persistence evidence without message/document bodies.

- [x] **Step 1: Rewrite the release acceptance contract**

The integration suite must prove:

- any delivered private member and a directly mentioned external group member are accepted;
- unrelated group timeline messages are ignored;
- five independent conversations leave the fifth durably queued while four run;
- `Typing` is persisted before execution, survives retry/restart, and is removed terminally;
- step and timeout exhaustion send one explicit continuation reply without retry;
- create → append → fetch current → patch remains audited;
- a crash after write start sends an interruption receipt and never reruns the Agent;
- the tool catalog remains the Initial Typed Write Set plus read/history tools.

Rename test descriptions from “eligible” and “reversible” to “Feishu delivered” and “typed”. Update `test/scripts/release-contract.test.ts` so it asserts no `ALLOWED_CHAT_IDS` appears in either environment example or README.

- [x] **Step 2: Run the full local release gate**

Run:

```bash
npm run verify
npm run test:integration
MINORI_IMAGE=minori:plan-check MINORI_ENV_FILE=./env.example \
  docker compose -f deploy/vultr/compose.production.yaml config
docker build --tag minori:local-open-team-agent .
docker run --rm --entrypoint node minori:local-open-team-agent -e \
  "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),arch:process.arch}))"
```

Expected:

- all unit, integration, typecheck, and build checks PASS;
- Compose resolves only with explicit image and env file;
- image reports UID/GID `10001:10001` and the local architecture;
- a no-secret `npm run runtime:verify` fails only with sanitized unconfigured/degraded categories.

- [x] **Step 3: Commit the exact release candidate**

```bash
git add README.md .env.example deploy test docs CONTEXT.md
git commit -m "docs: align open team agent release"
git status --short
git rev-parse HEAD
```

Expected: worktree clean and `git rev-parse HEAD` returns one full 40-character candidate SHA. Record it as `COMMIT_SHA` locally; never substitute an abbreviated SHA.

- [ ] **Step 4: Transfer and import the exact commit without changing the remote worktree**

Create and verify a complete bundle:

```bash
COMMIT_SHA="$(git rev-parse HEAD)"
git bundle create /tmp/minori-open-team-agent.bundle HEAD
git bundle verify /tmp/minori-open-team-agent.bundle
scp /tmp/minori-open-team-agent.bundle \
  root@198.13.34.221:/root/minori-open-team-agent.bundle
```

On Vultr:

```bash
git -C /root/minori fetch /root/minori-open-team-agent.bundle \
  HEAD:refs/releases/open-team-agent-candidate
COMMIT_SHA="$(git -C /root/minori rev-parse refs/releases/open-team-agent-candidate)"
BUNDLE_SHA="$(git bundle list-heads /root/minori-open-team-agent.bundle | \
  awk '$2 == "HEAD" { print $1 }')"
test "$COMMIT_SHA" = "$BUNDLE_SHA"
git -C /root/minori status --short
```

Expected: imported ref equals `COMMIT_SHA` exactly; the existing remote branch/worktree remains unchanged and clean. The bundle contains repository history but no environment or Lark credential files; transfer only under the user's existing explicit server authorization.

- [ ] **Step 5: Sanitize the production environment and run exact-image preflight**

With `/opt/minori/minori.env` mode `0600`, remove only the obsolete `ALLOWED_CHAT_IDS` line. Do not print any value. Confirm presence, not contents, of:

- `DATABASE_URL`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID`
- `OPENAI_API_KEY`
- `AI_MODEL`
- optional `OPENAI_BASE_URL`

Build from the immutable commit:

```bash
COMMIT_SHA="$(git -C /root/minori rev-parse refs/releases/open-team-agent-candidate)"
git -C /root/minori archive "$COMMIT_SHA" | \
  docker build --pull \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --tag "minori:$COMMIT_SHA" -
docker image inspect "minori:$COMMIT_SHA" \
  --format '{{json .Config.Labels}} {{.Architecture}} {{.Config.User}}'
docker run --rm \
  --env-file /opt/minori/minori.env \
  --volume /opt/minori/lark:/var/lib/minori/lark \
  "minori:$COMMIT_SHA" npm run runtime:verify
```

Expected: OCI revision equals `COMMIT_SHA`, architecture is `amd64`, user is `10001:10001`, and database/Feishu/Lark/model categories are all `ok`. Do not rerun interactive OAuth when the persisted user identity remains healthy.

- [ ] **Step 6: Deploy the exact commit**

Use a temporary detached worktree so the deploy script itself comes from the candidate:

```bash
COMMIT_SHA="$(git -C /root/minori rev-parse refs/releases/open-team-agent-candidate)"
release_worktree="/tmp/minori-open-team-agent-$COMMIT_SHA"
git -C /root/minori worktree add --detach "$release_worktree" "$COMMIT_SHA"
"$release_worktree/scripts/deploy-vultr.sh" "$COMMIT_SHA"
curl --fail --silent http://127.0.0.1:3000/health/ready
docker inspect minori --format '{{.Config.Image}} {{.State.Health.Status}}'
git -C /root/minori worktree remove "$release_worktree"
```

Expected: release image is `minori:<COMMIT_SHA>`, health is `healthy`, every readiness category is `ok`, and the deploy script records the commit-addressed Compose contract. On any failed readiness check, stop and use the script's verified rollback result; do not manually force the unhealthy container live.

- [ ] **Step 7: Run private-chat-first live acceptance**

Ask the user to send one ordinary private message to Minori. Verify:

1. `Typing` appears after durable receipt;
2. Minori answers without requiring group membership or a scenario phrase;
3. `Typing` disappears after the reply;
4. recent logs contain stable categories only.

Then perform:

1. one direct mention in any group where the bot is present;
2. one natural continuation in the same Agent Thread without another mention;
3. one request from an external collaborator if an external test identity is available;
4. one real knowledge read and source link;
5. one disposable create, append, and targeted patch;
6. one service restart followed by private continuation and another knowledge read.

Do not test future rename/move/trash/permission tools. Remove the disposable document manually in Feishu after evidence is recorded.

- [ ] **Step 8: Record sanitized acceptance evidence**

Append one JSON object per check to gitignored `acceptance.local.jsonl` with only:

```json
{
  "check": "private_chat_reply",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "image": "minori:0123456789abcdef0123456789abcdef01234567",
  "messageId": "om_acceptance_1",
  "resourceUrl": "optional-feishu-url",
  "timestamp": "ISO-8601",
  "result": "pass"
}
```

Never record message bodies, document content, prompts, provider output, OAuth data, environment values, or credentials. The release is complete only when private chat, group thread, read/write, restart recovery, readiness, and Lark credential persistence all pass against the same exact image.

---

## Self-review checklist

- [x] Every canonical design requirement maps to a task.
- [x] `rg "T[B]D|T[O]DO|implement lat[e]r|similar to T[a]sk" docs/superpowers/plans/2026-08-07-team-agent.md` returns no plan placeholders.
- [x] `AgentReplyOutcome`, `WriteAttemptReceipt`, `AgentRunStore`, and `EventStore` signatures are identical wherever referenced.
- [x] No task reintroduces membership, per-requester document authorization, quotas, scenario routing, mandatory recovery confirmation, or content filtering.
- [x] No task expands the Initial Typed Write Set.
- [x] Local verification is clearly separated from live Vultr and Feishu acceptance.
- [x] The exact deployment SHA, image tag, OCI revision, Compose contract, and acceptance evidence all agree.
