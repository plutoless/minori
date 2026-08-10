# Team Context and Scheduled Tasks Design

**Date:** 2026-08-10  
**Status:** Draft for user review

## 1. Purpose

Extend Minori with two related capabilities without constraining its open-ended
conversation model:

1. one durable, team-wide context comparable to a shared `AGENTS.md`; and
2. one-time and recurring tasks that execute the existing Agent in the future.

The design keeps model judgment open while making context authority, persistent
side effects, scheduling, replay, and delivery deterministic.

## 2. Current fixed points

The implementation must preserve these existing product decisions:

- Any Feishu-delivered private message can invoke Minori. In an ordinary group,
  direct mentions and direct replies invoke it.
- The Agent has no mandatory conversational workflow.
- Knowledge access uses the dedicated Lark user and the existing narrow read and
  write tools.
- Knowledge writes do not require per-write confirmation. They remain typed,
  conflict-aware, fenced against replay, and audited.
- Group history is live Feishu context and is not mirrored into Neon.
- Conversation content expires after 30 days.
- One Agent Run has a maximum of 40 steps and 300 seconds.
- Topic replies remain unsupported; scheduled results are ordinary messages.

## 3. Chosen architecture

Use a unified **context source + invocation source** architecture.

Every Agent Run is built from:

1. **Core Policy** — immutable repository-owned identity, authority, tool, audit,
   and replay boundaries.
2. **Team Context** — one configured Feishu document containing the team's
   durable terminology, preferences, facts, decisions, and working agreements.
3. **Conversation Context** — retained private history or live group history.
4. **Current Invocation** — the current Feishu message or the saved scheduled-task
   instruction.

Conflict precedence is:

`Core Policy > Team Context > Current Invocation > Conversation Context`

Precedence resolves contradictory guidance; it does not allow historical content
to authorize new knowledge or delivery work. Current Invocation authorizes that
primary work in one run. Core Policy separately permits the narrow Team Context
retention side effect described below when the current message contains clearly
stable, team-wide information. For a scheduled run, the saved task definition is
Current Invocation; scheduled runs do not autonomously retain new Team Context.

Message and scheduled invocations share Agent construction, tools, model limits,
write auditing, and result delivery rules. A schedule is not represented as a
fake Feishu message.

## 4. Unified Team Context

### 4.1 Authority and representation

There is no separate user-facing rules database or long-term-memory database.
One Feishu document is the sole team-owned long-term context.

The document may use natural Markdown or rich-text headings such as:

```text
# Team Context

## Working agreements
- Answer weekly-report questions with conclusions first, then sources.

## Terminology
- Weekly Review means the PMO team weekly report.

## Confirmed decisions
- Unqualified schedule times use Asia/Shanghai.

## Stable preferences
- Do not use Feishu topic replies.
```

The configured document token is stable. Minori never locates it by title and
never recursively treats linked documents as instructions.

### 4.2 Reading and last-known-good behavior

Every Agent Run attempts to load the latest complete document revision. On
success, Minori stores a last-known-good normalized snapshot in Neon with:

- document token;
- source revision;
- normalized content;
- estimated token count; and
- fetched timestamp.

If a later read fails, Minori uses the last-known-good snapshot and records
`team_context_stale`. If no successful snapshot exists, the run continues with
Core Policy only and records `team_context_unavailable`. The member is told only
when the absence or staleness materially affects the response.

Team Context has an independent budget of approximately 8,000 model tokens. It
is never silently truncated. A directly edited over-budget revision is rejected
as a new active snapshot; Minori continues using last-known-good and reports that
the document needs consolidation.

### 4.3 Natural updates

Members do not need exact commands such as “remember this.” Minori may update
Team Context when the member's meaning is durably future-facing, for example:

- “以后周报都先给结论。”
- “下次记得 Weekly Review 就是 PMO 周报。”
- “这个决定以后都有效。”
- “不要再沿用旧的发布说明。”

Literal keyword matching is not the decision rule. Temporary discussion,
unconfirmed guesses, and one-off task details are not promoted merely because
they contain words such as “记住”.

