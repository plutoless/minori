# Cloud Team Agent Design

**Date:** 2026-08-04  
**Status:** Approved for implementation
**Audience:** Team Agent maintainers and operators

## 1. Summary

Build a portable, cloud-hosted Team Agent that interacts with team members in approved Feishu groups and private chats. The Agent uses Vercel AI SDK for open-ended conversation and tool use, and the official Lark CLI to search, read, create, and update the team's Feishu knowledge base.

The Agent signs into Lark CLI as a dedicated Feishu user. Its effective knowledge-base permissions are exactly the permissions granted to that user. It can write autonomously without per-operation confirmation. Safety comes from the dedicated user's permissions, a narrow typed tool surface, no delete or permission-management tools, conflict detection, and complete audit records.

The first release is one container backed by Neon PostgreSQL. It has no Redis dependency and no separate worker service.

## 2. Goals

- Give team members a natural, continuous Agent conversation in approved Feishu groups.
- Allow members of those groups to use the same Agent in private chat.
- Let the Agent autonomously search, navigate, and read the knowledge base while reasoning.
- Let the Agent create, append to, and update knowledge-base documents without a confirmation card.
- Support registered scheduled tasks that can autonomously update documents.
- Return clickable source documents when an answer relies on the knowledge base.
- Preserve conversation continuity, event idempotency, schedule state, and an audit trail across container restarts.
- Keep model choice replaceable through Vercel AI SDK.
- Package the service as one portable container that can run on any platform offering an always-on process, outbound WebSocket support, secrets, and network access to external services.

## 3. Non-goals for the First Release

- GitHub Issue or GitHub Project management.
- Coding, repository modification, sandbox execution, CI, or pull-request creation.
- Multiple cooperating Agents or specialized subagents.
- Deleting documents, moving knowledge-base nodes, or changing document permissions.
- Acting as different Feishu users based on the person asking.
- Mirroring or embedding the entire knowledge base into a vector database.
- An administrative web dashboard.
- Multi-tenant hosting for multiple companies.

## 4. Product Behavior

### 4.1 Eligible users

The service maintains a configured list of allowed Feishu chat IDs.

- Messages in an allowed group are accepted from current members of that group.
- Private messages are accepted only when the sender is currently a member of at least one allowed group.
- Membership is refreshed from Feishu and may be cached for at most five minutes.
- If membership cannot be verified, the service fails closed and does not run the Agent.
- A member who leaves every allowed group loses private-chat access after the membership cache expires.

### 4.2 Open-ended conversation

The system does not route messages into rigid question, search, or write workflows. A reusable AI SDK `ToolLoopAgent` receives the conversation and may:

- respond directly;
- ask follow-up questions;
- search several terms or knowledge spaces;
- browse a knowledge-space tree;
- read parent, child, or related documents;
- compare and synthesize multiple documents;
- brainstorm, plan, explain, or draft content;
- create or update a document when doing so helps complete the user's request;
- register, inspect, pause, resume, or cancel a scheduled task through typed schedule tools.

Runtime limits such as maximum tool steps, timeouts, and token budgets protect the service but do not prescribe a fixed reasoning sequence.

### 4.3 Knowledge-grounded answers

When an answer makes factual claims based on team knowledge, it includes the relevant Feishu document titles and clickable URLs. The Agent distinguishes:

- information directly supported by retrieved documents;
- an inference drawn from those documents; and
- a statement for which it found no reliable team source.

Failure to find a source is reported honestly and is not converted into a confident answer.

### 4.4 Autonomous writes

The Agent may directly create documents, append content, or update a defined section. It does not ask for a confirmation card.

Each write follows these rules:

1. The trigger is an eligible member's message or a registered schedule. Text retrieved from a document can never itself authorize a write or create a schedule.
2. The Agent reads the current target immediately before updating it.
3. Existing documents are modified with the smallest practical patch. Full-document overwrite is not exposed as a normal Agent tool.
4. The adapter records the target token, current revision or content hash, intended operation, and sanitized change summary before execution.
5. If the target changes before execution, the Agent re-reads and recomputes the patch. It does not blindly overwrite the new content.
6. The service records the actual CLI result and final document URL.
7. The Agent posts a receipt in the originating conversation or the schedule's notification chat with the document link and a concise description of what changed.

The first release does not expose delete, move, permission, sharing, or arbitrary raw-API tools to the model.

### 4.5 Scheduled work

An eligible member may ask the Agent to create a schedule in natural language. The Agent converts the request into a typed schedule record and reports the interpreted schedule immediately.

