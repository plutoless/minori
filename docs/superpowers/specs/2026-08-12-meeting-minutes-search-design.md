# Meeting Evidence Search Design

**Status:** Approved
**Date:** 2026-08-12

## Summary

Minori can currently search the Dedicated Knowledge User's visible cloud documents and read Wiki or document content, but it cannot locate completed Feishu meetings or traverse their Smart Meeting Note and Minute artifacts. This causes it to describe its access as limited to knowledge bases and to reject questions about meeting content outside Wiki even when the Dedicated Knowledge User can read the relevant meeting evidence.

Minori will add three read-only Agent tools backed by the existing official `lark-cli` user identity:

- `searchMeetings` locates completed Feishu Meeting Records.
- `searchMeetingMinutes` searches Minutes visible to the Dedicated Knowledge User.
- `fetchMeetingContent` resolves and reads the requested content for one selected Meeting Record or Minute.

For meeting-related questions, the Agent may use cloud-document search, Meeting Record search, and direct Minutes search, then independently synthesize evidence from the successfully fetched sources. By default Minori reads the Feishu-generated AI summary, preferring the Smart Meeting Note and then the Minute summary when both artifact types exist. It reads an original transcript when the member explicitly asks for original wording, speaker detail, timestamps, verification against the transcript, or another transcript-specific task. If no readable AI summary exists for an otherwise readable meeting artifact, Minori automatically falls back to the original transcript and synthesizes the answer from it. The application does not hard-code a mandatory search sequence. It keeps the existing open-ended Agent loop and expands only its typed read capability.

Fallback is evidence-aware: if the preferred Smart Meeting Note summary exists but cannot be read and the associated Minute summary is readable, Minori uses the Minute summary and labels it as the actual source. It never claims to have read the Smart Meeting Note. When the member explicitly asks for only one artifact type, Minori honors that constraint and does not silently substitute the other.

AI summaries are the default meeting-content source and are labeled as Feishu-generated content. Minori does not automatically load the original transcript when a readable summary is available. When the member explicitly requests transcript-level evidence, or when no readable AI summary exists, Minori reads the associated original transcript and labels it separately from AI-generated material. Todos or chapters are read only when the member asks for them or they are directly needed to answer the request.

Natural participant names are resolved internally through the official user-identity contact search before Meeting Record search. This resolver is not a general Agent-facing contact tool: it returns only a bounded set of matching names and identifiers to the meeting service, keeps the identifiers within the current Agent Run, and requires member clarification when more than one plausible person remains.

## Goals

- Let Minori locate completed meetings by keyword and time range and resolve their independent content artifacts.
- Let Minori actively search all Minutes visible to the existing OAuth user, including Minutes created from uploaded media that have no Meeting Record.
- Let Minori read the most relevant AI summaries, and original transcripts on explicit request, without requiring a pasted Minute URL.
- Let meeting answers combine ordinary cloud documents and Minutes, with explicit source type, title, time, and URL.
- Preserve the existing Dedicated Knowledge User authority model.
- Treat Minutes as part of the same team-wide Knowledge Boundary as cloud documents and Wiki content.
- Make the same meeting tools available to interactive and Scheduled Runs without a separate meeting-access switch.
- Keep all meeting bodies—including AI summaries, todos, chapters, and original transcripts—transient to one Agent Run and outside Neon.
- Degrade per source so one unavailable Minute does not invalidate other Minutes or document evidence.

## Non-goals

