# Scheduled Invocation Envelope Design

**Status:** Approved for implementation  
**Date:** 2026-08-14

## Problem

A production Scheduled Run was created, claimed, and delivered successfully, but it performed no business-tool calls. Its frozen instruction began with recurring schedule language such as “每天在下午 3:30…”. The runtime supplied that text unchanged as `[Current Invocation][Scheduled Task]` while correctly omitting schedule-management tools. The model interpreted the due run as a request to create a Scheduled Task and replied that no scheduling tool was available.

The failure is semantic, not a missing business-tool capability. Scheduled Runs already receive the normal knowledge, meeting, source, group-context, Team Context, and typed-write tools. Only task-management tools are intentionally omitted.

## Decision

Wrap every due Scheduled Run in a fixed runtime execution envelope before it reaches the Agent:

- identify the invocation as an already-created task occurrence that is due now;
- direct the Agent to execute the frozen instruction exactly once for this occurrence;
- state that schedule, recurrence, and future-time wording inside the frozen instruction describes the existing task and is not a request to create or modify a task;
- keep the original frozen instruction clearly delimited and otherwise unchanged;
- retain `scheduled_for` as the invocation cutoff and authority-bearing occurrence time.

The envelope is runtime context only. It is not persisted into the Scheduled Task definition or revision and does not rewrite existing tasks.

## Tool boundary

Scheduled Runs continue to receive the same business tools they receive today, including knowledge and meeting tools. They continue to omit:

- `createSchedule`;
- `updateSchedule`;
- `pauseSchedule`;
- `resumeSchedule`;
- `deleteSchedule`.

This prevents an unattended Scheduled Run from changing the team-global task registry. The envelope solves the interpretation problem without expanding authority.

## Data flow

1. The dispatcher creates a Scheduled Run from the frozen task revision.
2. `AgentInvocationRunner.runScheduled` constructs an execution envelope around `run.instruction`.
3. `runKnowledgeAgent` receives the envelope as the one Current Invocation.
4. The model selects available business tools and completes the requested work.
5. The Scheduled Run worker preserves its existing delivery, lease, failure, and no-business-retry behavior.

## Error handling

No new retry or fallback behavior is introduced. If the required business evidence is unavailable, the Agent reports that limitation under the existing tool and reply rules. If execution fails, the existing Scheduled Run terminal outcome and delivery behavior remain authoritative.

## Verification

Add regression coverage at the real scheduled invocation seam:

- a frozen instruction containing recurring schedule language is presented as an already-due execution, not a task-creation request;
- the original instruction appears once inside a clear delimiter;
- schedule-management tools remain absent;
- normal business tools remain available and can be called;
- `scheduled_for`, result target, Scheduled Context, write fencing, delivery, and persisted task instruction remain unchanged.

Run the affected Agent and Scheduled Run tests, then `npm run verify`. No schema, migration, environment, OAuth, permission, or production change is part of this implementation.

## Non-goals

- Rewriting existing task instructions.
- Adding task-management tools to Scheduled Runs.
- Automatically retrying the failed production occurrence.
- Changing calendar calculation, dispatch, catch-up, queueing, delivery, or task ownership.
