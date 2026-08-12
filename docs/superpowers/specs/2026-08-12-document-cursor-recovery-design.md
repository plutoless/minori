# Recover Invalid Document Cursors

**Status:** Approved

## Problem

`fetchDocument` exposes an optional local pagination cursor to the Agent. The
cursor is valid only for the exact document, read mode, and query that produced
it during the current Agent run. In recent production runs, the Agent supplied a
cursor before any document page had been read. Minori rejected the call with
`invalid_document_cursor`, so no Lark `docs.fetch` command ran even though the
document itself was readable. The Agent then inaccurately described the failure
as a document-interface pagination problem.

An invalid model-supplied cursor must not prevent Minori from returning current
document evidence.

## Decision

Keep the existing `fetchDocument` tool and its local opaque cursors. Treat a
cursor as a continuation hint rather than a prerequisite:

- If the cursor exists and belongs to the exact document, mode, and query, read
  the page it identifies.
- If the cursor is absent, unknown, already consumed, or belongs to a different
  document, mode, or query, ignore it and read the first page of the current
  request.
- A recovered result includes `cursorRecovered: true`. A normal first page and
  a valid continuation omit that field.
- Recovery must never expose content or continuation state from the cursor's
  former request.

The existing Lark document cache remains keyed by document token. Local page
sets remain keyed by document, mode, and query. Recovery therefore reuses an
already fetched copy of the requested document when available and does not add
an unnecessary Lark request.

## Error Handling

Invalid local cursor state is recoverable and does not throw. Lark CLI failures,
abort signals, output limits, malformed document contracts, and other document
read failures keep their existing behavior. This change does not add a business
retry, Agent replay, or write-side behavior.

The recovery marker is model-visible but content-free. It allows the Agent to
understand that Minori restarted from the first page instead of attributing the
event to Feishu or Lark.

## Compatibility and Scope

No schema, migration, environment, permission, OAuth, Lark command, release
protocol, or public messaging change is required. Knowledge search and group
history cursors are unchanged. The change is limited to local document
pagination inside one Agent run.

## Verification

Tests exercise the public `fetchDocument` tool seam:

1. A first call with an invented cursor returns page one and marks recovery.
2. A cursor from another document, mode, or query restarts the requested read
   and never leaks content from the former request.
3. A valid returned `nextCursor` still reads the next page without recovery.
4. Reusing a consumed cursor restarts from page one.
5. Recovery uses the existing per-document fetch cache where applicable.

The focused Agent tool tests, typecheck, full verification suite, and integration
suite must pass before release.