- Organization-administrator or tenant-wide access beyond the OAuth user's own visibility.
- Re-filtering Minute results using the requesting member's own Feishu permissions.
- A separate Minutes space allowlist or member allowlist.
- Searching or reading private Minutes the Dedicated Knowledge User cannot access.
- Editing Minute titles, summaries, speakers, words, or todos.
- Automatically loading original transcripts for every meeting query.
- Downloading Minute audio or video.
- Uploading media to create Minutes.
- Automatically applying for Minute permissions.
- Calendar event search, meeting attendance management, or meeting-bot participation.
- Future meeting discovery or user-authored Meeting Notes attached only to a calendar event.
- A second OAuth implementation, direct access-token management, generic HTTP tool, or raw OpenAPI escape hatch.
- A general employee directory, contact browsing tool, organization enumeration, or access beyond people returned by the Dedicated Knowledge User's typed search.
- Persisting AI summaries, todos, chapters, transcripts, excerpts, raw search results, participant identities, or local artifact paths in Neon.
- Building a separate meeting-content index.

## Authority and Permissions

All meeting operations run through the existing official `lark-cli` installation with `--as user`. The effective identity remains the Dedicated Knowledge User used for Docs, Drive, and Wiki. A Meeting Record or content artifact is discoverable or readable only when that user can access it under Feishu's resource permissions.

Meeting content joins the existing Knowledge Boundary without a requester-level permission check. Any Feishu Delivered Member, including an external collaborator, may receive information from meeting content visible to the Dedicated Knowledge User even when that member cannot open the source directly. Operators must therefore grant the Dedicated Knowledge User access only to meeting content suitable for team-wide disclosure through Minori. Minori does not add a separate meeting allowlist or member gate.

The application requests only the additional user scopes required by the typed commands:

- `contact:user:search`
- `vc:meeting.search:read`
- `vc:meeting.meetingevent:read`
- `vc:record:readonly`
- `vc:note:read`
- `minutes:minutes.search:read`
- `minutes:minutes.basic:read`
- `minutes:minutes.transcript:export`

The OAuth command keeps the existing Docs, Drive, and Wiki domains and adds these explicit scopes. `contact:user:search` is used only with user identity to resolve a participant name to a meeting-search identifier; Minori accepts only candidates the Dedicated Knowledge User's typed search actually returns and does not enumerate the organization. `vc:record:readonly` is used only when Minori opens a selected Meeting Record after lightweight discovery. The advanced `vc:meeting.artifact.verbatim:read` scope is not part of the default OAuth set in this tenant; a Smart Meeting Note transcript that requires it is an independently unavailable source and does not block Meeting Record search, readable summaries, or Minute transcripts. The application does not request complete Contact, VC, or Minutes domains because they contain write, media, meeting-control, and other capabilities outside this feature. Lark CLI remains locked at 1.0.84 for this contract fix; dependency upgrades are separate changes.

The app permissions must be added and published in the Feishu developer console before the production user reauthorizes. Production uses the existing persistent Lark credential store; there is no second token store.

## Participant Resolution

When a member names an organizer or participant, the meeting service invokes the typed `contact.searchUser` command before `vc.search`:

- it maps only to `lark-cli contact +search-user --as user --format json`;
- it accepts one bounded name query and bounded page size;
- it returns only display name plus the provider identifier needed by `vc.search`;
- it never returns avatar, department, email, phone, or other contact fields to the Agent;
- exact unique matches may proceed automatically;
- multiple plausible matches are returned as a short clarification choice, without exposing identifiers;
- no match returns an unresolved-participant result; the Agent must ask for another identifying detail or use another member-provided constraint and must not silently remove the participant filter.

Resolved identifiers are invocation-local discovery data. They are not placed in the model prompt, logs, citations, or Neon. The Agent sees only whether the participant was resolved, ambiguous, or unavailable.

## Typed Lark Boundary

The internal command catalog adds only the read paths needed by the three Agent tools:

1. `contact.searchUser` maps to `lark-cli contact +search-user` for bounded participant-name resolution.
2. `vc.search` maps to `lark-cli vc +search` for completed Meeting Record discovery.
3. `vc.detail` maps to `lark-cli vc +detail` for bounded Meeting Record metadata and its Smart Meeting Note / Minute associations.
4. `note.detail` maps to `lark-cli note +detail` for Smart Meeting Note summary and original-transcript references.
5. `note.transcript` maps to `lark-cli note +transcript` only when transcript content is selected.
6. `minutes.search` maps to `lark-cli minutes +search` for independent Minute discovery.
7. `minutes.detail` maps to `lark-cli minutes +detail` with an application-selected read mode: summary by default, todo or chapter on demand, and transcript only when selected by the confirmed fallback rules.

