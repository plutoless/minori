# Team Context and Scheduled Tasks Design

**Date:** 2026-08-10  
**Status:** Approved

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

`Core Policy > Current Invocation > Team Context > Conversation Context`

Precedence resolves contradictory guidance; it does not allow historical content
to authorize new knowledge or delivery work. Team Context is a durable default,
not a second non-overridable policy tier. An explicit Current Invocation may
override it for that run. Anything that must never be overridden belongs in Core
Policy. Current Invocation authorizes primary work in one run. Core Policy
separately permits the narrow Team Context retention side effect described below
when the current message contains clearly stable, team-wide information. For a
scheduled run, the saved task definition is Current Invocation, but Team Context
is always read-only.

Message and scheduled invocations share Agent construction, tools, model limits,
write auditing, and result delivery rules. A schedule is not represented as a
fake Feishu message.

The existing Write Replay Boundary expands from Typed Knowledge Writes to every
**Persistent Agent Write**: a knowledge write, Team Context mutation, or Scheduled
Task create/update/pause/resume/delete. Before any such tool performs its durable
effect, it atomically records the tool run and fences the current invocation.
Later failure never causes whole-run replay. Read, search, and list tools do not
cross the boundary. Scheduled Runs still have no business retry even before the
boundary; this generalization prevents duplicate side effects rather than adding
a retry path.

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

On a timeout, rate limit, or temporary service failure, Minori may use the
last-known-good Team Context Snapshot for at most 24 hours after its successful
fetch and records `team_context_stale`. After that window, or when no successful
snapshot exists, the run continues with Core Policy only and records
`team_context_unavailable`. An explicit permission denial or missing document
invalidates the snapshot immediately rather than entering the stale grace period.
The member is told only when absence or staleness materially affects the response.

Team Context has an independent budget of 8,000 estimated model tokens. It
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

During a member-triggered run, Minori may also autonomously persist a **Durable
Context Assertion**: information that the current member directly states or
explicitly adopts and that is clearly stable, team-wide, and reusable. It does
not ask for confirmation first, but briefly states what it retained in the
reply. Retrieved documents, Live Group History, tool results, and model inference
are not eligible for autonomous retention. They become eligible only when the
current member explicitly asks Minori to retain the retrieved or inferred
conclusion. Scheduled runs never receive a Team Context write tool, even when a
saved task instruction requests that modification. They may suggest a future
change in their result for a member to adopt in a later message run.

The narrow Team Context update tool:

1. reads the current document revision;
2. produces the smallest practical change;
3. checks the revision immediately before writing;
4. re-reads and replans once if the revision changed; and
5. reports a conflict without writing if concurrent change remains.

It crosses the invocation's Write Replay Boundary before the external document
write.

The tool can only edit the configured document. It cannot follow document links,
change sharing, move or delete documents, call arbitrary Lark CLI commands, or
expand Agent authority.

Members may edit the document directly under its ordinary Feishu ACL. Direct
edits become effective on the next successful load. Agent writes retain the
existing tool-run audit and the resulting Feishu revision.

### 4.4 Consolidation and forgetting

Before an Agent-originated update would exceed the 8,000-token budget, Minori may
automatically remove only exact duplicate entries, empty structure, and purely
formatting redundancy whose meaning is mechanically unchanged. It does not
autonomously summarize, merge, or rewrite human-authored meaning to fit the
budget.

If more space requires semantic consolidation, Minori does not add the new
durable content. It presents a proposed document change in the current reply and
writes it only after a member explicitly accepts that meaning. “Forget,” “do not
use,” and equivalent semantic requests already provide that authority and may
remove or revise the active document content. Feishu document revision history
remains the recovery and provenance mechanism, not justification for an
unapproved semantic rewrite.

## 5. Scheduled tasks

### 5.1 Conversational management

Any person who can converse with Minori may create, list, update, pause, resume,
or delete scheduled tasks. There is no maintainer allowlist and no rigid command
syntax.

This deliberately includes external collaborators. A Feishu Delivered Member's
event is sufficient authority to modify Team Context, manage any Scheduled Task,
and select any group target visible to the bot. Minori does not distinguish an
internal tenant member from an external collaborator for these persistent
effects. The product accepts the resulting cross-conversation influence as part
of its open team-agent model.

Scheduled Tasks form one team-global registry. Every Feishu Delivered Member may
list and read every task's name, instruction, creator, source conversation,
schedule, and target, then change, pause, resume, or delete that task from any
conversation. Origin Conversation is provenance and the default result target,
not an access boundary. The product deliberately accepts that task instructions
created in private chat become visible through this global registry.

