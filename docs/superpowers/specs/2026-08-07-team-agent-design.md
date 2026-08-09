# Cloud Team Agent Design

**Date:** 2026-08-07
**Status:** Approved
**Audience:** Minori maintainers and operators

**Active implementation plan:** `docs/superpowers/plans/2026-08-07-team-agent.md`

**Release state:** The code and local release contract cover existing-app OAuth,
revision-safe create/append/patch tools, authentic sources, PostgreSQL write audits,
and configurable Agent limits. Dedicated Knowledge User OAuth is verified on the
exact Vultr candidate. Production readiness still requires the open-admission change,
deployment, and real group/private Feishu acceptance.

## Summary

Minori is one always-on Team Agent running on the existing Vultr Ubuntu host. Any
member within the Feishu App's configured availability may interact with it in a group
where the bot is present or in private chat. Minori maintains no additional group or
user allowlist. One Feishu custom app supplies Bot Authority for messaging and
Delegated Knowledge Authority through a dedicated logged-in user for Lark CLI
knowledge operations.

The Agent remains open-ended: it may answer directly, search and read knowledge, create a document, append content, or apply a targeted patch. Conversation flow is not routed through scenarios or confirmation cards. Deterministic code limits side effects to typed tools; delete, move, permission or sharing changes, arbitrary shell, arbitrary HTTP, and raw API execution are unavailable.

## Product behavior

### Conversation entry

- The Feishu App's administrator-configured availability is the sole admission
  boundary. Minori does not maintain `ALLOWED_CHAT_IDS`, a user allowlist, or a derived
  group-membership gate.
- In any group where the bot is present, a member within that app availability may
  start an Agent Thread by mentioning Minori or replying to a Minori message.
- Members continue naturally inside that reply thread without repeating the mention.
- Unrelated group-timeline messages do not activate Minori.
- Private messages from any member who can access the Feishu App are accepted without
  requiring membership in a separate configured group.
- Minori adds a temporary `Typing` reaction while processing and removes it on completion or failure.

### Open Agent behavior

- One Vercel AI SDK `ToolLoopAgent` decides whether and how to use tools.
- There is no intent router, scenario classifier, fixed search sequence, evidence-token target, or per-write confirmation.
- Agent runs default to at most 20 model/tool steps and 180 seconds. Both values are configurable technical runaway limits.
- Individual tool results remain bounded and paginated so one document cannot consume the entire context.
- Recent messages from the same Feishu thread or private conversation are supplied automatically. Older retained messages may be searched only within that same conversation.
- Conversation content expires after 30 days by default. Opt-in long-term memory is future scope.

### Knowledge authority

The Dedicated Knowledge User's native Feishu permissions are the sole content boundary. Minori does not maintain a second allowlist of spaces, folders, or documents.

Effective knowledge authority is the intersection of:

1. user-level API capabilities published for the Minori Feishu App;
2. the `docs`, `drive`, and `wiki` business-domain OAuth grant;
3. concrete content access held by the Dedicated Knowledge User; and
4. typed tools exposed by Minori.

Knowledge tools always invoke Lark CLI with `--as user` in a profile configured as `strict-mode=user`. Bot Authority remains in the Feishu Node SDK path and is unavailable to knowledge tools.

### Knowledge operations

Available operations:

- search Drive, Docs, and Wiki;
- list knowledge spaces and nodes;
- fetch a bounded page or complete document through pagination;
- create a Markdown document, optionally under a folder or Wiki node;
- append Markdown to a document;
- replace one exact, uniquely matched text range in a document.

For append and patch, Minori reads the current revision immediately before writing and supplies that revision to Lark CLI. A targeted patch proceeds only when the exact pattern occurs once. Revision mismatch or ambiguous pattern returns a conflict to the Agent, which may re-read and recompute; Minori never silently overwrites the latest content.

Unavailable operations:

- full-document overwrite as a normal Agent tool;
- block deletion or document deletion;
- document or Wiki-node movement;
- permission, membership, ownership, or sharing changes;
- arbitrary Lark raw API calls;
- arbitrary shell, HTTP, or filesystem access.

Autonomous writes do not require per-operation confirmation. Each write records its operation, target identifier, outcome, and sanitized summary in the existing `agent_runs` / `tool_runs` audit model. Successful replies include the affected document URL and a concise receipt.

### Sources

The Agent chooses how to cite knowledge naturally. Minori collects the title and URL of every document actually read in the run, deduplicates them, and appends that source list when non-empty.

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
- Events are idempotent and messages are serialized within one Agent Thread while different conversations run concurrently.
- PostgreSQL persists events, conversations, 30-day messages, Agent runs, and tool audit records.
- OpenAI Responses requests use the configured `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `AI_MODEL`; every request uses `store: false`.
- Cross-turn context is rebuilt from Neon and does not rely on `previous_response_id`.
- Health readiness covers database, Feishu, Lark OAuth, model compatibility, retention, and worker state without exposing secrets.

## Deployment

- One Docker Compose service runs as UID 10001 on Ubuntu 24.04 LTS x86_64.
- Neon remains external; Redis and a separate worker service are unnecessary.
- Feishu uses outbound long connection, so no public inbound webhook is opened.
- The health endpoint binds to host loopback only.
- Deployment builds an explicit Git commit, runs migrations and preflight checks, replaces the service, and rolls back when readiness fails.
- Live acceptance must cover one group thread where the bot is present, one private
  chat from a member within the Feishu App availability, a real knowledge read with a
  working source link, create, append, targeted patch, restart recovery, and Lark
  credential persistence.
- Release artifacts are commit-addressed. A candidate is not considered live merely
  because local tests and image verification pass; the configured Vultr runtime must
  report every readiness category healthy and the real Feishu acceptance must finish.
- Acceptance evidence is local and gitignored. It records identifiers, URLs, image and
  commit references, timestamps, readiness categories, and pass/fail outcomes only.

## Deferred scope

- Scheduled tasks and schedule management.
- Opt-in long-term memory.
- Attachments, audio, image, and video understanding.
- Multiple specialized Agents or subagents.
- GitHub, repository, CI, or pull-request operations.
- Administrative web dashboard or multi-tenant hosting.
- Delete, move, permission, sharing, raw API, arbitrary shell, or arbitrary HTTP tools.
