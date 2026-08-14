# Scheduled Invocation Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every due Scheduled Run execute its frozen business instruction once instead of interpreting recurring schedule language as a request to create another task.

**Architecture:** Add one static Scheduled Run authority rule to the Agent system instructions and one model-only invocation envelope at `AgentInvocationRunner`. The envelope uses the existing `scheduledFor` instant, preserves the frozen instruction unchanged, and does not expose schedule-management tools or alter storage, dispatch, delivery, or retry behavior.

**Tech Stack:** TypeScript, AI SDK `ToolLoopAgent`, Vitest, existing `MockLanguageModelV4` contract harness.

## Global Constraints

- `scheduled_for` is the authority for relative date and cycle language, including catch-up runs.
- The frozen instruction authorizes existing business tools, including audited Typed Knowledge Writes, but never Scheduled Task registry mutation.
- Team Context remains read-only in Scheduled Runs.
- The runtime envelope is not persisted or returned to the member.
- Do not add schema changes, migrations, dependencies, retry behavior, task rewrites, or schedule-management tools.
- Do not replay the completed production occurrence or create an extra production test task.

---

## File structure

- Modify `src/agent/instructions.ts`: own the static, non-overridable Scheduled Run authority rule.
- Modify `src/agent/invocation-runner.ts`: own construction and injection of the per-occurrence execution envelope.
- Modify `test/contract/team-agent.acceptance.test.ts`: prove the behavior through the real scheduled Agent seam and existing meeting-tool fake.

### Task 1: Execute frozen Scheduled Run instructions under an explicit occurrence envelope

**Files:**
- Modify: `src/agent/instructions.ts`
- Modify: `src/agent/invocation-runner.ts`
- Test: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Consumes: `ScheduledRun` with `scheduledFor: Date` and `instruction: string`.
- Produces: `buildScheduledInvocationPrompt(run: Pick<ScheduledRun, 'scheduledFor' | 'instruction'>): string`.
- Preserves: `AgentInvocationRunner.runScheduled(...)`, `runKnowledgeAgent(...)`, task/run persistence, available business tools, and existing worker delivery semantics.

- [ ] **Step 1: Change the scheduled acceptance fixture to reproduce the production ambiguity**

In the existing Scheduled Run acceptance case in `test/contract/team-agent.acceptance.test.ts`, use an instruction containing the same load-bearing pattern as production:

```ts
const frozenInstruction = [
  '每次投递开头先单独添加一句：Minori 消息投递测试',
  '',
  '每天在下午 3:30（Asia/Shanghai）检索当天约下午 2:00 召开的日会会议记录，优先读取 AI 摘要。',
].join('\n');

const scheduled: ScheduledRun = {
  id: 'scheduled_run_1',
  scheduleId: 'schedule_1',
  taskVersion: 1,
  instruction: frozenInstruction,
  scheduledFor: new Date('2026-08-14T07:30:00.000Z'),
  resultTarget: { chatId: 'oc_target', displayName: 'Target', chatType: 'group' },
  status: 'processing',
  claimAttempt: 1,
  createdAt: new Date('2026-08-14T07:30:00.000Z'),
  updatedAt: new Date('2026-08-14T07:30:00.000Z'),
};
```

Keep the deterministic fake model's first response as a `searchMeetings` tool call and its second response as the final answer. This exercises the real Agent invocation and business-tool registry without relying on provider nondeterminism.

- [ ] **Step 2: Add assertions for the missing execution semantics and unchanged authority boundary**

After `runScheduled` resolves, add assertions equivalent to:

```ts
const firstCall = model.doGenerateCalls[0];
const serializedPrompt = JSON.stringify(firstCall?.prompt);
const toolNames = firstCall?.tools?.map(({ name }) => name) ?? [];

expect(serializedPrompt).toContain('2026-08-14T07:30:00.000Z');
expect(serializedPrompt).toContain('[Frozen Scheduled Task Instruction]');
expect(serializedPrompt.match(/每天在下午 3:30/gu)).toHaveLength(1);
expect(serializedPrompt).toContain('execute this already-created Scheduled Task occurrence');
expect(serializedPrompt).toContain('must not create or change Scheduled Tasks');
expect(toolNames).toEqual(expect.arrayContaining([
  'searchMeetings',
  'searchMeetingMinutes',
  'fetchMeetingContent',
]));
expect(toolNames).not.toEqual(expect.arrayContaining([
  'createSchedule',
  'updateSchedule',
  'pauseSchedule',
  'resumeSchedule',
  'deleteSchedule',
]));
expect(scheduled.instruction).toBe(frozenInstruction);
expect(meeting.searchMeetings).toHaveBeenCalledOnce();
```