Each schedule stores:

- owner Feishu open ID;
- human-readable purpose;
- normalized recurrence and timezone;
- Agent instructions;
- optional target document or knowledge-space context;
- notification chat;
- enabled or paused status;
- next-run time and last-run outcome.

The schedule owner can inspect, pause, resume, edit, or cancel that schedule. Users listed in `AGENT_ADMIN_OPEN_IDS` can manage every schedule. A schedule execution enters the same Agent runtime as a user message, marked with a trusted system-origin trigger and the schedule owner's identity. It receives the same Lark tools and autonomous write permissions.

On restart, the scheduler reloads enabled schedules from PostgreSQL and runs overdue work once. A unique schedule/run key prevents duplicate executions. Missed recurring intervals are coalesced into one run instead of replayed repeatedly.

## 5. Architecture

```text
Approved Feishu groups and eligible private chats
                         |
                         v
                  Feishu Gateway
        event receipt, identity, cards, responses
                         |
                         v
                 Knowledge Agent
        Vercel AI SDK ToolLoopAgent + model registry
                         |
              +----------+-----------+
              |                      |
              v                      v
       Typed Lark Tools        Schedule Tools
       Lark CLI adapter        deterministic service
              |                      |
              +----------+-----------+
                         |
              +----------+-----------+
              |                      |
              v                      v
    Dedicated Feishu user      Neon PostgreSQL
       OAuth permissions       state and audit trail
```

### 5.1 Feishu Gateway

The gateway uses Feishu's official Node SDK and long-connection event delivery for messages and interactive events. Knowledge-base operations remain behind Lark CLI. The gateway:

- deduplicates incoming events before invoking the model;
- validates allowed chats and current membership;
- acknowledges slow work promptly;
- maps group threads and private conversations to internal conversation IDs;
- sends text, rich cards, citations, write receipts, and operational notices;
- never places OAuth URLs, tokens, or raw tool output into a group message.

Long connection avoids requiring a public inbound webhook, but the deployment must keep an always-on process and outbound WebSocket connection.

### 5.2 Knowledge Agent

The Agent is implemented with Vercel AI SDK's `ToolLoopAgent`.

- The model comes from a central provider registry.
- The default configuration uses Vercel AI Gateway and a model ID supplied by `AI_MODEL`.
- Direct OpenAI, Anthropic, or an OpenAI-compatible provider can replace the gateway without changing tools or business services.
- All tool inputs use strict Zod schemas.
- Each run has a configurable step limit, wall-clock timeout, and model-token budget.
- Model output cannot directly invoke the CLI, database, scheduler, or shell.

### 5.3 Lark CLI adapter

The adapter exposes a small set of domain tools rather than the CLI's complete command surface:

- search wiki and Drive documents;
- inspect knowledge spaces and node trees;
- fetch document content and metadata;
- create a document in an allowed location visible to the dedicated user;
- append content;
- patch a specific section or block;
- return document metadata and URLs.

The adapter uses `child_process.spawn` with an argument array and `shell: false`. It never concatenates a model-generated shell command. Each command:

- pins the user identity explicitly;
- requests JSON output;
- has an execution timeout and output-size limit;
- parses the CLI success/error envelope;
- redacts credentials and sensitive headers;
- returns structured data to the Agent;
- records sanitized execution metadata.

The Lark CLI version is pinned in the image. Upgrades require the real CLI integration suite to pass.

### 5.4 Write policy

Write policy is deterministic application code, not prompt text alone.

Allowed effects in the first release:

- create a document;
- append content;
- patch a known block or section.

Disallowed effects:

- delete a document or node;
- move a node;
- add, remove, or change permissions;
- change sharing settings;
- execute arbitrary Lark raw API calls;
- execute arbitrary shell commands.

### 5.5 Scheduler

The scheduler runs in the same Node process for the first release. PostgreSQL is the source of truth; in-memory timers are only wake-up mechanisms. A database lease ensures that a future multi-replica deployment will not execute a due schedule more than once.

No Redis or separate queue is required. Long or heavily parallel workflows are explicitly deferred until usage demonstrates the need for a durable workflow engine.

## 6. Persistence Model

Drizzle ORM defines migrations and keeps the application compatible with standard PostgreSQL. The service connects through Neon's pooled `DATABASE_URL`.

### 6.1 Core tables

`allowed_chats`

- Feishu chat ID, name, enabled state, and configuration timestamps.

`conversations`