The Agent receives narrow tools:

- `createSchedule`
- `listSchedules`
- `updateSchedule`
- `pauseSchedule`
- `resumeSchedule`
- `deleteSchedule`

Every lifecycle mutation is a Persistent Agent Write and crosses the invocation's
Write Replay Boundary before changing the task or run state. `listSchedules` is
read-only.

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
- monotonically increasing task version;
- one-time timestamp or validated cron expression;
- IANA timezone, defaulting to `Asia/Shanghai`;
- stable target chat ID and display name;
- optional Scheduled Context chat ID and display name;
- active, paused, in-flight, completed, or deleted state;
- next due time; and
- latest run status.

Names are globally unique, case-insensitively, across active, paused, and in-flight
tasks. A create request that matches an existing non-terminal name writes nothing
and presents that task so the member can modify it or choose another name.
Completed and deleted tasks release the name. Durable mutations always use task
ID and expected version rather than name alone.

User-provided timezone names override the team default and remain attached to the
task. Calendar computation uses timezone rules rather than a fixed UTC offset.
For daylight-saving transitions, a nonexistent local occurrence is skipped and
a repeated local occurrence runs only at its first instant. Offset changes never
create an additional execution.

Every mutation supplies the version that the Agent just read. A version mismatch
writes nothing and returns the latest task. Minori may reapply one minimal change
when concurrent edits affect independent fields; conflicting meanings are
reported to the current member rather than resolved by last-write-wins. Delete,
pause, and resume use the same optimistic concurrency boundary.

Scheduled Run creation freezes the task version, instruction, Calendar Schedule
occurrence, Result Target, and optional Scheduled Context. Ordinary task updates
never rewrite that snapshot while the run is queued or processing; they affect
future occurrences only. Pause or deletion cancels an already-created Scheduled
Run only while its status is `queued`. A processing run is never interrupted or
altered because it may already have crossed its Write Replay Boundary. When an
update leaves a queued old-version run intact, Minori states that fact in the
member-facing response.

A due one-time task enters `in_flight` when its unique Scheduled Run is created.
Pausing that still-queued run marks the task paused and the run cancelled without
starting the Agent. An in-flight one-time task cannot be updated before it is
paused. After pause, a member may update the task; explicit resume then rebinds
the same never-started Scheduled Run ID and occurrence to the new task version
before requeueing it. This does not create a second run or count as an automatic
retry. Once processing begins, the task remains in flight until the run reaches a
terminal outcome. Deleting an in-flight task is terminal but does not abort a
processing run; its eventual outcome is recorded against the deleted task.

For a recurring task, pause cancels a queued occurrence and suppresses every
occurrence during the paused interval. Resume computes the first normal calendar
occurrence strictly after resume time; it does not catch up work deliberately
paused by a member. A deleted task with a processing run retains its global name
reservation until that run is terminal, preventing a new same-name task from
overlapping its final output.

Active, paused, and in-flight tasks retain their complete current definition and
revision history. Deletion is terminal: it immediately prevents future claims and does not
offer an undelete operation. A one-time task becomes `completed` only when its
single Scheduled Run finishes successfully or unsuccessfully; either outcome is
terminal and never makes it active again. Completed and deleted definitions and
prior versions remain for 30 days for audit, then their bodies are purged.
Structural audit fields remain: task ID, actors, timestamps, stable target
identifiers, lifecycle state, and sanitized outcome categories.

The default task list returns active, paused, and in-flight tasks. A member must
explicitly request history to see completed or deleted tasks whose 30-day content
window has not expired.

The first release supports only a deterministic **Calendar Schedule**:

- one explicit timestamp; or
- a basic minute, hour, weekday, month, and day-of-month recurrence that can be
  normalized to one validated five-field cron expression in one IANA timezone.

Natural requests such as “every day at nine,” “Monday at ten,” and “the first of
every month” are eligible. Holidays, business-day inference, timing relative to
another event, and conditional execution are not supported. Minori does not ask
the model to reinterpret the schedule at each run. If the request cannot be
normalized to one unambiguous Calendar Schedule, it does not create the task and
states the limitation.

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

Result Target controls delivery only and never implicitly supplies Live Group
History. A Scheduled Task has no Group Context by default. The member must
semantically request group discussion as input, such as “summarize this group” or
“refer to the Product group discussion,” for Minori to bind an optional
**Scheduled Context**. “This group” resolves to Origin Conversation only when it
is a group; another group uses the same unique-name search and stable-ID binding
as Result Target. Scheduled Context and Result Target may be identical or
different.

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