Every command forces `--as user --format json`, validates provider identifiers and bounded inputs, and constructs arguments from an allowlisted command shape. File-producing transcript modes receive a run-owned output directory. The catalog does not enable media download, upload, update, permission application, meeting control, speaker replacement, word replacement, or arbitrary CLI arguments. The existing typed document reader remains responsible for a Smart Meeting Note document token returned by `note.detail`; it does not introduce a new raw document command.

The Agent never receives a shell, a raw `lark-cli api` command, an access token, a local path, or arbitrary provider parameters.

## Agent Tools

### `searchMeetings`

When the member asks for “recent” meetings without an explicit date range, Minori searches the preceding 30 days. This is an application default, not a model-selected interval. Explicit member-provided time ranges take precedence. When an explicit range exceeds the VC search API's maximum one-month window, the meeting service splits it into contiguous windows of at most one month, searches them independently, then merges and deduplicates Meeting Records before returning them. Windowing does not bypass the Agent Run's existing step, time, transcript-byte, or context budgets.

Input:

- bounded keyword and time range;
- optional organizer or participant names, resolved internally as above;
- optional opaque Agent-Run-local continuation cursor.

Output:

- normalized Meeting Record reference;
- bounded title or topic;
- actual start/end time;
- display names when returned and safe;
- availability references for Smart Meeting Note and Minute artifacts;
- an opaque `nextCursor` when another page exists.

Provider participant identifiers and page tokens never enter model context. Ambiguous participant names produce a clarification result rather than a guessed meeting search.

### `searchMeetingMinutes`

Input:

- `query`: optional keyword, bounded to the provider limit.
- `start`: optional ISO 8601 lower time bound.
- `end`: optional ISO 8601 upper time bound.
- `cursor`: optional opaque Agent-Run-local continuation cursor.

Output:

- Agent-Run-local `meetingRef` bound to the normalized Minute token;
- title or bounded display text;
- meeting/create time when returned;
- canonical Minute URL;
- an opaque `nextCursor` when another page exists.

The first request omits `cursor`. Provider identifiers and page tokens never enter model context. Minori binds each opaque result reference and cursor to the exact query and time-range tuple for the current Agent Run. An unknown, expired, cross-run, or mismatched cursor transparently restarts the requested search at page one rather than throwing an Agent-visible cursor error.

### `fetchMeetingContent`

Input:

- `meetingRef`: an Agent-Run-local reference returned by `searchMeetings` or `searchMeetingMinutes`;
- `contentKind`: `auto`, `summary`, `todos`, `chapters`, or `transcript`;
- `artifactPreference`: `auto`, `smart_note`, or `minute`;
- `cursor`: optional opaque cursor returned by the preceding page for the same content snapshot.

Output:

- bounded AI-summary, todo, chapter, or transcript text for the requested page;
- speaker names and timestamps only for transcript content when present;
- source title, meeting time, and canonical URL;
- the actual content type and artifact type used;
- an opaque `nextCursor` when more content remains.

`auto` content with `auto` artifact preference selects a readable Smart Meeting Note AI summary, then a readable Minute AI summary, then an original transcript only when neither summary is readable. Explicit `transcript` bypasses summary selection; explicit `summary`, `todos`, or `chapters` never silently claims another content type. `smart_note` and `minute` artifact preferences constrain selection to that chain and never substitute the other artifact type. The first successful fetch creates a Document-like Meeting Content Snapshot scoped to one Agent Run. Repeated reads use the cached snapshot and do not mix pages from different artifacts. A valid continuation cursor remains reusable inside that run. An unknown or mismatched cursor restarts at the first page of the requested content. No meeting-content cursor survives the Agent Run.

