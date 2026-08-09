# Cloud Team Agent Design

**Date:** 2026-08-07
**Status:** Approved
**Audience:** Minori maintainers and operators

**Active implementation plan:** `docs/superpowers/plans/2026-08-08-live-group-context.md`

**Release state:** The currently deployed exact image is healthy and has passed the
ordinary private-message functional path, while live group/write/restart acceptance
is incomplete. It still creates thread replies and does not provide Live Group
History; the active plan replaces that interaction model and repeats exact-image
acceptance before declaring the new release complete.

## Summary

Minori is one always-on Team Agent running on the existing Vultr Ubuntu host. Any
member within the Feishu App's configured availability may interact with it in a group
where the bot is present or in private chat. Minori maintains no additional group or
user allowlist. One Feishu custom app supplies Bot Authority for messaging and
Delegated Knowledge Authority through a dedicated logged-in user for Lark CLI
knowledge operations.

The Agent remains open-ended: it may answer directly, search and read knowledge, create a document, append content, or apply a targeted patch. Conversation flow is not routed through scenarios or confirmation cards. The first release limits side effects to the Initial Typed Write Set; this is release sequencing rather than a permanent scenario or capability boundary.

## Product behavior

### Conversation entry

- Feishu message delivery to the App is the sole admission boundary. Minori does not
  maintain `ALLOWED_CHAT_IDS`, a user allowlist, a derived group-membership gate, or an
  internal-versus-external tenant check.
- A **Feishu Delivered Member** is any user whose private or group message Feishu
  delivers to the Minori App. This explicitly includes external collaborators in a
  mixed group when Feishu delivers their message event.
- In an ordinary-message group where the bot is present, a member invokes Minori by
  directly mentioning it or directly replying to one of its ordinary messages.
- Minori never intentionally creates a Feishu topic. Private and group answers use
  ordinary replies; Feishu topic-mode groups are outside this release's supported
  interaction surface.
- The group chat ID is the shared **Group Context**. When invoked, Minori reads up to
  20 recent messages before the Current Invocation and may page earlier history with
  a read-only tool bound to that group and cutoff. Real group display names are
  resolved through the group-member API.
- Live Group History is background for the Current Invocation, not a backlog of
  independently authorized commands. It is sent transiently to the model and is not
  mirrored into Neon.
- Unrelated group-timeline messages do not activate Minori.
- Private messages from any Feishu Delivered Member are accepted without requiring
  membership in a separate configured group.
- After an accepted event is durably persisted, Minori immediately adds a temporary `Typing` reaction to the target message. The reaction acknowledges durable receipt and may remain while the event is queued; it does not claim that model execution has started. Minori removes it after reply, explicit failure, or stopped processing.

### Open Agent behavior

- One Vercel AI SDK `ToolLoopAgent` decides whether and how to use tools.
- There is no intent router, scenario classifier, fixed search sequence, evidence-token target, or per-write confirmation.
- Agent runs default to at most 40 model/tool steps and 300 seconds. Both values are configurable technical runaway limits, not restrictions on the kinds of work the Agent may attempt.
- Reaching either limit is **Execution Budget Exhaustion**, not successful completion or a generic transient failure. No subsequent model step, tool call, or write may start after the limit is observed.
- Minori does not automatically rerun an exhausted task. Writes completed before exhaustion remain committed and audited; Minori does not attempt an unsafe compensating rollback.
- The reply states that the run reached its step limit or timeout, lists confirmed completed operations and affected resource links, and invites the member to say `continue` (or the natural-language equivalent). Step exhaustion and timeout are recorded as distinct audit outcomes rather than `completed` or a generic `aborted` outcome.
- An explicit continuation starts a new Agent run with visible conversation history and the prior run's confirmed receipts and resource links. Minori does not persist hidden model reasoning or resume an in-memory tool loop; the new run re-reads current knowledge state before planning remaining work.
- A transient model or read-only-tool failure may automatically retry the Agent run only before its first Typed Knowledge Write begins. The first write attempt is the **Write Replay Boundary**; after it, Minori reports confirmed and unknown outcomes and waits for an explicit Continuation Run rather than replaying the whole task.
- Recovery inside that new run is Agent-managed. Runtime supplies durable operation outcomes, receipts, resource links, and the normal knowledge tools; the Agent decides whether to inspect, search, retry, change approach, or ask the member. Minori does not hard-code an operation-specific reconciliation workflow or mandatory confirmation step.
- Idempotent retry of the Feishu reply transport is independent of Agent-run replay and remains allowed under the reply deduplication contract.
- Individual tool results remain bounded and paginated so one document cannot consume the entire context.
- Private conversations use retained history. Group runs receive bounded Live Group
  History from the current chat, and the Agent may page earlier messages only within
  that same Group Context and Invocation Context Cutoff.