During a member-triggered run, Minori may also autonomously persist information
that is clearly stable, team-wide, and reusable. It does not ask for confirmation
first, but briefly states what it retained in the reply. Scheduled runs never
autonomously modify Team Context unless their saved task instruction explicitly
requests that modification.

The narrow Team Context update tool:

1. reads the current document revision;
2. produces the smallest practical change;
3. checks the revision immediately before writing;
4. re-reads and replans once if the revision changed; and
5. reports a conflict without writing if concurrent change remains.

The tool can only edit the configured document. It cannot follow document links,
change sharing, move or delete documents, call arbitrary Lark CLI commands, or
expand Agent authority.

Members may edit the document directly under its ordinary Feishu ACL. Direct
edits become effective on the next successful load. Agent writes retain the
existing tool-run audit and the resulting Feishu revision.

### 4.4 Consolidation and forgetting

Before an Agent-originated update would exceed the 8,000-token budget, Minori may
consolidate duplicate, superseded, or verbose material in the same document.
Consolidation is a visible document revision, not a hidden memory rewrite.

If Minori cannot preserve the meaning reliably, it does not add the new durable
content and asks for human consolidation. “Forget,” “do not use,” and equivalent
semantic requests remove or revise the active document content; Feishu document
revision history remains the recovery and provenance mechanism.

## 5. Scheduled tasks

### 5.1 Conversational management

Any person who can converse with Minori may create, list, update, pause, resume,
or delete scheduled tasks. There is no maintainer allowlist and no rigid command
syntax.

The Agent receives narrow tools:

- `createSchedule`
- `listSchedules`
- `updateSchedule`
- `pauseSchedule`
- `resumeSchedule`
- `deleteSchedule`

Minori may call `createSchedule` only when a member semantically requests future,
recurring, reminder, or follow-up execution. It may suggest a schedule, but may
not persist one autonomously.

Every successful create or change response states the task name, normalized
schedule, timezone, delivery target, and next run time.

### 5.2 Stored task

Each scheduled task stores:

- stable task ID and natural-language name;
- immutable creator identity and source conversation for audit;
- current task instruction;
- one-time timestamp or validated cron expression;
- IANA timezone, defaulting to `Asia/Shanghai`;
- stable target chat ID and display name;
- enabled, paused, or deleted state;
- next due time; and
- latest run status.

User-provided timezone names override the team default and remain attached to the
task. Calendar computation uses timezone rules rather than a fixed UTC offset.

### 5.3 Delivery target resolution

Results default to the conversation in which the task was created. A member may
explicitly name another group.