## Unified Meeting Evidence

The existing `searchKnowledge` tool already searches cloud documents visible to the Dedicated Knowledge User; it is not a Wiki-only capability. Agent instructions will state that meeting-related questions may require both:

- `searchKnowledge` for ordinary meeting notes stored as Feishu documents or Wiki nodes;
- `searchMeetings` for completed Feishu Meeting Records and their associated Smart Meeting Note / Minute artifacts;
- `searchMeetingMinutes` for Feishu Minutes;
- the corresponding document or meeting-content fetch tool before treating a result as verified evidence.

Search-result titles and snippets are discovery metadata, not evidence. The Agent must fetch content before relying on it. The Agent may search the sources in any useful order or concurrently. For an ordinary question it targets the five most relevant meeting artifacts first. Five is a default selection target, not a hard limit: an explicit broad-coverage request or insufficient evidence may justify additional content fetches within the existing 40-step, 300-second, meeting-content-byte, and context budgets.

The final answer identifies every meeting source actually used with its title, meeting time, content type, and canonical link when available. Content types distinguish at least `Feishu document`, `Smart Meeting Note AI summary`, `Minute AI summary`, and `original transcript`; Minori never labels generated content as an original transcript. A Delivered Member's inability to open the link does not hide or relabel the source because delivery follows the shared Knowledge Boundary rather than requester-level document permissions. Duplicate URLs or artifact references are collapsed before synthesis.

Interactive and Scheduled Runs receive the same typed meeting tools. A Scheduled Run uses the same Dedicated Knowledge User authority, Knowledge Boundary, content-selection rules, and transient-content handling as an interactive run. It does not gain a separate meeting allowlist or bypass the existing global scheduling kill switch.

## Meeting Content Files and Context Window

`lark-cli note +transcript` and transcript-enabled `minutes +detail` write artifacts to an output directory. Minori creates a unique, non-symlinked temporary directory owned by the runtime user for each file-producing fetch. The directory must remain under the configured system temporary root, and every file read must resolve beneath that exact run-owned directory.

The service:

1. creates the directory with restrictive permissions;
2. invokes the typed command with that directory;
3. validates the structured command response and referenced artifact path;
4. enforces per-file and per-run byte limits;
5. reads and normalizes the selected meeting content;
6. removes the directory on success, provider failure, timeout, cancellation, parse failure, and process shutdown cleanup where possible.

The normalized Meeting Content Snapshot is cached only in memory for the current Agent Run and paged into the model context. AI summaries returned through the existing document reader obey the same run-local retention boundary. Local paths are never returned to the model, logs, database, or user.

## Failure Semantics

Failures are classified at the typed boundary and do not expose raw provider output.

- A Minute without permission, a deleted Minute, or a Minute whose transcription is not ready is unavailable for that source. The Agent may continue with other successfully fetched Minutes and documents.
- An unreadable Smart Meeting Note may fall back to the associated readable Minute for a general meeting question. An explicit Smart-Meeting-Note-only request reports the unavailable Smart Meeting Note instead of substituting a Minute.
- When neither the Smart Meeting Note nor Minute exposes a readable AI summary but an original transcript is readable, a general meeting question may fall back to that transcript. The final answer identifies the transcript rather than implying that a Feishu AI summary existed.
- An expired user OAuth identity or missing application scope makes the affected meeting capability unavailable for that run. Document search and independently healthy meeting sources may continue.
- A malformed or oversized summary or transcript makes only that content artifact unreadable.
- Search service failure does not invent an empty successful result. The Agent receives a stable unavailable fact.
- Abort and Agent timeout preserve existing cancellation behavior.
- No failure automatically applies for access, retries a write, or falls back to Bot Authority.

The final answer must say which source class could not be verified when that limitation is material. It must not substitute historical cached meeting content because Minori does not persist it.

## Persistence and Audit