- Conversation content expires after 30 days by default. Opt-in long-term memory is future scope.

### Knowledge authority

The Dedicated Knowledge User's native Feishu permissions are the sole content boundary. Minori does not maintain a second allowlist of spaces, folders, or documents and does not re-filter results using the requesting member's own content permissions.

Consequently, every Feishu Delivered Member—including an external collaborator—may ask Minori to read, summarize, transform, or cite any content inside the Knowledge Boundary even when that member could not open the source directly. The Dedicated Knowledge User is therefore an intentional knowledge-publication identity: operators grant it access only to content suitable for every audience that can reach the App. This disclosure model is deliberate rather than an accidental authorization fallback.

Effective knowledge authority is the intersection of:

1. user-level API capabilities published for the Minori Feishu App;
2. the `docs`, `drive`, and `wiki` business-domain OAuth grant;
3. concrete content access held by the Dedicated Knowledge User; and
4. typed tools exposed by Minori.

Knowledge tools always invoke Lark CLI with `--as user` in a profile configured as `strict-mode=user`. Bot Authority remains in the Feishu Node SDK path and is unavailable to knowledge tools.

### Typed Knowledge Writes and reads

The **Initial Typed Write Set** contains:

- search Drive, Docs, and Wiki;
- list knowledge spaces and nodes;
- fetch a bounded page or complete document through pagination;
- create a Markdown document, optionally under a folder or Wiki node;
- append Markdown to a document;
- replace one exact, uniquely matched text range in a document.

For append and patch, Minori reads the current revision immediately before writing and supplies that revision to Lark CLI. A targeted patch proceeds only when the exact pattern occurs once. Revision mismatch or ambiguous pattern returns a conflict to the Agent, which may re-read and recompute; Minori never silently overwrites the latest content.

Unavailable in the first release:

- full-document overwrite as a normal Agent tool;
- block deletion or document deletion;
- document or Wiki-node movement;
- permission, membership, ownership, or sharing changes;
- arbitrary Lark raw API calls;
- arbitrary shell, HTTP, or filesystem access.

Typed Knowledge Writes do not require per-operation confirmation. Each write records its operation, target identifier, outcome, and sanitized summary in the existing `agent_runs` / `tool_runs` audit model. Successful replies include the affected document URL and a concise receipt. These writes are bounded and audited, but Minori does not promise automatic rollback.

Beginning any Typed Knowledge Write crosses the Write Replay Boundary, including when its final result is not observed. A later model, tool, or process failure therefore cannot trigger automatic replay of the complete Agent run. Minori instead reports confirmed successful, failed, and unknown write attempts separately so the member can explicitly continue from durable evidence. Once continued, recovery strategy belongs to the Agent rather than an operation-specific state machine.

### Sources

The Agent chooses how to cite knowledge naturally. Minori collects the title and URL of every document actually read in the run, deduplicates them, and appends that source list when non-empty. A requesting member may be unable to open a cited source directly because source access follows that member's native Feishu permissions even though Minori's answer follows the Dedicated Knowledge User's Knowledge Boundary.

Runtime validation only prevents fabricated or unread source references. It does not classify prose claims, demand a marker on every team fact, invoke a citation-repair model call, or reject an otherwise useful answer because of citation formatting. Direct general assistance that uses no knowledge tool has no empty Sources section.

## Lark authentication

`npm run lark:auth` binds Lark CLI to the existing Minori Feishu App; it never creates a second app.