A scheduled run uses the newest Core Policy and Team Context available when it
begins. It loads Live Group History only when the frozen task version has an
explicit Scheduled Context, bounded by the run's planned `scheduled_for` time
rather than its actual start time. A late catch-up therefore cannot see group
messages sent after the occurrence it represents. It never snapshots Core Policy
or Team Context at task creation time. The stored task instruction is Current
Invocation.

If explicit Scheduled Context cannot load, the run receives a stable
`scheduled_context_unavailable` fact and continues without group background. It
does not substitute Retained Conversation History, because that store contains
only prior invocations and Minori replies rather than the requested ordinary
group discussion.

### 5.5 Missed, failed, and uncertain runs

- A planned time produces at most one Agent Run.
- There is no business retry after an Agent, tool, or delivery failure.
- If the process dies after claiming a Scheduled Run, a recovery sweep marks the
  expired claim terminally failed without invoking the Agent again.
- Knowledge-write start retains the existing durable no-whole-run-replay fence.
- Delivery uses the Scheduled Run ID as the idempotency key.
- An uncertain send is recorded as `delivery_uncertain` and is not resent.
- A failed run sends a concise status to the Result Target when delivery is still
  possible, then waits for the next normal occurrence.
- If Result Target delivery fails, Minori does not retry it. It attempts one
  body-free failure notice to Origin Conversation containing only task identity,
  target display name, planned time, and a sanitized failure category. If Origin
  Conversation is also unreachable, delivery stops and only the audit remains.

After downtime, each task may create only one catch-up run representing the most
recent missed occurrence. Older missed occurrences are folded into audit
metadata. The next regular time remains anchored to the original calendar and
does not drift from catch-up execution.

A Scheduled Task may have at most one queued or processing Scheduled Run. Due
occurrences while that run is unfinished create no additional run; they update
the task's most-recent-missed occurrence. After the active run reaches a terminal
outcome, the dispatcher may create one catch-up run for that latest missed time.
Intermediate occurrences remain audit metadata. Minori allows high-frequency
Calendar Schedules but explains at creation that runs slower than their cadence
will be folded rather than overlapped or accumulated.

Scheduled Runs enter the Durable Conversation Queue using Result Target as their
serialization key. They therefore serialize with member-triggered invocations in
that target conversation. Different Result Targets retain the existing global
four-conversation concurrency, and Scheduled Context does not change the queue
key.

The global four-run limit admits at most one Scheduled Run at a time. A schedule
may start while message runs are processing when capacity is free and no message
is queued. When a slot becomes available and both kinds are queued, a message
invocation is admitted first. A processing Scheduled Run is never preempted by a
new message. Operators have a scheduler kill switch that stops claiming new
Scheduled Runs without deleting task definitions or interrupting a processing
run.

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
**Does not:** know document/tool semantics. Every Persistent Agent Write uses it,
not only Typed Knowledge Writes.

### ResultDelivery

**Does:** preserve existing message reply/reaction behavior and deliver scheduled
results as ordinary top-level messages.  
**Depends on:** the typed Feishu messenger.  
**Does not:** decide task content or rerun uncertain sends.

## 7. Data and audit boundaries

Neon stores only:

- the last-known-good Team Context snapshot and fetch status;
- scheduled run claims and outcomes;
- active, paused, and in-flight Scheduled Task definitions and revisions;
- completed and deleted Scheduled Task bodies for 30 days, followed by structural
  tombstones;
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
- `schedule_name_conflict`
- `schedule_version_conflict`
- `schedule_in_flight_update_requires_pause`
- `scheduled_context_unavailable`
- `scheduled_run_failed`
- `delivery_uncertain`

Raw provider errors, OAuth material, document bodies, model prompts, and chat
history are not placed in logs or schedule audit rows.

## 8. Error handling

- A Team Context outage degrades context, not service readiness or message
  processing.
- A schedule-store outage degrades scheduler readiness but must not disable
  ordinary Feishu messages.
- Invalid cron, nonexistent one-time local timestamps, ambiguous targets, and
  over-budget Team Context updates fail before persistence. A recurring local
  time absent during a daylight-saving transition is valid and skips only that
  occurrence.
- Revision conflicts never overwrite a newer Team Context revision.
- Paused or deleted tasks cannot be claimed after their state transition commits.
- A target chat that becomes inaccessible fails that run without changing the
  task's saved target, then follows the single Origin Conversation failure-notice
  rule.