- Internal ID, Feishu chat/thread identity, conversation type, and last activity.

`messages`

- Feishu message ID, conversation, sender, role, normalized content, timestamps, and model usage metadata.

`processed_events`

- Unique Feishu event ID, event type, received time, processing status, and final outcome.

`tool_runs`

- Agent run ID, tool name, caller or schedule owner, target identifiers, start/end timestamps, success state, error category, and sanitized summary. Full retrieved document bodies are not copied here.

`write_operations`

- Tool run, target document token, operation type, pre-write revision/hash, post-write revision/hash when available, sanitized change summary, source trigger, and outcome.

`schedules`

- Owner, purpose, recurrence, timezone, instructions, target context, notification chat, enabled state, next run, and last-run summary.

`schedule_runs`

- Unique schedule/run key, scheduled time, actual start/end, Agent run ID, status, and error summary.

### 6.2 Retention

- Conversation messages are retained for 30 days by default to support continuity.
- Audit metadata, write operations, and schedule history are retained for 180 days by default.
- Retrieved document bodies are held only for the active Agent run unless they are present in a retained conversation message.
- Retention periods are configurable by environment variables and enforced by a daily maintenance job.

## 7. Credentials and Authorization

### 7.1 Feishu identities

Two Feishu identities have distinct jobs:

- the application/bot identity receives events and posts messages;
- a dedicated Feishu user OAuth identity performs knowledge-base operations through Lark CLI.

The dedicated user's Feishu permissions are the authoritative knowledge-access boundary. The service does not impersonate the requesting team member and does not fall back to bot credentials when a user-identity command is denied.

### 7.2 OAuth bootstrap

An operator runs a one-time container command that starts Lark CLI's non-blocking login/device-code flow. The authorization URL is shown only to the operator. After the dedicated user grants access:

- Lark CLI auth status and required scopes are verified;
- credential state is stored in a platform secret or encrypted credential volume mounted into the container;
- credentials are excluded from the image, PostgreSQL, application logs, and Agent context;
- failed refresh or revoked access causes knowledge tools to stop and sends a private administrator notice.

The implementation may later use Lark CLI's Credential extension to fetch tokens from a centralized Vault. That extension is not required for the first deployable release.

## 8. Failure Handling

- **Duplicate event:** return the previously recorded outcome and do not invoke the Agent again.
- **Membership unavailable:** deny the request without running knowledge tools.
- **Lark auth expired:** stop knowledge operations and notify administrators privately.
- **Permission denied:** report the denied target; never change identity to bypass it.
- **Read rate limit or timeout:** retry with bounded exponential backoff.
- **Write result is uncertain:** query the target before retrying; never blindly repeat a create or patch.
- **Concurrent document edit:** re-read and recompute a minimal patch, or report a conflict when a safe merge is not possible.
- **Model failure:** preserve the conversation and offer a retry; do not report a model outage as missing knowledge.
- **Database unavailable:** acknowledge service degradation but do not perform writes or schedule executions that cannot be audited and deduplicated.
- **Container restart:** restore conversations and schedules from PostgreSQL; reconcile any write operation left in an unknown state.
- **Schedule failure:** record the run, notify the configured chat, and preserve the next recurrence unless an administrator pauses it.

## 9. Security Model

- Retrieved documents are untrusted content and cannot alter system policy, tool definitions, identity, or schedule state.
- Only eligible member messages and trusted scheduler events can initiate side effects.
- Tool names and arguments are validated against strict schemas.
- The model has no generic shell, file-system, HTTP, raw-Lark-API, delete, or permission tool.
- Secrets never enter model prompts or tool results.
- Logs redact bearer tokens, cookies, app secrets, authorization URLs, and raw credential-store paths.
- Write receipts and audit records make autonomous behavior visible after execution.
- The dedicated Feishu user receives only the knowledge-base permissions the team intends the Agent to exercise.
- The container runs as a non-root user with a read-only application filesystem and a writable temporary directory only where required by Lark CLI.

## 10. Deployment

The repository ships a multi-stage Docker image containing:

- Node.js runtime and compiled TypeScript application;
- a pinned official Lark CLI release;
- database migration command;
- service start command;
- Lark authentication bootstrap command;
- liveness and readiness endpoints.

External services and configuration:

- Neon PostgreSQL through `DATABASE_URL`;
- model credentials or Vercel AI Gateway credentials;
- Feishu app ID, app secret, and event-encryption configuration;
- mounted Lark CLI credential secret/volume;
- allowed chat IDs and administrator open IDs;
- model, timeout, retention, and schedule configuration.