1. Require `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.
2. Run `config init --app-id ... --app-secret-stdin --brand feishu`, sending the secret through stdin.
3. Set the profile to `strict-mode=user`.
4. Start device login with `--domain docs,drive,wiki --no-wait --json`.
5. Write the verification URL transiently and only to the interactive operator's
   `/dev/tty`; never send it to stdout, stderr, structured logs, the database, model
   context, or persistent files. If no operator TTY is available, fail with a stable
   error rather than falling back to process output.
6. Resume internally with the returned device code after the operator authorizes the
   intended user; never display that code separately.
7. Run one sanitized `auth status --verify` check and report whether the user identity is available.

The first release does not pin the user's Open ID. The operator verifies the account during login. It also does not back up Lark credentials; server loss requires a fresh OAuth grant.

On Linux, configuration and encrypted credentials persist below the mounted `/var/lib/minori/lark` directory:

- `LARKSUITE_CLI_CONFIG_DIR=/var/lib/minori/lark/config`
- `LARKSUITE_CLI_DATA_DIR=/var/lib/minori/lark/data`

The native Lark CLI Linux credential store keeps its master key and encrypted secrets together. The entire mounted directory is therefore one high-sensitivity asset, owned by Minori's non-root UID with restrictive permissions and excluded from logs and Git.

## Runtime and persistence

- Feishu long connection persists normalized events to Neon before slow model work.
- Accepted events enter a PostgreSQL-backed Durable Conversation Queue; queued events do not consume a model execution slot.
- Processing Reactions are created after durable acceptance rather than after an execution slot becomes available, so queued members receive immediate lightweight acknowledgement without a separate queue message or status card.
- Messages are serialized in order within one Group Context or private conversation. Different groups and private conversations run concurrently, with a configurable global limit of four by default; additional conversations remain durably queued.
- Minori applies no per-user or per-group request quota. The global concurrency limit controls active resource and model usage without becoming another admission boundary.
- Neon PostgreSQL is a trusted Persistence Data Boundary. It stores accepted trigger
  and assistant message bodies for 30 days so Minori can rebuild retained context;
  ordinary non-triggering Live Group History is not copied into Neon. Expiration
  clears retained bodies while preserving structural identifiers and timestamps
  needed for idempotency and audit continuity.
- Agent and tool audit metadata is retained without an initial automatic expiry. It contains model and usage data, timing, tool name, target identifiers, outcome, error category, and sanitized summaries—not hidden reasoning or complete retrieved document bodies.
- Minori does not maintain a PostgreSQL mirror of Feishu knowledge and does not add application-level encryption that would prevent server-side conversation search. Audit retention may be revised after real usage or a concrete compliance requirement exists.
- OpenAI Responses requests use the configured `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `AI_MODEL`; every request uses `store: false`.
- The configured model endpoint is a trusted Model Data Boundary for the entire Knowledge Boundary: it receives the conversation context, relevant document content, and tool results required by the Agent. `store: false` expresses Minori's request but is not treated as independent verification of an OpenAI-compatible intermediary's retention behavior.
- Minori does not add content redaction, keyword blocking, or a classification gateway in front of the model. If an endpoint is not trusted for the Knowledge Boundary, operators must replace it with a trusted official or private endpoint rather than relying on prompt-level filtering.
- Cross-turn context is rebuilt from Neon and does not rely on `previous_response_id`.
- Health readiness covers database, Feishu, Lark OAuth, model compatibility, retention, and worker state without exposing secrets.

## Deployment

- One Docker Compose service runs as UID 10001 on Ubuntu 24.04 LTS x86_64.
- Neon remains external; Redis and a separate worker service are unnecessary.
- Feishu uses outbound long connection, so no public inbound webhook is opened.
- The health endpoint binds to host loopback only.
- Deployment builds an explicit Git commit, runs migrations and preflight checks, replaces the service, and rolls back when readiness fails. Because migrations run before replacement and rollback restores the previous image without downgrading the database, every candidate migration must remain compatible with that supported previous image.
- The open-admission release removes the legacy allowlist from configuration and the runtime call graph but temporarily retains the physical `allowed_chats` table as inert rollback compatibility. The current runtime never reads or writes it. A later contract migration may remove it only after the production rollback floor advances beyond `4f936ab`.
- Live acceptance must cover one ordinary-message group where the bot can load recent
  history and real member names, one private chat from a member within the Feishu App
  availability, ordinary non-topic replies, a real knowledge read with a working
  source link, create, append, targeted patch, restart recovery, and Lark credential
  persistence.
- Release artifacts are commit-addressed. A candidate is not considered live merely
  because local tests and image verification pass; the configured Vultr runtime must
  report every readiness category healthy and the real Feishu acceptance must finish.
- Acceptance evidence is local and gitignored. It records identifiers, URLs, image and
  commit references, timestamps, readiness categories, and pass/fail outcomes only.

## Deferred scope

- Additional Typed Knowledge Writes: rename, move, trash, and complete-content update.
- Permission, membership, ownership, and sharing management. These require a separate capability decision rather than being inferred from general knowledge management.
- Scheduled tasks and schedule management.
- Opt-in long-term memory.
- Attachments, audio, image, and video understanding.
- Multiple specialized Agents or subagents.
- Destructive cleanup of the inert `allowed_chats` compatibility table after its fixed-point rollback obligation ends.
- GitHub, repository, CI, or pull-request operations.
- Administrative web dashboard or multi-tenant hosting.
- Delete, move, permission, sharing, raw API, arbitrary shell, or arbitrary HTTP tools.
