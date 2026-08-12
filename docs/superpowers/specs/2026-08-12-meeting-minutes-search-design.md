# Meeting Minutes Search Design

**Status:** Proposed  
**Date:** 2026-08-12

## Summary

Minori can currently search the Dedicated Knowledge User's visible cloud documents and read Wiki or document content, but it has no typed capability for Feishu Minutes. This causes it to describe its access as limited to knowledge bases and to reject questions about meeting content outside Wiki even when the Dedicated Knowledge User can read the relevant Minutes.

Minori will add two read-only Agent tools backed by the existing official `lark-cli` user identity:

- `searchMeetingMinutes` searches Minutes visible to the Dedicated Knowledge User.
- `fetchMeetingTranscript` reads the transcript of one selected Minute.

For meeting-related questions, the Agent may use both the existing cloud-document search and the new Minutes search, then independently synthesize evidence from the successfully fetched sources. The application does not hard-code a mandatory search sequence. It keeps the existing open-ended Agent loop and expands only its typed read capability.

## Goals

- Let Minori actively search all Minutes visible to the existing OAuth user by keyword and optional time range.
- Let Minori read the most relevant transcripts without requiring a pasted Minute URL.
- Let meeting answers combine ordinary cloud documents and Minutes, with explicit source type, title, time, and URL.
- Preserve the existing Dedicated Knowledge User authority model.
- Keep transcripts transient to one Agent Run and outside Neon.
- Degrade per source so one unavailable Minute does not invalidate other Minutes or document evidence.

## Non-goals

- Organization-administrator or tenant-wide access beyond the OAuth user's own visibility.
- Searching or reading private Minutes the Dedicated Knowledge User cannot access.
- Editing Minute titles, summaries, speakers, words, or todos.
- Downloading Minute audio or video.
- Uploading media to create Minutes.
- Automatically applying for Minute permissions.
- Calendar event search, meeting attendance management, or meeting-bot participation.
- A second OAuth implementation, direct access-token management, generic HTTP tool, or raw OpenAPI escape hatch.
- Persisting transcripts, transcript excerpts, raw search results, participant identities, or local transcript paths in Neon.
- Building a separate meeting-content index.

## Authority and Permissions

All Minutes operations run through the existing official `lark-cli` installation with `--as user`. The effective identity remains the Dedicated Knowledge User used for Docs, Drive, and Wiki. A result is readable only when that user can access it under Feishu's own resource permissions.

The application requests only these additional user scopes:

- `minutes:minutes.search:read`
- `minutes:minutes.basic:read`
- `minutes:minutes.transcript:export`

The OAuth command keeps the existing Docs, Drive, and Wiki domains and adds these explicit scopes. It does not request the complete Minutes domain because that domain also contains write and media capabilities outside this feature.

The app permissions must be added and published in the Feishu developer console before the production user reauthorizes. Production uses the existing persistent Lark credential store; there is no second token store.

## Typed Lark Boundary

The command catalog adds only two read commands:

1. `minutes.search`
   - Maps to `lark-cli minutes +search`.
   - Always supplies `--as user --format json`.
   - Accepts a bounded query, optional ISO 8601 start/end times, page size, and an application-owned continuation reference.
   - Never accepts arbitrary CLI arguments.

2. `minutes.detail`
   - Maps to `lark-cli minutes +detail --transcript`.
   - Always supplies `--as user --format json`.
   - Accepts one validated Minute token and a run-owned output directory.
   - Does not enable summary, todo, chapter, keyword, media, upload, update, permission, speaker, or word-replacement operations.

The Agent never receives a shell, a raw `lark-cli api` command, an access token, a local path, or arbitrary provider parameters.

## Agent Tools

### `searchMeetingMinutes`

Input:

- `query`: optional keyword, bounded to the provider limit.
- `start`: optional ISO 8601 lower time bound.
- `end`: optional ISO 8601 upper time bound.
- `cursor`: optional opaque Agent-Run-local continuation cursor.

Output:

- normalized Minute token;
- title or bounded display text;
- meeting/create time when returned;
- canonical Minute URL;
- an opaque `nextCursor` when another page exists.

The first request omits `cursor`. Provider page tokens never enter model context. Minori binds each opaque cursor to the exact query and time-range tuple for the current Agent Run. An unknown, expired, cross-run, or mismatched cursor transparently restarts the requested search at page one rather than throwing an Agent-visible cursor error.

### `fetchMeetingTranscript`

Input:

- `minuteToken`: a token returned by the current run's search or extracted from a valid Feishu Minute URL.
- `cursor`: optional opaque cursor returned by the preceding page for the same transcript snapshot.

Output:

- bounded transcript text for the requested page;
- speaker names and timestamps when present;
- source title, meeting time, and canonical URL;
- an opaque `nextCursor` when more transcript content remains.

The first successful fetch creates a Document-like Transcript Snapshot scoped to one Agent Run. Repeated reads use the cached snapshot and do not mix pages from different fetches. A valid continuation cursor remains reusable inside that run. An unknown or mismatched cursor restarts at the first page of the requested transcript. No transcript cursor survives the Agent Run.

## Unified Meeting Evidence

