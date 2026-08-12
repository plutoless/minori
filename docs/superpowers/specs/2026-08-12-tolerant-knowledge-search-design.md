# Tolerant Knowledge Search Design

**Status:** Approved in conversation

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

- A row is valid when it has a string `entity_type`, an HTTP(S) URL, and a stable
  token from `entity_id` or, as a fallback, `result_meta.token`.
- A valid row uses the existing title fallback order and becomes the existing
  `KnowledgeSearchResult` shape.
- An invalid row is omitted without invalidating other rows.
- An empty raw result array resolves to an empty result array.
- A non-empty raw result array with zero valid rows throws the stable
  `knowledge_search_contract_error` category. It must not appear as an empty
  search result.
- Mixed valid and invalid rows resolve with the valid rows.

The raw CLI response is never passed to the model.

## Read Tool Audit

Knowledge-search executions persist a bounded, content-free audit at the existing
Agent tool-run boundary. The audit may contain only:

- tool name;
- success or failure;
- stable error category;
- raw result count;
- valid result count;
- omitted result count;
- timestamps.

It must not persist the search query, result titles, URLs, tokens, document bodies,
Open IDs, or raw provider errors. A partially valid search is successful and
records its omission count. A completely invalid non-empty response fails with
`knowledge_search_contract_error`.

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

1. the existing `entity_id` shape remains supported;
2. Wiki rows using `result_meta.token` resolve;
3. mixed rows return only valid results;
4. an empty raw result resolves empty;
5. a non-empty, fully invalid response throws
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