These assertions intentionally check the exact load-bearing phrases from Steps 4–5 without snapshotting unrelated prompt content.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/contract/team-agent.acceptance.test.ts -t 'Scheduled Run' --reporter=verbose
```

Expected: FAIL because the prompt contains neither the Scheduled Run execution envelope nor the static authority text. Existing business-tool availability should remain green.

- [ ] **Step 4: Add the static Scheduled Run authority rule**

In `TEAM_AGENT_INSTRUCTIONS` in `src/agent/instructions.ts`, immediately after the existing Scheduled Task authority lines, add concise system-level wording with these exact semantics:

```text
A Current Invocation labeled Scheduled Task is an already-created occurrence to execute now. Execute its frozen business instruction once using available business tools. It must not create or change Scheduled Tasks; creating, updating, pausing, resuming, or deleting them always requires a new member-triggered Current Invocation.
```

Do not make this conditional on tool availability and do not change member-triggered scheduling behavior.

- [ ] **Step 5: Build and inject the per-occurrence prompt**

In `src/agent/invocation-runner.ts`, add a focused exported helper:

```ts
export function buildScheduledInvocationPrompt(
  run: Pick<ScheduledRun, 'scheduledFor' | 'instruction'>,
): string {
  return [
    '[Scheduled Task Occurrence]',
    `Scheduled for: ${run.scheduledFor.toISOString()}`,
    'Execute this already-created Scheduled Task occurrence exactly once now.',
    'Use scheduled_for to interpret relative dates and cycles, even during catch-up.',
    'Schedule or recurrence wording in the frozen instruction describes the existing task; it is not a request to create or change Scheduled Tasks.',
    '',
    '[Frozen Scheduled Task Instruction]',
    run.instruction,
    '[/Frozen Scheduled Task Instruction]',
  ].join('\n');
}
```

At the start of `runScheduled`, create `const prompt = buildScheduledInvocationPrompt(run)`. Use `prompt` for `AgentRunInput.prompt`, the ephemeral `history` entry, and the ephemeral trigger record returned by `recentWithinBudget`. Keep `run.instruction` unchanged on `run` and do not pass the envelope to storage APIs.

- [ ] **Step 6: Run the focused acceptance test and verify GREEN**

Run:

```bash
npx vitest run test/contract/team-agent.acceptance.test.ts -t 'Scheduled Run' --reporter=verbose
```

Expected: PASS. The model sees the occurrence instant and frozen instruction exactly once, calls `searchMeetings`, receives normal meeting tools, and receives no schedule-management tools.

- [ ] **Step 7: Run affected Agent and schedule tests**

Run:

```bash
npx vitest run \
  test/agent/injection.test.ts \
  test/agent/run.test.ts \
  test/schedule/worker.test.ts \
  test/contract/team-agent.acceptance.test.ts \
  --reporter=verbose
```

Expected: PASS. Confirm message-triggered scheduling, Scheduled Run business tools, worker terminal delivery, and instruction-boundary tests remain green.

- [ ] **Step 8: Run the full repository verification**

Run:

```bash
npm run verify
```

Expected: PASS for generated Lark validator freshness, both TypeScript checks, all unit/contract tests, and build. This change does not require PostgreSQL integration because it changes no storage, schema, queue, or migration behavior.

- [ ] **Step 9: Inspect scope and commit the implementation**

Run:

```bash
git diff --check
git status --short
git diff -- src/agent/instructions.ts src/agent/invocation-runner.ts test/contract/team-agent.acceptance.test.ts
```

Expected: only the three planned implementation/test files differ from the already committed design and domain documentation; no generated fixture, migration, dependency, or production file changes exist.

Commit:

```bash
git add src/agent/instructions.ts src/agent/invocation-runner.ts test/contract/team-agent.acceptance.test.ts
git commit -m "fix: execute scheduled task occurrences"
```

- [ ] **Step 10: Record the live-acceptance handoff without mutating production**

In the final handoff, state:

```text
Local verification proves the Scheduled Invocation envelope and tool boundary. Production is unchanged. After a separately authorized merge, release, and deployment, verify the existing daily task at its next natural 15:30 Asia/Shanghai occurrence; do not replay the completed occurrence or create an extra test task.
```

Do not push, open a pull request, merge, tag, approve Production, deploy, edit the existing task, or inspect the next live result unless separately authorized.