The existing `searchKnowledge` tool already searches cloud documents visible to the Dedicated Knowledge User; it is not a Wiki-only capability. Agent instructions will state that meeting-related questions may require both:

- `searchKnowledge` for ordinary meeting notes stored as Feishu documents or Wiki nodes;
- `searchMeetingMinutes` for Feishu Minutes;
- the corresponding fetch tool before treating a result as verified evidence.

Search-result titles and snippets are discovery metadata, not evidence. The Agent must fetch content before relying on it. The Agent may search the two sources in any useful order or concurrently. It may read at most five Minutes per Agent Run, selecting the most relevant results within the existing step, time, and context budgets.

The final answer distinguishes `Feishu document` and `Feishu Minute` sources and includes a canonical link for each source actually used. Duplicate URLs or tokens are collapsed before synthesis.

## Transcript Files and Context Window

`lark-cli minutes +detail --transcript` writes transcript artifacts to an output directory. Minori creates a unique, non-symlinked temporary directory owned by the runtime user for each transcript fetch. The directory must remain under the configured system temporary root, and every file read must resolve beneath that exact run-owned directory.

The service:

1. creates the directory with restrictive permissions;
2. invokes the typed command with that directory;
3. validates the structured command response and referenced artifact path;
4. enforces per-file and per-run byte limits;
5. reads and normalizes transcript text;
6. removes the directory on success, provider failure, timeout, cancellation, parse failure, and process shutdown cleanup where possible.

The normalized transcript is cached only in memory for the current Agent Run and paged into the model context. Local paths are never returned to the model, logs, database, or user.

## Failure Semantics

Failures are classified at the typed boundary and do not expose raw provider output.

- A Minute without permission, a deleted Minute, or a Minute whose transcription is not ready is unavailable for that source. The Agent may continue with other successfully fetched Minutes and documents.
- An expired user OAuth identity or missing application scope makes the Minutes capability unavailable for that run. Document search may continue independently.
- A malformed or oversized transcript makes only that Minute unreadable.
- Search service failure does not invent an empty successful result. The Agent receives a stable unavailable fact.
- Abort and Agent timeout preserve existing cancellation behavior.
- No failure automatically applies for access, retries a write, or falls back to Bot Authority.

The final answer must say which source class could not be verified when that limitation is material. It must not substitute historical cached Minutes because Minori does not persist them.

## Persistence and Audit

Transcript bodies, excerpts, search queries, Minute tokens, URLs, participant or speaker identities, provider page tokens, local file paths, and raw provider errors remain outside Neon.

The existing Agent operational audit may record only:

- typed tool name;
- success or stable failure category;
- normalized result count;
- fetched transcript count;
- bounded completeness information such as omitted malformed rows.

Audit failure is best-effort and must not replace a successful search or transcript result. This feature adds no database migration.

## Testing

### Command and service tests

- exact `minutes +search` and `minutes +detail --transcript` invocations;
- forced `--as user` and JSON output;
- no raw API, write, permission-application, upload, or media commands;
- tolerant normalization of optional search metadata without forwarding raw rows;
- opaque run-local search cursors and transparent invalid-cursor restart;
- transcript directory containment, permissions, size limits, and cleanup on every exit path;
- transcript snapshot paging, valid-cursor reuse, and mismatched-cursor restart;
- preservation of speakers, timestamps, title, time, and canonical URL;
- no model-visible local path or provider page token.

### Agent and persistence tests

- meeting questions can invoke document search and Minutes search in the same run;
- the Agent reads no more than five Minutes;
- search metadata alone is not treated as verified evidence;
- one denied or malformed Minute does not prevent synthesis from other sources;
- OAuth/scope failure yields a stable capability limitation without failing document search;
- transcript content and sensitive identifiers never enter Agent-run operational audit rows;
- existing Wiki reads and typed document writes remain unchanged.

### Release verification

- full unit, integration, typecheck, build, and amd64 image gates;
- published Feishu app permissions match the three read scopes;
- production OAuth status is healthy after reauthorization;
- a live query about recent meeting decisions returns sources from ordinary documents and Minutes when both exist;
- production health remains ready with zero unexpected restarts.

## Rollout

1. Implement and merge the typed commands, service, Agent tools, instructions, and tests.
2. Add the three read-only Minutes permissions in the Feishu developer console and publish the application version.
3. Reauthorize the existing Dedicated Knowledge User against the persistent production Lark store.
4. Release a new patch version through the established tag-to-GHCR-to-Production-Approval pipeline.
5. Run one live meeting-evidence acceptance query and inspect only sanitized runtime metadata.

If permissions or OAuth are not ready, the currently deployed release stays healthy. The code must fail the Minutes capability closed while retaining existing document and Wiki behavior.

## Acceptance Criteria

- A natural-language meeting question can discover Minutes without a pasted link.
- The Agent can combine verified ordinary document and Minute transcript evidence.
- At most five relevant Minutes are fetched in one Agent Run.
- Every cited Minute was successfully fetched, and citations include title/time/URL when available.
- One inaccessible Minute does not fail the whole answer.
- No transcript content or sensitive Minute metadata is persisted in Neon.
- All Minutes calls use the Dedicated Knowledge User through typed `lark-cli` read commands.
- Existing knowledge tools, writes, messaging, scheduling, and deployment behavior do not regress.
