# Agent Failure Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one bounded internal failure message on each Agent Run whose terminal result was caused by a caught exception, then clear that diagnostic after 30 days.

**Architecture:** Normalize caught values at the Agent boundary into a stable, 2,000-code-point diagnostic and carry it into the existing fail-closed `AgentRunStore.finish` call. Add one nullable PostgreSQL column and purge only that body through the existing daily retention lifecycle, preserving the structural Agent Run. The migration remains additive so the supported rollback image can continue to write `agent_runs`.

**Tech Stack:** TypeScript 7, Node.js 22+, Vercel AI SDK 7, Vitest 4, Drizzle ORM/Kit, PostgreSQL 17 Testcontainers.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-12-agent-failure-and-rich-reply-design.md`.
- Persist only a caught `Error.message`, truncated to exactly 2,000 Unicode code points; non-`Error` rejections become `non_error_rejection`.
- Never deliberately concatenate prompts, tool results, API keys, OAuth tokens, or raw rejected objects into the diagnostic.
- Store diagnostics for exception-driven `failed`, `timeout_reached`, `aborted`, and `interrupted_after_write` outcomes.
- Keep `error_message` null for `completed` and natural `step_limit_reached` outcomes.
- Outcome and diagnostic must be written atomically by the existing bounded, fail-closed finalization update.
- Clear only `agent_runs.error_message` after 30 days; retain outcome, usage, tool counts, timestamps, and the Agent Run row.
- Do not expose the diagnostic in member replies, model context, logs, health, or release records.
- The migration must be one nullable additive column and must preserve previous-image inserts that omit it.
- TDD each slice, run `git diff --check`, and commit after each independently green task.

---

### Task 1: Normalize caught failures without leaking rejected values

**Files:**
- Create: `src/agent/failure-detail.ts`
- Create: `test/agent/failure-detail.test.ts`

**Interfaces:**
- Produces: `agentFailureDetail(error: unknown): string`.
- The returned string contains at most 2,000 Unicode code points.
- Non-`Error` inputs always return the literal `non_error_rejection` and are never stringified.

- [ ] **Step 1: Write the failing normalization contract**

Create `test/agent/failure-detail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { agentFailureDetail } from '../../src/agent/failure-detail.js';