- Step and time-budget exhaustion use the existing explicit outcomes and never
  cause an automatic scheduled rerun.

## 9. Verification

### Unit and contract tests

- semantic Agent tool availability without a hard-coded conversation workflow;
- context ordering and the rule that only Current Invocation authorizes work;
- Team Context normalization, complete-load behavior, budgeting, stale fallback,
  24-hour expiry, immediate permission/missing-document invalidation, revision
  conflict, exact-duplicate cleanup, approved semantic consolidation, and
  forgetting;
- one-time and cron schedules across timezone and daylight-saving boundaries;
- no autonomous schedule creation without member intent;
- target-name zero, one, and duplicate-match behavior; and
- separation of Result Target from optional Scheduled Context, including no
  implicit history load; and
- scheduled ordinary-message delivery without Typing reaction or reply thread.

### PostgreSQL integration tests

- unique Scheduled Run creation under concurrent dispatchers;
- atomic next-run advancement;
- pause/delete races;
- queued-run cancellation and processing-run immutability;
- run-creation snapshots, queued old-version disclosure, and one-time
  pause-update-resume rebinding;
- concurrent independent and conflicting task edits;
- case-insensitive non-terminal name uniqueness and terminal name reuse;
- one-time in-flight lifecycle, queued pause/resume, terminal completion or
  deletion, 30-day body purge, and permanent structural tombstones;
- recurring pause intervals with no catch-up and deleted in-flight name
  reservation;
- one-most-recent catch-up behavior;
- no per-task overlap and occurrence folding while a run is active;
- serialization between Scheduled Runs and message invocations sharing one
  Result Target;
- one Scheduled Run concurrency, queued-message admission priority, no
  preemption, and scheduler kill-switch behavior;
- no retry after terminal failure;
- scheduled write-start fencing and no replay; and
- Team Context and Scheduled Task mutation fencing under the same no-replay
  boundary;
- delivery idempotency and uncertain-delivery persistence; and
- Result Target failure with one body-free Origin Conversation fallback and no
  further delivery attempt.

### Agent acceptance tests

- a direct Team Context edit affects the next run;
- natural durable intent updates the configured document without exact keywords;
- temporary statements are not automatically retained;
- correction and forgetting change active context while revision history remains;
- a scheduled knowledge read and write use current Team Context and produce audit
  receipts; and
- a Scheduled Run reads group history only from its explicit Scheduled Context
  and never infers it from Result Target; and
- old group history cannot create or mutate a schedule without Current Invocation.

### Live Feishu acceptance

1. Publish and verify the additional `im:chat:read` bot scope.
2. Configure the one Team Context document token.
3. Directly edit the document and verify the next private run uses the revision.
4. Ask naturally to retain, revise, and forget durable context.
5. Create a one-time task targeting the current conversation.
6. Create a recurring task targeting a uniquely named group.
7. Create one task with a distinct explicit Scheduled Context and verify the
   correct `scheduled_for` cutoff.
8. Verify ordinary top-level result delivery, latest context, no retry on failure,
   restart catch-up, and unchanged message-trigger behavior.

## 10. Configuration and operations

New production configuration:

- `TEAM_CONTEXT_DOCUMENT_TOKEN`
- `TEAM_CONTEXT_TOKEN_BUDGET=8000`
- `TEAM_CONTEXT_STALE_MAX_MS=86400000`
- `SCHEDULE_DEFAULT_TIMEZONE=Asia/Shanghai`
- `SCHEDULE_ENABLED=true`
- scheduler poll/lease settings with safe defaults

Health status reports Team Context and scheduler separately. Team Context may be
stale while the core Agent remains ready. Scheduler readiness requires database
access and a healthy dispatcher, but a disabled or degraded scheduler does not
stop the Feishu gateway or message worker. One Scheduled Run concurrency is a
fixed product invariant, not an operator-tunable setting.

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
- natural durable intent can safely update, revise, or forget that context
  without a rigid command flow, while semantic consolidation requires explicit
  acceptance;
- any interlocutor can create and manage one-time or recurring tasks naturally;
- scheduled runs use current rules, context, Agent tools, and existing write
  boundaries;
- downtime creates at most one catch-up run per task;
- failed and uncertain runs are never automatically replayed; and
- existing private/group messaging, non-topic replies, live group history,
  knowledge writes, audit, CI/CD, and production rollback behavior remain intact.
