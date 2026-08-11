# Current Evidence and Delayed Progress Reply Design

**Date:** 2026-08-11  
**Status:** Proposed  
**Audience:** Minori maintainers and operators

## Summary

Minori currently has two adjacent product gaps:

1. retained conversation history can contain an old tool failure, permission claim,
   version string, or audit result, and the model can accidentally present that old
   material as a fact about the current run; and
2. a genuinely long member-triggered run shows only the temporary `Typing` reaction,
   so the member receives no textual acknowledgement while waiting.

This change adds a narrow evidence rule to the Agent instructions and one durable,
best-effort progress reply after 20 seconds. It does not add an intent classifier,
scenario router, staged conversation protocol, progress percentages, or periodic
status updates. The Agent retains open-ended control over whether and how to use its
tools.

Scheduled Tasks are unchanged. The progress reply applies only to ordinary private
and group messages triggered by a member.

## Goals

- Stop historical context from being stated as a current knowledge read, current
  permission/scope failure, or current system/version fact without current-run
  evidence.
- Preserve the Agent's ability to choose tools and answer directly.
- Give a member one plain-language acknowledgement when an ordinary request is still
  running after 20 seconds.
- Keep final-reply delivery, retries, retained history, and the existing `Typing`
  reaction contract intact.
- Make the progress reply best-effort, non-blocking, deduplicated, and auditable
  without retaining another copy of its fixed body.

## Non-goals

- Deterministic intent classification or mandatory tool routing.
- Runtime parsing of the model's claims.
- A multi-stage progress protocol, editable status card, percentage, ETA, tool name,
  chain-of-thought, or periodic heartbeat message.
- A separate queue-notification dispatcher for events that have not yet been claimed
  by a worker.
- Any change to Scheduled Task execution or delivery.
- Retaining the progress reply in conversation history.

## Evidence semantics

### Historical context is historical

`Retained Conversation History`, `Live Group History`, Team Context, retrieved
documents, and prior tool results remain useful background. They do not prove that a
fact is current merely because it appeared in an earlier message.

The Agent instructions will establish these rules by meaning rather than by requiring
fixed response wording:

- Claims about the current state of team knowledge, the latest contents of a resource,
  current permissions/scopes, the current Lark CLI or runtime version, and current
  read failures require evidence returned by a tool in the current Agent run.
- If the Agent has not re-read a historical result, it may still discuss it, but must
  identify it as historical, previously observed, or not currently verified.
- Only an error actually returned by a current-run tool may be described as a current
  read or permission failure. The Agent uses the stable error category exposed by the
  tool and must not guess missing scopes, product permissions, or remediation details.
- When a request depends on live knowledge, the Agent should use the available tools.
  If it elects not to or cannot obtain current evidence, it must state that the answer
  is not currently verified rather than inventing a live result.

These are epistemic boundaries inside the system instructions, not a hard-coded
workflow. The runtime does not classify the request, force a particular tool, count
citations, or reject a response based on text matching.

### Current-run evidence remains bounded

Tool results remain the existing typed, bounded, sanitized results. This design does
not expose raw provider errors, OAuth material, hidden identifiers, or additional
authority to the model. Existing source-link handling remains unchanged.

## Delayed progress reply

### Member-visible behavior

For an ordinary member-triggered private or group event, Minori sends at most one
progress reply if the event has not reached final reply delivery 20 seconds after its
durable queue admission time.

The fixed initial copy is:

> 我还在处理这条请求，完成后会继续回复。

It is an ordinary non-topic reply to the triggering message, matching the
existing final-reply surface. It contains no tool name, internal state, reasoning,
percentage, or ETA.

The existing `Typing` reaction remains the immediate durable-receipt acknowledgement.
If an event waits unclaimed in the database queue, Minori shows only `Typing`. Once a
worker claims it:

- when less than 20 seconds have elapsed since `received_at`, the worker schedules the
  progress attempt for the remaining time; or
- when 20 seconds or more have already elapsed, the worker attempts it immediately.

This deliberately avoids a second queue dispatcher and the associated ownership and
recovery protocol.

### Ordering and cancellation

The worker owns a single progress timer/promise for the claimed event.

- If final reply delivery is ready before the timer fires, the timer is cancelled and
  no progress attempt is recorded.
- Before sending progress, the worker atomically marks the attempt only when the same
  claim is still processing, no final reply has started, and no progress attempt was
  previously recorded.