describe('agentFailureDetail', () => {
  it('keeps an Error message and truncates by Unicode code point', () => {
    const message = `${'🧪'.repeat(2_000)}tail`;
    const detail = agentFailureDetail(new Error(message));
    expect([...detail]).toHaveLength(2_000);
    expect(detail).toBe('🧪'.repeat(2_000));
  });

  it.each([undefined, null, 'Bearer secret', 42, { token: 'secret' }])(
    'maps a non-Error rejection to a stable value without serialization',
    (rejection) => {
      const detail = agentFailureDetail(rejection);
      expect(detail).toBe('non_error_rejection');
      expect(detail).not.toMatch(/Bearer|secret|token/iu);
    },
  );

  it('retains an empty Error message as an empty bounded diagnostic', () => {
    expect(agentFailureDetail(new Error(''))).toBe('');
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/agent/failure-detail.test.ts
```

Expected: FAIL because `src/agent/failure-detail.ts` does not exist.

- [ ] **Step 3: Implement the bounded normalizer**

Create `src/agent/failure-detail.ts`:

```ts
export const AGENT_FAILURE_DETAIL_CODE_POINT_LIMIT = 2_000;

export function agentFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'non_error_rejection';
  return [...error.message]
    .slice(0, AGENT_FAILURE_DETAIL_CODE_POINT_LIMIT)
    .join('');
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npx vitest run test/agent/failure-detail.test.ts
npm run typecheck
```

Expected: all tests and TypeScript checks pass.

- [ ] **Step 5: Commit the normalization slice**

```bash
git add src/agent/failure-detail.ts test/agent/failure-detail.test.ts
git commit -m "feat: bound agent failure details"
```

---

### Task 2: Store and expire Agent Failure Details

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `src/storage/runtime.ts`
- Modify: `test/storage/agent-run-store.test.ts`
- Modify: `test/storage/storage-runtime.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Create: `drizzle/0012_agent_failure_detail.sql`
- Create: `drizzle/meta/0012_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Extends `AgentRunStore.finish(agentRunId, input)` with `errorMessage?: string`.
- Produces `AgentRunStore.purgeFailureDetails(before: Date): Promise<number>`.
- `PostgresAgentRunStore.finish` atomically writes `outcome`, `error_message`, usage, tool count, and `finished_at` in one update.
- The storage runtime includes failure-detail purging in its existing daily retention result count.

- [ ] **Step 1: Write failing PostgreSQL storage and retention contracts**

Add to `test/storage/agent-run-store.test.ts`:

```ts
it('atomically stores the terminal outcome and bounded failure detail', async () => {
  const run = await store.start({ eventId: 'evt_1', claimAttempt: 1, model: 'test' });
  await store.finish(run.id, {
    toolCallCount: 2,
    outcome: 'failed',
    errorMessage: 'provider request failed',
  });

  const result = await database.pool.query<{
    outcome: string;
    errorMessage: string | null;
  }>(`select outcome, error_message as "errorMessage" from agent_runs where id = $1`, [run.id]);
  expect(result.rows).toEqual([{
    outcome: 'failed',
    errorMessage: 'provider request failed',
  }]);
});

it('clears only failure details older than the retention cutoff', async () => {
  const expired = await store.start({ eventId: 'evt_1', claimAttempt: 1, model: 'test' });
  await database.pool.query(`
    insert into processed_events (
      event_id, message_id, payload, conversation_key, status
    ) values (
      'evt_2', 'om_2',
      '{"eventId":"evt_2","messageId":"om_2","chatId":"oc_2","conversationKey":"oc_2","senderOpenId":"ou_2","chatType":"p2p","content":{"kind":"text","text":"hello","feishuLinks":[]},"occurredAt":"2026-08-01T00:00:00.000Z"}'::jsonb,
      'oc_2', 'processing'
    )
  `);
  const retained = await store.start({ eventId: 'evt_2', claimAttempt: 1, model: 'test' });
  await store.finish(expired.id, { toolCallCount: 1, outcome: 'failed', errorMessage: 'old' });
  await store.finish(retained.id, { toolCallCount: 1, outcome: 'failed', errorMessage: 'new' });
  await database.pool.query(
    `update agent_runs set finished_at = case when id = $1 then $3 else $4 end where id in ($1, $2)`,
    [expired.id, retained.id, new Date('2026-07-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z')],
  );

  await expect(store.purgeFailureDetails(new Date('2026-07-15T00:00:00Z'))).resolves.toBe(1);
  const result = await database.pool.query<{
    id: string;
    outcome: string;
    errorMessage: string | null;
  }>(`select id, outcome, error_message as "errorMessage" from agent_runs order by id`);
  expect(result.rows).toEqual(expect.arrayContaining([
    { id: expired.id, outcome: 'failed', errorMessage: null },
    { id: retained.id, outcome: 'failed', errorMessage: 'new' },
  ]));
});
```

In `test/storage/storage-runtime.test.ts`, insert a very old finished Agent Run before starting the configured runtime, then assert startup retention clears only its diagnostic:

```ts
await migrationDatabase.pool.query(`
  insert into agent_runs (model, outcome, error_message, finished_at)
  values ('retention-probe', 'failed', 'expired provider detail', '2000-01-01T00:00:00Z')
`);

await runtime.start();

const retained = await migrationDatabase.pool.query<{
  outcome: string;
  errorMessage: string | null;
}>(`
  select outcome, error_message as "errorMessage"
  from agent_runs where model = 'retention-probe'
`);
expect(retained.rows).toEqual([{ outcome: 'failed', errorMessage: null }]);
```

In the rollback compatibility test in `test/contract/team-agent.acceptance.test.ts`, execute a previous-image-shaped insert that omits `error_message`:

```ts
const legacyRun = await database.pool.query<{ errorMessage: string | null }>(`
  insert into agent_runs (model, outcome)
  values ('rollback-probe', 'failed')
  returning error_message as "errorMessage"
`);
expect(legacyRun.rows).toEqual([{ errorMessage: null }]);
```

- [ ] **Step 2: Run the PostgreSQL contracts and confirm RED**

Run with a working local Docker runtime:

```bash
npx vitest run --config vitest.integration.config.ts \
  test/storage/agent-run-store.test.ts \
  test/contract/team-agent.acceptance.test.ts
npx vitest run test/storage/storage-runtime.test.ts
```

Expected: FAIL because `errorMessage`, `error_message`, and `purgeFailureDetails` do not exist.

- [ ] **Step 3: Add the nullable field and atomic store operations**

In `src/storage/schema.ts`, add to `agentRuns` immediately before `startedAt`:

```ts
errorMessage: text('error_message'),
```

Extend `AgentRunStore.finish` and `PostgresAgentRunStore.finish` input with:

```ts
errorMessage?: string;
```

Add the value to the existing single update:

```ts
errorMessage: input.errorMessage ?? null,
```

Add to `AgentRunStore`:

```ts
purgeFailureDetails(before: Date): Promise<number>;
```

Implement it in `PostgresAgentRunStore`:

```ts
async purgeFailureDetails(before: Date): Promise<number> {
  const cleared = await this.db.update(agentRuns).set({
    errorMessage: null,
  }).where(and(
    lt(agentRuns.finishedAt, before),
    isNotNull(agentRuns.errorMessage),
  )).returning({ id: agentRuns.id });
  return cleared.length;
}
```

Update the imports from `drizzle-orm` with `and`, `isNotNull`, and `lt`.

- [ ] **Step 4: Add the failure purge to the existing retention lifecycle**

In `src/storage/runtime.ts`, construct the Agent Run store once:

```ts
const agentRunStore = new PostgresAgentRunStore(database.db);
```

Inside the existing retention aggregate:

```ts
const messages = await conversationStore.purgeExpired(before);
const agentFailures = await agentRunStore.purgeFailureDetails(before);
const schedules = await scheduleStore.purgeTerminalBodies(new Date());
return messages + agentFailures + schedules;
```

Return this same `agentRunStore` instance from the runtime rather than constructing a second one.

- [ ] **Step 5: Generate and inspect the additive migration**

Run:

```bash
npx drizzle-kit generate --name agent_failure_detail
```

Expected `drizzle/0012_agent_failure_detail.sql` content:

```sql
ALTER TABLE "agent_runs" ADD COLUMN "error_message" text;
```

Inspect `drizzle/meta/0012_snapshot.json` and confirm it retains `allowed_chats`, all existing tables/columns, and adds only nullable `agent_runs.error_message`. Confirm `_journal.json` has one new `0012_agent_failure_detail` entry.

- [ ] **Step 6: Run focused storage and compatibility verification**

Run:

```bash
npx vitest run test/storage/storage-runtime.test.ts
npx vitest run --config vitest.integration.config.ts \
  test/storage/agent-run-store.test.ts \
  test/contract/team-agent.acceptance.test.ts
npm run typecheck
```

Expected: all tests pass; the previous-image insert returns a null diagnostic.

- [ ] **Step 7: Commit the persistence slice**

```bash
git add src/storage/schema.ts src/storage/agent-run-store.ts src/storage/runtime.ts \
  test/storage/agent-run-store.test.ts test/storage/storage-runtime.test.ts \
  test/contract/team-agent.acceptance.test.ts drizzle/0012_agent_failure_detail.sql \
  drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: retain agent failure details"
```

---

### Task 3: Carry exception details through every Agent terminal path

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Consumes `agentFailureDetail(error: unknown): string` from Task 1.
- Consumes `AgentRunStore.finish(..., { errorMessage?: string })` from Task 2.
- Produces no member-visible field; `AgentReply` remains unchanged.

- [ ] **Step 1: Add failing Agent lifecycle tests**

Extend `test/agent/run.test.ts` with one assertion per terminal path. Reuse the existing timeout, external cancellation, post-write interruption, step-limit, completion, and retry fixtures, then assert the captured `finish` input:

```ts
expect(agentRunStore.finish).toHaveBeenLastCalledWith('run_1', expect.objectContaining({
  outcome: 'timeout_reached',
  errorMessage: 'provider timed out',
}));
```

```ts
expect(agentRunStore.finish).toHaveBeenLastCalledWith('run_1', expect.objectContaining({
  outcome: 'aborted',
  errorMessage: 'caller cancelled',
}));
```

```ts
expect(agentRunStore.finish).toHaveBeenLastCalledWith('run_1', expect.objectContaining({
  outcome: 'interrupted_after_write',
  errorMessage: 'provider failed after write',
}));
```

For natural outcomes:

```ts
expect(agentRunStore.finish).toHaveBeenLastCalledWith('run_1', expect.not.objectContaining({
  errorMessage: expect.anything(),
}));
```

Add a non-`Error` rejection and a long emoji message case to prove the production boundary uses the Task 1 normalizer. In the retry acceptance fixture, query the two `agent_runs` rows and assert that each failed attempt owns its own detail rather than overwriting another row.

- [ ] **Step 2: Run focused lifecycle tests and confirm RED**

Run:

```bash
npx vitest run test/agent/failure-detail.test.ts test/agent/run.test.ts
npx vitest run --config vitest.integration.config.ts test/contract/team-agent.acceptance.test.ts
```

Expected: the new `finish` assertions fail because `runKnowledgeAgent` does not pass a diagnostic.

- [ ] **Step 3: Capture the exception that determines the terminal result**

In `src/agent/run.ts`, import `agentFailureDetail` and add beside `outcome`:

```ts
let errorMessage: string | undefined;
```

At the top of the main `catch (error)` block, assign:

```ts
errorMessage = agentFailureDetail(error);
```

Keep all existing outcome precedence unchanged: first-abort timeout still returns `timeout_reached`, a crossed write boundary still returns `interrupted_after_write`, and external cancellation still sets `aborted` then rethrows. Do not assign `errorMessage` in the natural completion or step-budget branches.

Pass the diagnostic only through the existing finalizer:

```ts
await withAuditFinalization(() => dependencies.agentRunStore.finish(run.id, {
  ...(inputTokens !== undefined ? { inputTokens } : {}),
  ...(outputTokens !== undefined ? { outputTokens } : {}),
  ...(errorMessage !== undefined ? { errorMessage } : {}),
  toolCallCount,
  outcome,
}));
```

For a late `agentRunStore.start` completion after abort, capture `runSignal.reason` through `agentFailureDetail` in the existing late-finalization callback and keep its outcome `aborted`.

- [ ] **Step 4: Prove the diagnostic is internal-only**

Add an acceptance assertion that the provider error appears in `agent_runs.error_message` but not in:

```ts
JSON.stringify(messenger.replies)
```

and not in captured logger bindings/messages. Do not add `errorMessage` to `AgentReply`, `EventOutcome`, health output, or conversation messages.

- [ ] **Step 5: Run the focused and full gates**

Run:

```bash
npx vitest run test/agent/failure-detail.test.ts test/agent/run.test.ts \
  test/storage/storage-runtime.test.ts test/runtime/logger.test.ts
npx vitest run --config vitest.integration.config.ts \
  test/storage/agent-run-store.test.ts test/contract/team-agent.acceptance.test.ts
npm run verify
npm run test:integration
git diff --check
```

Expected: all unit, PostgreSQL, acceptance, typecheck, and build gates pass; no message or log contains the diagnostic.

- [ ] **Step 6: Commit the Agent wiring slice**

```bash
git add src/agent/run.ts test/agent/run.test.ts test/contract/team-agent.acceptance.test.ts
git commit -m "feat: audit terminal agent errors"
```

---

## Plan Self-Review

- Spec coverage: normalization, all four exception-driven outcomes, natural-outcome nulls, per-retry rows, atomic finalization, nullable migration, rollback compatibility, 30-day purge, and non-disclosure all map to explicit tasks.
- Placeholder scan: no deferred implementation steps or unspecified error handling remain.
- Type consistency: `errorMessage?: string` is used consistently by the Agent and store; the database column remains `error_message`.