AI summaries, todos, chapters, transcript bodies, excerpts, search queries, Minute or Meeting Record tokens, URLs, participant or speaker identities, provider page tokens, local file paths, and raw provider errors remain outside Neon.

The existing Agent operational audit may record only:

- typed tool name;
- success or stable failure category;
- normalized result count;
- fetched content count by bounded content category;
- bounded completeness information such as omitted malformed rows.

Audit failure is best-effort and must not replace a successful search or content result. This feature adds no database migration.

## Testing

### Command and service tests

- exact typed contact, VC, Smart Meeting Note, Minutes, and existing document-read invocations;
- forced `--as user` and JSON output;
- no raw API, write, permission-application, upload, or media commands;
- default AI-summary selection, Smart Meeting Note to Minute-summary fallback, no-summary transcript fallback, explicit transcript selection, and `smart_note` / `minute` artifact-preference non-substitution;
- tolerant normalization of optional search metadata without forwarding raw rows;
- opaque run-local search cursors and transparent invalid-cursor restart;
- default 30-day recent search, explicit multi-month window splitting, chronological boundary coverage, and cross-window deduplication;
- meeting-content directory containment, permissions, size limits, and cleanup on every exit path;
- meeting-content snapshot paging, valid-cursor reuse, and mismatched-cursor restart;
- preservation of speakers, timestamps, title, time, and canonical URL;
- no model-visible local path or provider page token.

### Agent and persistence tests

- meeting questions can invoke document search and Minutes search in the same run;
- interactive and Scheduled Runs expose the same meeting tools, while the existing global scheduling kill switch still prevents scheduled execution;
- ordinary meeting questions select the five most relevant artifacts first, while explicit broad-coverage or insufficient-evidence cases may continue only within the existing Agent and meeting-content budgets;
- search metadata alone is not treated as verified evidence;
- one denied or malformed Minute does not prevent synthesis from other sources;
- OAuth/scope failure yields a stable capability limitation without failing document search;
- AI summary, todo, chapter, transcript content, and sensitive identifiers never enter Agent-run operational audit rows;
- existing Wiki reads and typed document writes remain unchanged.

### Release verification

- full unit, integration, typecheck, build, and amd64 image gates;
- published Feishu app permissions match the enumerated read scopes;
- production OAuth status is healthy after reauthorization;
- a live query about recent meeting decisions returns sources from ordinary documents and Minutes when both exist;
- production health remains ready with zero unexpected restarts.

## Rollout

1. Implement and merge the typed commands, service, Agent tools, instructions, and tests.
2. Add the enumerated read-only Contact, VC, Smart Meeting Note, and Minutes permissions in the Feishu developer console and publish the application version.
3. Reauthorize the existing Dedicated Knowledge User against the persistent production Lark store.
4. Release a new patch version through the established tag-to-GHCR-to-Production-Approval pipeline.
5. Run one live meeting-evidence acceptance query and inspect only sanitized runtime metadata.

If permissions or OAuth are not ready, the currently deployed release stays healthy. The code must fail only the affected meeting capability closed while retaining existing document, Wiki, and independently healthy meeting behavior.

## Acceptance Criteria

- A natural-language meeting question can discover completed Meeting Records and independent Minutes without a pasted link.
- The Agent can combine verified ordinary documents, Smart Meeting Note or Minute summaries, and original transcripts when selected.
- Ordinary meeting questions initially target five relevant artifacts; broader reading remains bounded by the existing Agent Run and meeting-content budgets rather than a separate hard meeting-count cap.
- Every cited meeting artifact was successfully fetched, and citations include title/time/content type/URL when available.
- Every meeting claim identifies whether it came from a Feishu-generated summary or an original transcript.
- One inaccessible meeting artifact does not fail the whole answer.
- No meeting content or sensitive meeting metadata is persisted in Neon.
- All meeting calls use the Dedicated Knowledge User through typed `lark-cli` read commands.
- Existing knowledge tools, writes, messaging, scheduling, and deployment behavior do not regress.