- If progress sending has already started, the worker waits for that bounded attempt
  to settle before it begins final reply delivery. Therefore the final reply cannot
  overtake an in-flight progress reply in the same worker process.
- A progress failure never changes the Agent outcome and never causes Agent or final
  reply retry.

The progress attempt uses its own fixed idempotency key derived from the event ID,
separate from the final reply key.

### Crash and retry behavior

The attempt marker is persisted before the Feishu call. Once an attempt exists, no
later worker attempt sends the progress reply again. Consequently:

- a crash before the durable attempt marker may omit the progress reply;
- a crash after the durable marker may leave its delivery outcome unknown; and
- recovery does not duplicate the progress reply in either case.

This is intentionally best-effort. It favors at-most-once visible progress over a
more complex confirmation/replay protocol. Final reply recovery and its existing
idempotency window remain unchanged.

## Persistence model

Add nullable, additive fields to `processed_events`:

- `progress_idempotency_key`
- `progress_attempted_at`
- `progress_message_id`
- `progress_error_code`

Interpretation:

- no `progress_attempted_at`: not attempted;
- `progress_attempted_at` plus `progress_message_id`: sent and confirmed;
- `progress_attempted_at` plus a stable `progress_error_code`: failed;
- `progress_attempted_at` with neither result: delivery outcome unknown after an
  interruption.

The body is fixed in code and is not stored in `processed_events`. The progress reply
is not appended to the `messages` table and therefore never enters Retained
Conversation History. Existing 30-day event retention applies to its metadata.

Store operations must be claim-attempt fenced, as the existing final reply and write
boundaries are. A late timer from an expired claim cannot mark or send progress for a
replacement claim.

## Failure handling and observability

Progress delivery catches provider failures and records only a stable category such
as `progress_reply_failed`. Raw response bodies, secrets, message content, member
identity, and provider errors are not logged or persisted.

The worker may log body-free fields already allowed for event diagnostics: event ID,
claim attempt, progress status, and stable error category. A failed progress reply
does not affect readiness and does not mask a final reply failure.

The evidence-rule change adds no new audit schema. Current tool calls and their
existing run/tool audits remain the evidence trail.

## Testing strategy

### Agent instruction and behavior contracts

- A retained old permission failure cannot be represented by the prompt as current
  evidence.
- A current successful knowledge read is compatible with a current answer and not
  with a fabricated current read failure.
- Without a current tool result, current permission, version, scope, latest-state, and
  live-read claims must be described as unverified or historical.
- Existing open-ended tool selection, knowledge writes, group context, private
  retained history, and Scheduled Task instructions remain intact.

These tests should assert the instruction semantics and deterministic model/tool
fixtures, not require exact member-facing prose.

### Worker and store contracts

- completion before 20 seconds sends no progress reply;
- a run beyond 20 seconds sends exactly one progress reply;
- a worker claim after the threshold attempts progress immediately;
- progress failure still permits one normal final reply;
- an in-flight progress send settles before final reply sending begins;
- progress and final reply use distinct stable idempotency keys;
- worker retry/restart never duplicates an attempted progress reply;
- a stale claim cannot mark or send progress after lease recovery;
- progress metadata is persisted without the fixed body;
- progress replies are absent from Retained Conversation History;
- Scheduled Task runs never use this path.

PostgreSQL integration tests cover the conditional attempt marker and stale-claim
race. Worker tests use a controllable clock and deferred messenger promises rather
than wall-clock sleeps.

## Rollout

1. Add the nullable migration and store operations.
2. Add the evidence semantics to the Agent instructions and its contract tests.
3. Add the worker timer, progress send, ordering, and recovery tests.
4. Run full unit, PostgreSQL integration, build, and release-contract verification.
5. Release through the existing tag-based CI/CD path.
6. Live-check one fast request (no progress reply) and one deliberately slow request
   (one progress reply followed by one final reply), without retaining message bodies
   in acceptance evidence.

## Alternatives considered

### Evidence rule only

This fixes the inaccurate-current-fact failure but leaves genuinely long runs with no
textual acknowledgement. It is smaller but does not address the user's second
reported problem.

### Editable status message

Creating one status message and editing it into the final response can look cleaner,
but adds edit permissions, message-version recovery, and uncertain update outcomes.
It is unnecessary for a single delayed acknowledgement.

### Periodic progress updates

Repeated status replies introduce noise and require progress semantics the runtime
cannot truthfully infer from an open-ended tool loop. They are explicitly outside this
design.
