# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any Feishu-delivered member naturally create and manage one-time or recurring team-global tasks that run the existing Minori Agent later, with deterministic calendar behavior, durable no-replay execution, and ordinary-message delivery.

**Architecture:** PostgreSQL stores versioned Scheduled Tasks and one immutable Scheduled Run per `(schedule_id, scheduled_for)`. A transactional dispatcher computes due occurrences and folds downtime/overlap into at most one latest catch-up. A shared `AgentInvocationRunner` executes message and scheduled invocations using the Team Context `ContextAssembler` and Persistent Agent Write fence. Scheduled runs enter the Durable Conversation Queue under Result Target, are admitted at global concurrency four with one scheduled slot and message priority, and are never business-retried after claim.

**Tech Stack:** TypeScript 7, Node.js 22, Vercel AI SDK, Zod, `cron-parser` 5.x for validated timezone-aware occurrence calculation, Feishu Open Platform SDK, Lark CLI adapter, PostgreSQL/Drizzle, Vitest/Testcontainers, Docker, GitHub Actions.

**Approved design:** `docs/superpowers/specs/2026-08-10-team-context-scheduled-tasks-design.md`

**Dependency:** Complete and deploy `docs/superpowers/plans/2026-08-10-team-context.md` first. This plan consumes `ContextAssembler`, `TeamContextSource`, and `PersistentWriteAudit`; it must not recreate them.

## Global Constraints

- Any Feishu-delivered member, including an external collaborator, may list/read/change every task and may select any uniquely named group visible to the bot. There is no internal-member or origin-conversation ACL.
- The task registry is team-global. Private-created task definitions are globally visible. Origin Conversation is provenance/default target, not authorization.
- The Agent may create a schedule only for semantic future/recurring/reminder/follow-up intent in Current Invocation. Do not add keyword matching or a hard-coded dialogue flow.
- v1 accepts one explicit timestamp or a normalized five-field cron expression plus IANA timezone; default `Asia/Shanghai`. No holidays, business days, relative events, conditions, or workflow graphs.
- Result Target is delivery only. Live Group History is loaded only from an explicitly bound Scheduled Context and is cut off at `scheduled_for`.
- Scheduled runs have the existing full Agent and typed knowledge tools, but never the Team Context mutation tool. Schedule tools are available only to member-triggered runs.
- Every schedule mutation is a Persistent Agent Write. Reads/listing are not.
- There is no business retry after a Scheduled Run is claimed, before or after a write. Expired processing claims become terminal failed and never invoke the Agent again.
- At most one queued/processing run exists per task; at most one Scheduled Run processes globally; total Agent concurrency remains four; a queued message wins admission over a queued schedule; processing runs are never preempted.
- Scheduled results are top-level ordinary messages: no reply thread and no Typing reaction. Delivery uses Scheduled Run ID as idempotency key; uncertain delivery is terminal and not resent.
- Scheduler failure or `SCHEDULE_ENABLED=false` must not disable ordinary message processing.
- All migrations are additive and compatible with the Team Context rollback floor.

## File Map

**Create:**

- `src/schedule/types.ts` — domain values and state unions.
- `src/schedule/calendar.ts` — strict one-time/cron normalization and occurrence calculation.
- `src/storage/schedule-store.ts` — versioned task lifecycle and transactional dispatch state.
- `src/storage/scheduled-run-store.ts` — claims, recovery, delivery, and audit.
- `src/schedule/dispatcher.ts` — polling, catch-up folding, and kill switch.
- `src/schedule/worker.ts` — no-retry scheduled execution.
- `src/schedule/delivery.ts` — top-level result/fallback delivery.
- `src/feishu/chat-directory.ts` — exact unique group resolution.
- `src/agent/invocation-runner.ts` — shared message/scheduled Agent execution.
- Unit/integration tests matching each new module.
- Additive migrations beginning at `drizzle/0007_scheduled_tasks.sql`.

**Modify:**

