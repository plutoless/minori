# Agent Failure Detail and Rich Reply Design

**Status:** Proposed for implementation  
**Date:** 2026-08-12

## 1. Purpose

Minori currently records a failed Agent Run only as `outcome=failed`, which is
insufficient to investigate transient model or tool failures. It also sends
normal Agent replies as Feishu `text` messages, so Markdown syntax is displayed
literally.

This change adds the smallest useful failure detail and renders ordinary replies
through the Markdown support already provided by `lark-cli`.

## 2. Scope

The change has two independent behaviors:

1. persist the caught failure message on the individual Agent Run; and
2. send completed Agent and Scheduled Task replies as Feishu rich-text posts
   generated from Markdown.

It does not redesign the Agent prompt, conversation history, Team Context,
retry policy, progress messages, cards, or the knowledge tools.

## 3. Agent failure detail

Add one nullable, additive `agent_runs.error_message` text column.

When an Agent Run finishes unsuccessfully, the run finalizer stores the caught
`Error.message`, truncated to 2,000 Unicode code points. A non-`Error` rejection
is converted to a stable short string without serializing the rejected object.
Successful, budget-limited, cancelled, and otherwise deliberately terminal
runs leave `error_message` null unless they are reached through a caught failure.

Each retry already creates a separate Agent Run, so no new attempt table or
error-category model is introduced. Operators can inspect each failed attempt's
message alongside its outcome, token usage, tool-call count, and timestamps.

The value is an internal operational diagnostic. It is never added to the
member-facing reply, health endpoint, logs, release records, or model context.
The database may therefore contain provider-supplied diagnostic text and remains
restricted production data. API keys, OAuth tokens, prompts, and tool results
must not be deliberately concatenated into this field by Minori.

The migration is nullable and additive so the supported previous image can
continue to insert and update Agent Runs during rollback.

## 4. Markdown replies

The Agent continues to produce Markdown. Minori does not implement its own
Markdown parser. Instead it uses the installed `lark-cli` message shortcuts:

- `im +messages-reply --markdown` for ordinary member-triggered replies; and
- `im +messages-send --markdown` for Scheduled Task delivery.

Both commands use bot identity, preserve the existing ordinary non-topic reply
behavior, and receive the existing idempotency key. The CLI converts Markdown
to Feishu `post` content and performs style optimization. Headings, lists,
emphasis, links, code, tables, and the appended Sources section therefore render
as rich content rather than visible Markdown markers.

The existing SDK remains responsible for Typing reactions, message inspection,
group-history reads, and the short plain-text progress reply. Fixed failure and
budget messages may continue through the same completed-reply Markdown path;
plain text is valid Markdown and renders normally.

If the Markdown CLI path fails, Minori retries the send once through the existing
SDK `text` method using the same idempotency key. This is a rendering fallback,
not an Agent rerun. If neither path yields a confirmed message ID, the existing
Uncertain Reply or Scheduled Delivery behavior remains authoritative; Minori
does not invent a successful delivery.

The Lark message executor uses the existing trusted CLI binary, config/data
directories, bounded child environment, output limit, timeout, JSON envelope
validation, and stable errors. Message bodies and raw CLI output are not logged.

## 5. Interfaces and wiring

The messaging boundary exposes semantic operations rather than format-specific
implementation details:

- reply to one message with completed Markdown;
- send completed Markdown to one chat; and
- send the existing short plain-text progress reply.

The worker formats the final Agent text and authenticated Sources exactly once,
then passes that Markdown to the completed-reply operation. Scheduled delivery
does the same with its frozen prepared result. The messaging adapter owns CLI
conversion, bot identity, idempotency, and the SDK text fallback.

## 6. Error handling

- Failure-message persistence is best effort only within the existing bounded
  Agent Run finalization. A database failure must not replace the original
  member-facing failure behavior or expose the error message.
- Markdown conversion or delivery never causes the Agent to run again.
- The same idempotency key is reused across Markdown and text delivery attempts.
- A confirmed message ID is required before a delivery is treated as sent.
- Progress replies remain short plain text and are unaffected.

## 7. Verification

Focused tests must prove:

- each failed retry stores its own truncated error message;
- successful runs retain a null error message;
- the additive migration preserves previous-image inserts;
- ordinary replies invoke `lark-cli` as bot with `--markdown`, no topic reply,
  and the exact idempotency key;
- Scheduled Task results use Markdown send with the exact target chat;
- authenticated Sources remain clickable after conversion;
- Markdown failure falls back once to SDK text with the same key;
- dual failure retains existing uncertain-delivery behavior;
- progress replies remain SDK plain text; and
- no message body, raw CLI response, credential, or OAuth value enters logs.

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
