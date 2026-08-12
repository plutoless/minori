# Tolerant Knowledge Search Design

**Status:** Approved

## Problem

Lark CLI can return successful Wiki search results without `entity_id`. The same
result carries its stable identifier in `result_meta.token`. Minori currently
validates the complete result array against one strict shape, so one incompatible
row rejects the entire search. A recent DEVX Wiki search returned ten usable Wiki
rows but failed as `contract_error` because every row used the alternate token
field.

Read/search compatibility should not have the same all-or-nothing boundary as a
write. Writes remain strict because an ambiguous target can mutate the wrong
document. Reads may preserve independently valid results while explicitly
reporting a completely unrecognizable non-empty response.

## Decision

`LarkKnowledgeService.search` normalizes search results one row at a time.

- A row is valid when it has a string `entity_type` and a stable document
  identifier that `fetchDocument` can consume. The normalized `token` uses the
  current Wiki response field `result_meta.token` when present and falls back to
  the legacy `entity_id` field only when needed.
- A valid row uses the existing title fallback order and becomes a normalized
  `KnowledgeSearchResult` inside a Knowledge Search Result Set. Its `url` is
  included only when the provider supplied a valid HTTP(S) URL; a missing or
  malformed URL does not discard an otherwise fetchable result.
- An invalid row is omitted without invalidating other rows.
- An empty raw result array resolves to a complete Knowledge Search Result Set
  with no results and all counts at zero.
- A non-empty raw result array with zero valid rows throws the stable
  `knowledge_search_contract_error` category. It must not appear as an empty
  search result.
- Mixed valid and invalid rows resolve with the valid rows and bounded
  completeness metadata (`status`, `rawCount`, `validCount`, `omittedCount`).

The Agent receives the normalized results plus completeness metadata, so it may
naturally disclose that a search was partial. The raw CLI response and rejected
row content are never passed to the model.

## Read Tool Audit

Only `searchKnowledge` executions attempt to persist one bounded, content-free
Knowledge Search Audit in the existing `tool_runs` table. This is a single
post-outcome insert, not a `beginWrite` / `finishWrite` lifecycle, and it must not
mark the Write Replay Boundary. No schema migration is required. The audit uses:

- `tool_name = searchKnowledge`;
- `success = true` for complete or partial usable results, otherwise `false`;
- `error_category = knowledge_search_contract_error` only for the fully invalid
  non-empty result;
- `sanitized_summary = raw=<n> valid=<n> omitted=<n>`;
- the timestamps already present on `tool_runs`.

It must not persist the search query, result titles, URLs, tokens, document bodies,
Open IDs, or raw provider errors. A partially valid search is successful and
records its omission count. A completely invalid non-empty response fails with
`knowledge_search_contract_error`.

Knowledge Search Audit persistence is best-effort. If PostgreSQL cannot store the
audit but the search itself succeeds, Minori returns the valid results to the
Agent and emits only the stable operational category `search_audit_unavailable`.
If the search itself fails, an audit failure must not replace its stable search
error category. Write audit remains fail-closed and unchanged.

Other read tools (`fetchDocument`, space/node listing, and node lookup) remain out
of scope. They may adopt the same pattern in a later independently designed change.

No new member-facing workflow or intent classifier is introduced. The Agent may
continue naturally with partial results and may explain a complete tool failure.

## Unchanged Boundaries

- Document fetch and every write path keep their existing strict contracts.
- Write audit, conflict handling, retry behavior, idempotency, and delivery are
  unchanged.
- Lark CLI remains the user-authority boundary; Bot Authority does not gain Wiki
  access.
- No raw search response is stored in PostgreSQL or added to the prompt.

## Public Test Seams

### `LarkKnowledgeService.search`

Tests use literal provider fixtures and verify:

1. Wiki rows using `result_meta.token` resolve;
2. the legacy `entity_id` shape remains supported as a fallback;
3. when both identifiers exist, `result_meta.token` is used;
4. a valid token with a missing or malformed URL remains usable without a URL;
5. mixed rows return only valid results and accurate completeness metadata;
6. an empty raw result resolves as a complete empty result set;
7. a non-empty, fully invalid response throws
   `knowledge_search_contract_error`.

### Agent tool audit boundary

Tests verify:

1. partial omission remains a successful tool result with cumulative counts;
2. a fully invalid response persists the stable failure category;
3. persisted audit data contains none of the forbidden content-bearing fields.

## Production Verification

After the normal reviewed release path, rerun the same bounded DEVX Wiki search
probe that currently deterministically produces `contract_error`. It must return
one or more normalized results, and its audit must contain only counts and the
stable success/failure fields above. Production verification must not print or
persist result bodies, titles, URLs, tokens, identities, OAuth material, or
environment values.