Minori resolves an alternate target by searching groups visible to the bot. The
official Feishu permission required for searching groups visible to a user or
bot is `im:chat:read` (see the official
[Feishu scope registry](https://open.feishu.cn/document/server-docs/application-scope/scope-list)).
No match or more than one exact-name match prevents task creation and asks the
member to clarify. Once selected, the task stores `chat_id`; it does not repeat
name-based guessing at run time.

Cross-conversation targeting is group-only. A task created in private chat may
continue to report to that same private chat, but a member cannot select another
person's private chat by name.

### 5.4 Durable scheduling

Neon is the scheduler's source of truth. The service contains:

- `ScheduleStore` for task definitions and next-run state;
- `ScheduleDispatcher` for due-task claiming and calendar calculation;
- `ScheduledRunStore` for one durable record per planned execution; and
- `ScheduledTaskWorker` for executing claimed runs.

The uniqueness boundary is `(schedule_id, scheduled_for)`. Multiple service
instances may poll concurrently, but only one Scheduled Run can exist for one
planned time.

For each due task, the dispatcher atomically:

1. creates the Scheduled Run;
2. advances the task to its next calendar time; and
3. makes the run available to the worker.

A scheduled run uses the newest Core Policy, Team Context, and target Group
Context available when it begins. It never snapshots those sources at task
creation time. The stored task instruction is Current Invocation.

### 5.5 Missed, failed, and uncertain runs

- A planned time produces at most one Agent Run.
- There is no business retry after an Agent, tool, or delivery failure.
- If the process dies after claiming a Scheduled Run, a recovery sweep marks the
  expired claim terminally failed without invoking the Agent again.
- Knowledge-write start retains the existing durable no-whole-run-replay fence.
- Delivery uses the Scheduled Run ID as the idempotency key.
- An uncertain send is recorded as `delivery_uncertain` and is not resent.
- A failed run sends a concise status to the target when delivery is still
  possible, then waits for the next normal occurrence.

After downtime, each task may create only one catch-up run representing the most
recent missed occurrence. Older missed occurrences are folded into audit
metadata. The next regular time remains anchored to the original calendar and
does not drift from catch-up execution.

Scheduled runs use the normal Agent maximum of 40 steps and 300 seconds.

## 6. Runtime module boundaries

### TeamContextSource

**Does:** load, normalize, budget-check, cache, and update the one configured
Feishu document.  
**Depends on:** the typed Lark knowledge adapter and a last-known-good store.  
**Does not:** schedule work or expose arbitrary document operations.

### ContextAssembler

**Does:** construct the ordered Core Policy, Team Context, Conversation Context,
and Current Invocation input for one run.  
**Depends on:** TeamContextSource and existing conversation/group sources.  
**Does not:** persist memories or execute tools.

### ScheduleStore and ScheduledRunStore

**Does:** persist tasks, calendar state, claims, outcomes, and deduplication.  
**Depends on:** PostgreSQL.  
**Does not:** interpret natural language or call the model.

### ScheduleDispatcher

**Does:** claim due tasks, collapse missed times, and create Scheduled Runs.  
**Depends on:** ScheduleStore, database time, and a timezone-aware cron library.  
**Does not:** run the Agent.

### AgentInvocationRunner

**Does:** execute either a message or scheduled invocation against one common
Agent and tool set.  
**Depends on:** ContextAssembler, model, KnowledgeService, AgentRunStore, and an
invocation-specific replay fence.  
**Does not:** fabricate Feishu message events.

### InvocationFence

**Does:** atomically mark write start and prevent whole-run replay for one claimed
message or Scheduled Run.  
**Depends on:** the appropriate durable source record.  
**Does not:** know document/tool semantics.

### ResultDelivery

**Does:** preserve existing message reply/reaction behavior and deliver scheduled
results as ordinary top-level messages.  
**Depends on:** the typed Feishu messenger.  
**Does not:** decide task content or rerun uncertain sends.

## 7. Data and audit boundaries

Neon stores only:

- the last-known-good Team Context snapshot and fetch status;
- schedule definitions;
- scheduled run claims and outcomes;
- Agent and tool audit records; and
- stable target identifiers and sanitized error categories.

The live Team Context body remains authoritative in Feishu. Feishu revision
history is the content provenance mechanism. Existing live group message bodies,
speaker names, and member Open IDs remain transient and are not mirrored into
Neon beyond current retained-invocation rules.

Required sanitized outcome categories include:

- `team_context_loaded`
- `team_context_stale`
- `team_context_unavailable`
- `team_context_over_budget`
- `team_context_conflict`
- `schedule_target_not_found`
- `schedule_target_ambiguous`
- `scheduled_run_failed`
- `delivery_uncertain`

Raw provider errors, OAuth material, document bodies, model prompts, and chat
history are not placed in logs or schedule audit rows.

## 8. Error handling

- A Team Context outage degrades context, not service readiness or message
  processing.
- A schedule-store outage degrades scheduler readiness but must not disable
  ordinary Feishu messages.
- Invalid cron, nonexistent local times, ambiguous targets, and over-budget Team
  Context updates fail before persistence.
- Revision conflicts never overwrite a newer Team Context revision.
- Paused or deleted tasks cannot be claimed after their state transition commits.
- A target chat that becomes inaccessible fails that run without changing the
  task's saved target.
- Step and time-budget exhaustion use the existing explicit outcomes and never
  cause an automatic scheduled rerun.

## 9. Verification

### Unit and contract tests

- semantic Agent tool availability without a hard-coded conversation workflow;
- context ordering and the rule that only Current Invocation authorizes work;
- Team Context normalization, complete-load behavior, budgeting, stale fallback,
  revision conflict, update, consolidation, and forgetting;
- one-time and cron schedules across timezone and daylight-saving boundaries;
- no autonomous schedule creation without member intent;
- target-name zero, one, and duplicate-match behavior; and
- scheduled ordinary-message delivery without Typing reaction or reply thread.

### PostgreSQL integration tests

- unique Scheduled Run creation under concurrent dispatchers;
- atomic next-run advancement;
- pause/delete races;
- one-most-recent catch-up behavior;
- no retry after terminal failure;
- scheduled write-start fencing and no replay; and
- delivery idempotency and uncertain-delivery persistence.

### Agent acceptance tests

- a direct Team Context edit affects the next run;
- natural durable intent updates the configured document without exact keywords;
- temporary statements are not automatically retained;
- correction and forgetting change active context while revision history remains;
- a scheduled knowledge read and write use current Team Context and produce audit
  receipts; and
- old group history cannot create or mutate a schedule without Current Invocation.

### Live Feishu acceptance

1. Publish and verify the additional `im:chat:read` bot scope.
2. Configure the one Team Context document token.
3. Directly edit the document and verify the next private run uses the revision.
4. Ask naturally to retain, revise, and forget durable context.
5. Create a one-time task targeting the current conversation.
6. Create a recurring task targeting a uniquely named group.
7. Verify ordinary top-level result delivery, latest context, no retry on failure,
   restart catch-up, and unchanged message-trigger behavior.

## 10. Configuration and operations

New production configuration:

- `TEAM_CONTEXT_DOCUMENT_TOKEN`
- `TEAM_CONTEXT_TOKEN_BUDGET=8000`
- `SCHEDULE_DEFAULT_TIMEZONE=Asia/Shanghai`
- scheduler poll/lease settings with safe defaults

Readiness reports Team Context and scheduler separately. Team Context may be stale
while the core Agent remains ready. Scheduler readiness requires database access
and a healthy dispatcher, but a scheduler failure does not stop the Feishu
gateway or message worker.

The feature ships through the existing protected GitHub release path. Database
migrations are additive and remain compatible with the current rollback floor.

## 11. Delivery sequence

Implementation remains one design but ships in two independently testable
product slices:

1. **Team Context slice** — extract ContextAssembler, add the configured Feishu
   document source, last-known-good persistence, natural updates, budgeting, and
   live acceptance while leaving message behavior otherwise unchanged.
2. **Scheduled Tasks slice** — add the task/run stores, dispatcher, scheduled
   invocation fence, ordinary result delivery, chat-name resolution, restart
   catch-up, and live acceptance on top of the established ContextAssembler.

The scheduler is not enabled in production until the Team Context slice and the
shared invocation refactor are already healthy. Each slice uses additive schema
migrations and its own rollback-compatible release candidate.

## 12. Explicit non-goals

- A web administration console.
- A separate vector-memory database.
- Per-group or per-user long-term memory.
- Per-tool permission selection for schedules.
- Multi-step workflow graphs or dependencies between tasks.
- Autonomous schedules created without member future intent.
- Automatic retries of failed scheduled Agent runs.
- Selecting another person's private chat as a result target.
- Raw SQL, arbitrary HTTP, shell, filesystem, permission, or unrestricted Lark
  CLI tools.

## 13. Success criteria

The design is successful when:

- one human-readable Feishu document provides all team-wide durable context;
- every run receives the complete active document within its independent budget;
- natural durable intent can safely update, revise, consolidate, or forget that
  context without a rigid command flow;
- any interlocutor can create and manage one-time or recurring tasks naturally;
- scheduled runs use current rules, context, Agent tools, and existing write
  boundaries;
- downtime creates at most one catch-up run per task;
- failed and uncertain runs are never automatically replayed; and
- existing private/group messaging, non-topic replies, live group history,
  knowledge writes, audit, CI/CD, and production rollback behavior remain intact.