- `package.json`, `package-lock.json`
- `src/storage/schema.ts`, `src/storage/runtime.ts`, `src/storage/retention.ts`
- `src/agent/run.ts`, `src/agent/tools.ts`, `src/agent/instructions.ts`, `src/agent/run-outcome.ts`
- `src/storage/agent-run-store.ts`, `src/storage/event-store.ts`
- `src/feishu/client.ts`
- `src/worker/message-worker.ts`
- `src/runtime/config.ts`, `src/runtime/health.ts`, `src/app.ts`
- Existing Agent, storage, worker, acceptance, and release-contract tests.
- `.env.example`, `deploy/vultr/minori.env.example`, `README.md`, `CONTEXT.md`

---

### Task 1: Define deterministic Calendar Schedules

**Files:**
- Create: `src/schedule/types.ts`
- Create: `src/schedule/calendar.ts`
- Create: `test/schedule/calendar.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export type CalendarSchedule =
  | { kind: 'once'; at: Date; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string };

export interface CalendarCalculator {
  normalize(input: { kind: 'once'; localTimestamp: string; timezone: string } |
    { kind: 'cron'; expression: string; timezone: string }, now: Date): CalendarSchedule;
  next(schedule: CalendarSchedule, after: Date): Date | undefined;
  latestAtOrBefore(schedule: CalendarSchedule, after: Date, through: Date): Date | undefined;
}
```

- [ ] **Step 1: Install and pin the timezone-aware parser**

```bash
npm install cron-parser@^5.1.0
```

