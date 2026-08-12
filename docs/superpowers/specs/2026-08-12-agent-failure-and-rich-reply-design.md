# Agent Failure Detail and Rich Reply Design

**Status:** Proposed for implementation  
**Date:** 2026-08-12

## 1. Purpose

Minori currently records a failed Agent Run only as `outcome=failed`, which is
insufficient to investigate transient model or tool failures. It also sends
normal Agent replies as Feishu `text` messages, so Markdown syntax is displayed
literally.

This change adds the smallest useful failure detail and renders ordinary replies
through Feishu's rich-text `post` message with an `md` element.

## 2. Scope

The change has two independent behaviors:

1. persist the caught failure message on the individual Agent Run; and
2. send completed Agent and Scheduled Task replies as Feishu rich-text posts
   generated from Markdown.

It does not redesign the Agent prompt, conversation history, Team Context,
retry policy, progress messages, cards, or the knowledge tools.

In particular, this change does not promise shorter answers or prevent the model
from restating irrelevant context. Prompt and Context architecture are a
separate follow-up so rich rendering and failure diagnostics can be evaluated
without a simultaneous model-behavior change.

## 3. Agent failure detail

Add one nullable, additive `agent_runs.error_message` text column.

When an Agent Run catches an exception that contributes to its terminal result,
the run finalizer stores the caught `Error.message`, truncated to 2,000 Unicode
code points. A non-`Error` rejection is converted to a stable short string
without serializing the rejected object. This includes caught failures that end
as `failed`, `timeout_reached`, `aborted`, or `interrupted_after_write`. Natural
completion and natural step-limit exhaustion leave `error_message` null.

Each retry already creates a separate Agent Run, so no new attempt table or
error-category model is introduced. Operators can inspect each failed attempt's
message alongside its outcome, token usage, tool-call count, and timestamps.

The value is an internal operational diagnostic. It is never added to the
member-facing reply, health endpoint, logs, release records, or model context.
The database may therefore contain provider-supplied diagnostic text and remains
restricted production data. API keys, OAuth tokens, prompts, and tool results
must not be deliberately concatenated into this field by Minori.

The existing daily retention pass clears `error_message` after 30 days while
preserving the Agent Run's structural audit fields. The diagnostic text is not
permanent audit data.

The migration is nullable and additive so the supported previous image can
continue to insert and update Agent Runs during rollback.

## 4. Markdown replies

The Agent continues to produce Markdown. Minori does not implement a general
Markdown parser. The existing bot SDK wraps the bounded reply in a Feishu
`post` payload containing one `md` element. Feishu renders supported headings,
lists, emphasis, links, code, and the appended Sources section instead of
displaying their Markdown markers literally.

Feishu's `md` element is a Markdown subset, not a full CommonMark or GFM
implementation. Unsupported structures such as complex tables, embedded HTML,
and footnotes are passed through for best-effort rendering. Minori does not
implement a compatibility converter or downgrade the entire reply because one
construct is unsupported.

Before building the `post`, the messaging adapter neutralizes Markdown image
syntax into an ordinary labeled link. Rich Content Replies never download or
upload an image URL originating from Agent output. Actual image delivery remains
a separate, explicit media operation outside this change.

The existing SDK remains responsible for Typing reactions, message inspection,
group-history reads, and Control Replies. Control Replies are the short
plain-text progress message, fixed Agent failure message, and delivery-failure
notice; they do not depend on Feishu rich-content rendering.

Normal Agent answers, authenticated Sources, Scheduled Task results, and
budget/interruption receipts that contain operation status or links are Rich
Content Replies and use the SDK `post` path. The same Bot Authority, ordinary
non-topic reply behavior, idempotency key, response validation, and uncertain
delivery rules already used by SDK text messages remain in force.

Lark CLI remains strict-user-only and is not a messaging dependency. Its
Delegated Knowledge Authority does not gain Bot Authority.

## 5. Interfaces and wiring

The messaging boundary exposes semantic operations rather than format-specific
implementation details:

- reply to one message with Rich Content;
- send Rich Content to one chat; and
- send a Control Reply as plain text.

The worker formats the final Agent text and authenticated Sources exactly once,
then passes that Markdown to the completed-reply operation. Scheduled delivery
does the same with its frozen prepared result. The messaging adapter owns the
`post` envelope, Bot Authority, idempotency, and SDK response validation.

## 6. Error handling

- Failure-message persistence shares the existing bounded, fail-closed Agent
  Run finalization. Outcome and `error_message` are written atomically in the
  same update; this change adds no second audit write or weaker failure mode.
- Rich-content rendering or delivery never causes the Agent to run again.
- A confirmed message ID is required before a delivery is treated as sent.
- An ambiguous Rich Content Reply never triggers a plain-text delivery attempt.
- Progress and fixed failure notifications remain Control Replies through the
  SDK plain-text path.

## 7. Verification

Focused tests must prove:

- each failed retry stores its own truncated error message;
- caught timeout, cancellation, and post-write interruption retain their error
  message, while natural step exhaustion does not invent one;
- successful runs retain a null error message;
- error messages are cleared after 30 days without deleting the Agent Run;
- the additive migration preserves previous-image inserts;
- ordinary replies send SDK `post` content with one `md` element, no topic reply,
  and the exact idempotency key;
- Scheduled Task results use SDK rich-content send with the exact target chat;
- authenticated Sources remain clickable after conversion;
- Markdown images become ordinary links and cause no image fetch or upload;
- an ambiguous rich-content completion does not fall back to text and retains
  the existing uncertain-delivery behavior;
- progress and fixed failure replies remain SDK plain text; and
- Lark CLI remains strict-user-only and is never invoked for messaging; and
- no message body, raw SDK response, credential, or OAuth value enters logs.

The full unit, PostgreSQL integration, release-contract, typecheck, build, and
existing message/schedule acceptance gates remain required before release.

## 8. Acceptance

After deployment:

1. one private reply containing a heading, bullets, emphasis, a link, and a code
   block renders without visible Markdown syntax;
2. one knowledge answer displays clickable Sources;
3. one short reply remains visually simple;
4. one controlled failed Agent attempt records a bounded `error_message` without
   exposing it to Feishu; and
5. readiness, ordinary non-topic replies, Typing cleanup, scheduling, and the
   exact deployed image remain healthy.
