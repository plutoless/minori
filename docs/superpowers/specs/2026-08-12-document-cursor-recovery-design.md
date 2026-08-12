# Recover Invalid Document Cursors

**Status:** Approved

## Problem

`fetchDocument` exposes an optional local pagination cursor to the Agent. The
cursor is valid only for the exact document, read mode, and query that produced
it during the current Agent Run. In recent production runs, the Agent supplied a
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
- If the cursor is absent, unknown, or belongs to a different
  document, mode, or query, ignore it and read the first page of the current
  request.
- A matching cursor remains reusable for the lifetime of the Agent Run. Recovery
  does not introduce one-time cursor consumption.
- Recovery is transparent to the model: the result has the same shape as a
  normal first page and contains no recovery marker.
- Recovery must never expose content or continuation state from the cursor's
  former request.

The tool description and cursor schema description state that the first read
must omit `cursor`, and that a continuation must copy the exact `nextCursor`
while keeping `doc`, `mode`, and `query` unchanged. These instructions reduce
avoidable recovery and repeated first-page reads; runtime recovery remains the
backstop rather than relying on model compliance.

The first successful read creates a Document Read Snapshot cached by document
token for that Agent Run. Local page sets and Document Continuation Cursors are
derived from that snapshot and remain keyed by document, mode, and query. This
keeps every page on one document version even if Feishu changes concurrently.
Recovery reuses the requested document's snapshot when available and does not
add an unnecessary Lark request. An append or patch by the same Agent Run
invalidates the affected snapshot, page sets, and cursors before any later read.
All remaining cursor and snapshot state disappears when the Agent Run ends.

## Error Handling

Invalid local cursor state is recoverable and does not throw. Lark CLI failures,
abort signals, output limits, malformed document contracts, and other document
read failures keep their existing behavior. This change does not add a business
retry, Agent replay, or write-side behavior.

Recovery is not logged or persisted because it is a successful local correction,
not a document-read failure. Because the tool succeeds normally, the Agent
receives no local failure to misattribute to Feishu or Lark. Genuine Lark CLI,
contract, timeout, output-limit, and abort failures retain their existing
diagnostic behavior.

## Compatibility and Scope

No schema, migration, environment, permission, OAuth, Lark command, release
protocol, or public messaging change is required. Knowledge search and group
history cursors are unchanged. The change is limited to local document
pagination inside one Agent Run.

## Verification

Tests exercise the public `fetchDocument` tool seam:

1. A first call with an invented cursor returns page one with the normal result
   shape.
2. A cursor from another document, mode, or query restarts the requested read
   and never leaks content from the former request.
3. A valid returned `nextCursor` still reads the next page without recovery.
4. Reusing a matching valid cursor returns the same continuation page.
5. Recovery uses the existing per-document fetch cache where applicable.
6. The model-facing tool contract documents first-read and exact-continuation
   cursor usage.

The focused Agent tool tests, typecheck, full verification suite, and integration
suite must pass before release.