Use `CronExpressionParser` only for parsing/iterating validated five-field expressions. Wrap it behind `CalendarCalculator`; no library type leaks into stores or tools. The library documents IANA timezone and DST-aware iteration in its [official package README](https://www.npmjs.com/package/cron-parser).

- [ ] **Step 2: Write RED calendar tests**

Cover explicit UTC timestamp, local timestamp + zone, default zone supplied by caller, invalid/unknown zone, past one-time, exactly five cron fields, invalid fields, next occurrence, latest missed occurrence, original-calendar anchoring, spring-forward nonexistent local time skipped, and fall-back repeated local time emitted once at the first instant.

```ts
expect(calendar.next(
  { kind: 'cron', expression: '30 2 * * *', timezone: 'America/Los_Angeles' },
  new Date('2026-03-08T09:00:00Z'),
)).toEqual(new Date('2026-03-09T09:30:00Z'));
```

- [ ] **Step 3: Confirm RED, implement the adapter, and run GREEN**

```bash
npm test -- test/schedule/calendar.test.ts
npm run typecheck
```

Reject seconds, aliases with side effects, special `L/W/#`, multiple expressions, and library-specific extensions even if the library can parse them. Store the normalized five-field string.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/schedule test/schedule/calendar.test.ts
git commit -m "feat: define calendar schedules"
```

---

### Task 2: Persist tasks, revisions, runs, and structural tombstones

**Files:**
- Modify: `src/storage/schema.ts`
- Create: `src/storage/schedule-store.ts`
- Create: `src/storage/scheduled-run-store.ts`
- Create: `test/storage/schedule-store.test.ts`
- Create: `test/storage/scheduled-run-store.test.ts`
- Create: `drizzle/0007_scheduled_tasks.sql`
- Create: `drizzle/meta/0007_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Domain records:**

```ts
export type ScheduleState = 'active' | 'paused' | 'in_flight' | 'completed' | 'deleted';
export type ScheduledRunStatus =
  | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'delivery_uncertain';

export type FrozenScheduledInvocation = {
  taskVersion: number;
  instruction: string;
  scheduledFor: Date;
  resultTarget: { chatId: string; displayName: string; chatType: 'group' | 'p2p' };
  scheduledContext?: { chatId: string; displayName: string };
};
```

- [ ] **Step 1: Write lifecycle and concurrency RED tests**

Test case-insensitive unique names for non-terminal tasks, terminal name reuse, immutable creator/origin, monotonic versions, expected-version conflict, independent-field reapply input, active/paused/in-flight/completed/deleted transitions, complete revision history, queued snapshot immutability, one-time pause-update-resume rebinding of the same run ID, processing immutability, deleted-in-flight name reservation, and 30-day body purge with structural fields retained.

Add concurrent dispatcher tests proving one row for `(schedule_id, scheduled_for)` and at most one queued/processing run per task.

- [ ] **Step 2: Confirm RED**

```bash
npm run test:integration -- test/storage/schedule-store.test.ts test/storage/scheduled-run-store.test.ts
```

- [ ] **Step 3: Add additive tables**

Create:

- `scheduled_tasks` for current structural state, current version, calendar, target, optional context, next due/latest missed, origin, and purge markers;
- `scheduled_task_revisions` for versioned bodies and immutable resolved targets;
- `scheduled_runs` for frozen invocation, claim/lease, write-start, delivery state, and sanitized outcome;
- partial unique indexes for `lower(name)` among non-terminal/name-reserving rows and one active run per task;
- unique `(schedule_id, scheduled_for)`.

Do not reuse `processed_events` or fabricate `NormalizedMessage`. Foreign keys from scheduled runs/revisions keep structural tombstones after bodies are purged.

- [ ] **Step 4: Implement stores with row locks and expected versions**

Mutation methods accept `taskId`, `expectedVersion`, `actorOpenId`, and exact changes. Each transaction locks the task row, validates state/version, writes a revision when definition changes, and returns either updated task or a typed conflict with the latest task. Never update by name alone.

- [ ] **Step 5: Generate/inspect migration and run GREEN**

```bash
npx drizzle-kit generate
rg -n "DROP|RENAME|scheduled_tasks|scheduled_task_revisions|scheduled_runs" drizzle/0007_scheduled_tasks.sql
npm run test:integration -- test/storage/schedule-store.test.ts test/storage/scheduled-run-store.test.ts test/contract/team-agent.acceptance.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/storage src/schedule/types.ts test/storage drizzle
git commit -m "feat: persist scheduled task lifecycle"
```

---

### Task 3: Resolve explicit group targets without widening Feishu authority

**Files:**
- Create: `src/feishu/chat-directory.ts`
- Create: `test/feishu/chat-directory.test.ts`
- Modify: `src/feishu/client.ts`
- Modify: `test/feishu/client.test.ts`

**Interfaces:**

```ts
export interface ChatDirectory {
  resolveExactGroup(name: string, signal?: AbortSignal): Promise<
    | { status: 'resolved'; chatId: string; displayName: string }
    | { status: 'not_found'; errorCategory: 'schedule_target_not_found' }
    | { status: 'ambiguous'; errorCategory: 'schedule_target_ambiguous' }
  >;
}
```

- [ ] **Step 1: Write paginated exact-match RED tests**

Cover zero, one, and duplicate case-insensitive exact names across pages; ignore fuzzy/substrings and p2p chats; bind stable `chat_id`; abort; SDK failure mapped to a stable category; no raw IDs/names in logs.

- [ ] **Step 2: Extend only the typed Feishu SDK seam**

Add the official chat list call required by `im:chat:read`. The adapter may page visible chats but exposes only `resolveExactGroup`; do not expose raw SDK, arbitrary search, member lookup, or send-to-user-by-name.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- test/feishu/chat-directory.test.ts test/feishu/client.test.ts
npm run typecheck
git add src/feishu test/feishu
git commit -m "feat: resolve scheduled group targets"
```

---

### Task 4: Add team-global schedule tools behind the Persistent Agent Write fence

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/instructions.ts`
- Modify: `src/agent/run.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/agent/injection.test.ts`
- Modify: `test/storage/agent-run-store.test.ts`

**Tool set:** `createSchedule`, `listSchedules`, `updateSchedule`, `pauseSchedule`, `resumeSchedule`, `deleteSchedule`.

- [ ] **Step 1: Write RED authority and schema tests**

Assert all member-triggered group/p2p runs expose all six tools regardless of internal/external identity; scheduled runs expose none of the lifecycle tools and no Team Context mutation. `listSchedules` defaults to active/paused/in-flight and includes history only when explicitly requested. Every mutation schema requires expected version except create and contains no actor ID supplied by the model.

Assert the runtime—not the model—injects immutable creator/actor/open origin from Current Invocation. A group target name is resolved before the fenced store mutation; a p2p target may only be the origin p2p. Scheduled Context is absent unless the tool call explicitly contains the resolved current/other group.

- [ ] **Step 2: Define strict tool inputs**

```ts
const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(20_000),
  schedule: calendarScheduleInputSchema,
  resultTarget: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('origin') }),
    z.object({ kind: z.literal('group_name'), name: z.string().trim().min(1).max(200) }),
  ]),
  scheduledContext: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('origin_group') }),
    z.object({ kind: z.literal('group_name'), name: z.string().trim().min(1).max(200) }),
  ]).default({ kind: 'none' }),
}).strict();
```

Update inputs use optional independent fields plus `taskId` and `expectedVersion`; reject an empty change. Pause/resume/delete require only stable ID + expected version.

- [ ] **Step 3: Route mutations through `PersistentWriteAudit`**

Audit target identifiers contain task ID/version or normalized name hash—not instruction/body. Successful receipts expose task ID, version, state, normalized schedule, timezone, target display name, queued-old-version boolean, and next run. Conflict categories remain stable.

The model instruction says schedules require member future intent, but the application does not parse keywords. Old history, Team Context, retrieved docs, and tool results cannot independently authorize schedule creation.

- [ ] **Step 4: Implement one minimal independent-field reapply**

On version conflict, return latest task and changed-field set. The Agent may call update once more only if requested fields do not intersect fields changed since its expected revision. Store remains fail-closed; no last-write-wins branch.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm test -- test/agent/tools.test.ts test/agent/run.test.ts test/agent/injection.test.ts
npm run test:integration -- test/storage/agent-run-store.test.ts test/storage/schedule-store.test.ts
npm run typecheck
git add src/agent src/storage/agent-run-store.ts test/agent test/storage
git commit -m "feat: manage team scheduled tasks"
```

---

### Task 5: Dispatch due occurrences and fold downtime/overlap

**Files:**
- Create: `src/schedule/dispatcher.ts`
- Create: `test/schedule/dispatcher.test.ts`
- Modify: `src/storage/schedule-store.ts`
- Modify: `src/storage/scheduled-run-store.ts`
- Modify: `test/storage/schedule-store.test.ts`
- Modify: `test/storage/scheduled-run-store.test.ts`

**Interfaces:**

```ts
export interface ScheduleDispatcher {
  poll(now: Date): Promise<{ created: number; folded: number }>;
  start(): void;
  stop(): void;
  status(): 'ok' | 'degraded' | 'disabled';
}
```

- [ ] **Step 1: Write RED dispatch races**

Two dispatchers poll the same due task concurrently: exactly one frozen run exists and task advancement commits with it. Cover one-time -> in-flight, recurring next due anchored to calendar, downtime folds to latest missed, older misses increment audit only, active run records latest missed without adding a second, terminal run allows one catch-up, pause suppresses interval, resume starts strictly after resume time, delete prevents claims, and kill switch creates nothing.

- [ ] **Step 2: Implement one transactional claim query**

Use database time and `FOR UPDATE SKIP LOCKED`. In the same transaction: lock eligible task, calculate most recent due/next future, insert run with `ON CONFLICT DO NOTHING`, freeze task revision and targets, update task state/next due/missed counters. Do not call the Agent, Feishu, or Lark inside the transaction.

- [ ] **Step 3: Add bounded polling**

One in-process timer wakes on the configured interval and after task mutations. Poll failures set scheduler health degraded and retry the poll later; they do not mutate run outcome and do not affect message worker readiness.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- test/schedule/dispatcher.test.ts
npm run test:integration -- test/storage/schedule-store.test.ts test/storage/scheduled-run-store.test.ts
npm run typecheck
git add src/schedule/dispatcher.ts src/storage test/schedule/dispatcher.test.ts test/storage
git commit -m "feat: dispatch durable scheduled runs"
```

---

### Task 6: Share Agent execution and fence scheduled writes

**Files:**
- Create: `src/agent/invocation-runner.ts`
- Create: `test/agent/invocation-runner.test.ts`
- Modify: `src/agent/run.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `src/storage/schema.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/storage/agent-run-store.test.ts`
- Create: additive migration if scheduled invocation linkage is not already in `0007`.

**Interfaces:**

```ts
export type AgentInvocation =
  | { kind: 'message'; eventId: string; claimAttempt: number; conversationKey: string;
      current: FeishuMemberInvocation }
  | { kind: 'scheduled'; scheduledRunId: string; claimAttempt: number; conversationKey: string;
      current: FrozenScheduledInvocation };

export interface InvocationFence {
  beginPersistentWrite(agentRunId: string, input: PersistentWriteAuditInput): Promise<{ id: string }>;
}
```

- [ ] **Step 1: Write RED parity tests**

For identical instruction/context, message and scheduled invocation construct the same Agent/model/tools except: scheduled has no schedule tools, no Team Context update, optional Scheduled Context instead of implicit group context, and no retained-history fallback. Both use current Core Policy/Team Context at run start and the same 40/300000 limits.

- [ ] **Step 2: Generalize Agent Run linkage additively**

Allow exactly one source: message `event_id + claim_attempt` or `scheduled_run_id + claim_attempt`. Keep old message columns nullable-compatible for rollback. `beginPersistentWrite` transaction selects the source kind and atomically marks either `processed_events.write_started_at` or `scheduled_runs.write_started_at`, fenced to current processing status and claim attempt.

- [ ] **Step 3: Extract `AgentInvocationRunner`**

Move shared model execution, step/deadline handling, source finalization, Team Context load, tool audit, and Agent-run finish from `runKnowledgeAgent`. Keep `runKnowledgeAgent` as a compatibility adapter for `MessageWorker`. Scheduled input uses saved task instruction as Current Invocation; if Scheduled Context is configured, call Group Context with cutoff `scheduledFor` and a synthetic run-bound trigger identifier that cannot be mistaken for a Feishu event.

- [ ] **Step 4: Prove no whole-run replay**

Test crash/failure before and after scheduled write start. A stale scheduled claim cannot begin a write. Once any persistent write begins, later failure yields the existing truthful interruption receipt and never re-invokes the whole Agent. Separately, scheduled pre-write failures are still terminal—not message-style retry.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm test -- test/agent/invocation-runner.test.ts test/agent/run.test.ts
npm run test:integration -- test/storage/agent-run-store.test.ts test/storage/scheduled-run-store.test.ts
npm run typecheck
git add src/agent src/storage test/agent test/storage drizzle
git commit -m "refactor: share agent invocation runner"
```

---

### Task 7: Execute, deliver, and recover without retries

**Files:**
- Create: `src/schedule/delivery.ts`
- Create: `src/schedule/worker.ts`
- Create: `test/schedule/delivery.test.ts`
- Create: `test/schedule/worker.test.ts`
- Modify: `src/feishu/client.ts`
- Modify: `test/feishu/client.test.ts`
- Modify: `src/storage/scheduled-run-store.ts`
- Modify: `test/storage/scheduled-run-store.test.ts`

**Feishu seam:**

```ts
export interface ScheduledResultMessenger {
  sendText(chatId: string, text: string, idempotencyKey: string): Promise<string>;
}
```

- [ ] **Step 1: Write RED delivery contract tests**

Assert scheduled result calls the top-level message-create API for `chat_id`; it never calls reply, reaction create/delete, or thread mode. UUID/idempotency key derives only from Scheduled Run ID and fits Feishu bounds.

Cover success, Agent failure status delivery, transport rejection before/after attempt marker, `delivery_uncertain`, target inaccessible, one body-free origin fallback, origin fallback inaccessible, and no second attempt in every terminal branch.

- [ ] **Step 2: Implement the no-retry worker**

Claim one ready run with a lease and increment claim attempt. Immediately after claim, any thrown Agent/tool/delivery error becomes terminal. Never call a retry method. On process restart, `recoverExpiredClaims` marks processing rows `scheduled_run_failed` without invoking Agent or resending.

- [ ] **Step 3: Make transport ordering durable**

Persist prepared reply and `delivery_started_at` before Feishu send. Success stores reply message ID. If the call may have reached Feishu but no response is observed, mark `delivery_uncertain`. Do not use a later recovery process to resend.

- [ ] **Step 4: Implement the single fallback notice**

Fallback body contains task name, saved target display name, planned time, and stable category only. It excludes task instruction, Agent output, provider error, identities, document content, and chat history. Persist fallback attempted/result so restart cannot repeat it.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm test -- test/schedule/delivery.test.ts test/schedule/worker.test.ts test/feishu/client.test.ts
npm run test:integration -- test/storage/scheduled-run-store.test.ts
npm run typecheck
git add src/schedule src/feishu src/storage test/schedule test/feishu test/storage
git commit -m "feat: execute scheduled runs once"
```

---

### Task 8: Admit scheduled work through the Durable Conversation Queue

**Files:**
- Modify: `src/storage/event-store.ts`
- Modify: `src/storage/scheduled-run-store.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `src/schedule/worker.ts`
- Create: `src/worker/admission-coordinator.ts`
- Create: `test/worker/admission-coordinator.test.ts`
- Modify: `test/storage/event-store.test.ts`
- Modify: `test/storage/scheduled-run-store.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/restart-recovery.test.ts`

**Interfaces:**

```ts
export interface AdmissionCoordinator {
  wake(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 1: Write RED arbitration tests**

Cover global four across both kinds, maximum one processing scheduled run, same Result Target serialization against message events, Scheduled Context not affecting queue key, different targets using free capacity, message wins when both queued, scheduled uses a free slot when no message waits, and no preemption when a message arrives during processing schedule.

- [ ] **Step 2: Implement one coordinator, not two competing polling loops**

The coordinator asks stores for availability under a shared database admission transaction or lock. It tries message claims first, then at most one scheduled claim if capacity remains and no message is waiting. The durable conversation key for a scheduled run is frozen Result Target `chat_id`.

Do not collapse schedules into `processed_events`; keep type-specific stores and hand claimed work to the corresponding worker.

- [ ] **Step 3: Preserve message reaction/retry behavior**

Message claims retain current Typing reaction lifecycle and pre-write retries. Scheduled claims never add Typing and never retry. Restart tests must assert both policies simultaneously.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- test/worker/admission-coordinator.test.ts test/worker/message-worker.test.ts test/worker/restart-recovery.test.ts
npm run test:integration -- test/storage/event-store.test.ts test/storage/scheduled-run-store.test.ts test/contract/team-agent.acceptance.test.ts
npm run typecheck
git add src/worker src/schedule/worker.ts src/storage test/worker test/storage test/contract
git commit -m "feat: prioritize messages over scheduled runs"
```

---

### Task 9: Wire operations, retention, and health without coupling message readiness

**Files:**
- Modify: `src/runtime/config.ts`
- Modify: `src/runtime/health.ts`
- Modify: `src/storage/runtime.ts`
- Modify: `src/storage/retention.ts`
- Modify: `src/app.ts`
- Modify: `test/runtime/config.test.ts`
- Modify: `test/runtime/health.test.ts`
- Modify: `test/storage/retention.test.ts`
- Modify: `.env.example`
- Modify: `deploy/vultr/minori.env.example`

**Configuration:**

```ts
SCHEDULE_DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),
SCHEDULE_ENABLED: z.stringbool().default(true),
SCHEDULE_POLL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
SCHEDULE_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(360_000),
```

- [ ] **Step 1: Add RED config/health/retention tests**

Validate IANA timezone at startup, exact defaults, lease greater than Agent timeout, and disabled kill switch. Add `scheduler` to health. Disabled returns `ok` with a separate sanitized disabled detail or a documented non-blocking status; degraded scheduler must not make message worker unavailable or stop Feishu long connection.

Retention purges completed/deleted task instruction and revision bodies after 30 days while keeping IDs, actor identifiers, timestamps, state, targets, versions, and sanitized outcomes forever.

- [ ] **Step 2: Wire one runtime graph**

`createStorageRuntime` constructs both schedule stores. `createApp` constructs calendar, dispatcher, scheduled worker, shared invocation runner, chat directory, and admission coordinator only when DB/model/Lark/Feishu are present. Start health first, message runtime as today, then scheduler independently. Stop in reverse order and await in-flight bounded drains.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- test/runtime/config.test.ts test/runtime/health.test.ts test/storage/retention.test.ts
npm run test:integration -- test/storage/storage-runtime.test.ts test/storage/schedule-store.test.ts test/storage/scheduled-run-store.test.ts
npm run typecheck
git add src/runtime src/storage src/app.ts test/runtime test/storage .env.example deploy/vultr/minori.env.example
git commit -m "feat: wire scheduled task runtime"
```

---

### Task 10: Verify the complete scheduler contract and release it disabled-first

**Files:**
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-08-10-team-context-scheduled-tasks-design.md` only for implementation status.

- [ ] **Step 1: Add the full deterministic acceptance matrix**

Test:

1. external and internal members have identical schedule tools and global visibility;
2. natural future intent creates, while historical/fetched/model-inferred intent does not;
3. zero/one/multiple target-name resolution;
4. Result Target is independent from explicit Scheduled Context;
5. Scheduled Context cutoff equals `scheduled_for`, including catch-up, with no retained fallback;
6. one-time and cron runs use latest Core Policy/Team Context and full knowledge read/write tools;
7. scheduled runs have no Team Context/schedule mutation tools;
8. optimistic conflicts, queued old-version disclosure, and one-time pause-update-resume;
9. pause/delete/processing races, name reservation/reuse, and body purge;
10. one latest catch-up, occurrence folding, message priority, target serialization, kill switch;
11. no Agent replay after claim/write/crash and no delivery resend after uncertainty;
12. ordinary top-level delivery, zero Typing calls, one origin fallback at most;
13. all existing private/group message acceptance stays green.

- [ ] **Step 2: Lock release and permission contracts**

README and release tests must require published `im:chat:read`, document exact v1 calendar limits, global/external-member visibility, no retry, delivery/context separation, and sanitized operations. Env examples contain safe defaults but production initially sets `SCHEDULE_ENABLED=false`.

- [ ] **Step 3: Run every local gate**

```bash
npm run verify
npm run test:integration
docker build --platform linux/amd64 --label org.opencontainers.image.revision=$(git rev-parse HEAD) -t minori:scheduled-tasks .
docker inspect minori:scheduled-tasks --format '{{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
git diff --check
```

- [ ] **Step 4: Perform two-axis review**

Standards review focuses on transaction isolation, lease/abort behavior, stable error sanitation, module boundaries, timezone adapter isolation, and migration rollback. Spec review maps every bullet in design sections 5–10 and proves Team Context/message behavior did not regress.

- [ ] **Step 5: Commit the disabled-first release candidate**

```bash
git add package.json package-lock.json src test drizzle README.md CONTEXT.md docs .env.example deploy
git commit -m "feat: release scheduled tasks"
git status --short
```

- [ ] **Step 6: Protected deployment and disabled preflight**

Publish `im:chat:read`, release the exact protected tag/digest with `SCHEDULE_ENABLED=false`, run additive migrations, and verify message/Team Context readiness plus scheduler disabled state. Confirm zero scheduled claims.

- [ ] **Step 7: Enable and perform live Feishu acceptance**

Set `SCHEDULE_ENABLED=true` through the protected operations path. Test current private one-time target, uniquely named group recurrence, explicit distinct Scheduled Context, ordinary top-level delivery, no Typing, current Team Context, one knowledge write receipt, restart latest-only catch-up, target failure fallback, and unchanged message priority. Record only task/run IDs, versions, stable chat-ID equality hashes, planned/actual timestamps, statuses, counts, image/commit, and sanitized categories—never instructions, result bodies, names, Open IDs, provider errors, or secrets.

---

## Plan Completion Checklist

- [ ] Every Scheduled Task design requirement has a named implementation or test step.
- [ ] No task contains a placeholder, TODO, keyword router, implicit ACL, hidden retry, or implementation-time product decision.
- [ ] `Scheduled Task`, `Calendar Schedule`, `Scheduled Run`, `Result Target`, `Scheduled Context`, `AgentInvocationRunner`, and `InvocationFence` match the approved domain language.
- [ ] Message and scheduled execution share context/model/tool/audit code without representing a schedule as a Feishu message.
- [ ] Team Context remains read-only in scheduled runs.
- [ ] The scheduler can be deployed disabled, verified, enabled, and rolled back independently.