Readiness reports separate states for process health, PostgreSQL reachability, Feishu gateway connectivity, Lark user login, and model configuration. It reports only status categories, never secrets.

The same image must run locally with Docker Compose and on an arbitrary always-on container platform. Docker Compose is for local validation; Neon remains the default database in both environments.

## 11. Testing Strategy

### 11.1 Unit tests

- allowed-group and private-chat eligibility;
- message and event idempotency;
- CLI argument construction and injection resistance;
- JSON success/error parsing and redaction;
- write-policy enforcement;
- schedule recurrence, ownership, leases, and missed-run coalescing;
- retention cleanup;
- document conflict decisions.

### 11.2 Agent evaluations

- open-ended conversation without unnecessary retrieval;
- iterative multi-query retrieval;
- multi-document synthesis with source links;
- honest response when no source exists;
- follow-up questions when the request is ambiguous;
- autonomous document creation and targeted updating;
- creation and management of schedules;
- resistance to instructions embedded in retrieved documents;
- refusal or inability to use unexposed destructive tools;
- useful behavior at the tool-step and token limits.

### 11.3 Integration tests

- Neon migrations and repository behavior;
- mocked Lark CLI subprocess failures and timeouts;
- real Lark CLI search, fetch, create, append, and patch against a dedicated test knowledge space;
- Lark login expiry and permission denial;
- model provider contract through AI SDK.

### 11.4 End-to-end tests

- message from an allowed group member;
- private message from an eligible member;
- rejection of an ineligible user or disallowed group;
- grounded answer with working Feishu links;
- direct autonomous write followed by a visible receipt;
- duplicate message and duplicate event delivery;
- scheduled autonomous update and notification;
- restart with active conversations and due schedules;
- reconciliation of an interrupted write.

## 12. MVP Acceptance Criteria

1. An allowed-group member can have a natural multi-turn conversation with the Agent in the group.
2. A current member of any allowed group can use the Agent in private chat.
3. The Agent can autonomously search, navigate, and read multiple knowledge-base documents using Lark CLI as the dedicated user.
4. Grounded answers include working Feishu document links and unsupported claims are identified as such.
5. The Agent can autonomously create a document, append content, and update a targeted section without confirmation.
6. Every write produces a visible receipt and a durable audit record.
7. Document content cannot trigger a side effect or expand the Agent's tool permissions.
8. The Agent has no document-delete, node-move, permission-management, raw API, or arbitrary-shell capability.
9. An eligible member can create, inspect, pause, resume, edit, and cancel a scheduled task that autonomously writes documents.
10. Duplicate events, uncertain writes, and container restarts do not cause duplicate writes or schedule runs.
11. Conversations, schedules, event state, and audit records survive a restart through Neon PostgreSQL.
12. The model can be changed through configuration without changing Feishu, Lark tool, schedule, or persistence code.
13. The complete service runs from one container image and requires no Redis or local persistent database volume.
14. The README documents Feishu app setup, dedicated-user OAuth, allowed chats, Neon, model configuration, local Docker validation, cloud deployment, and credential rotation.

## 13. Implementation Sequence

1. Establish the TypeScript service, configuration validation, Docker image, and health endpoints.
2. Add Neon/Drizzle schema, migrations, repositories, idempotency, and retention.
3. Implement Feishu long-connection gateway, allowed-chat checks, membership checks, and replies.
4. Install and pin Lark CLI; implement credential bootstrap and the typed read-only adapter.
5. Add the AI SDK provider registry, ToolLoopAgent, conversation persistence, and source-link formatting.
6. Add autonomous create, append, and targeted patch tools with conflict detection and write auditing.
7. Add schedules, ownership, database leasing, restart recovery, and notifications.
8. Complete real Feishu/Neon end-to-end tests, security evaluations, operator documentation, and deployment verification.

## 14. References

- [Official Lark CLI](https://github.com/larksuite/cli)
- [Lark CLI integration in a self-developed Agent](https://open.feishu.cn/document/mcp_open_tools/feishu-cli/embed-feishu-cli-in-agent)
- [Vercel AI SDK Agents](https://ai-sdk.dev/docs/agents/overview)
- [Vercel AI SDK workflow patterns](https://ai-sdk.dev/docs/agents/workflows)
- [Vercel AI SDK provider architecture](https://ai-sdk.dev/docs/foundations/providers-and-models)
- [Neon pricing and free plan](https://neon.com/pricing)
