# Cloud Team Agent Implementation Plan

**Date:** 2026-08-05  
**Design:** `docs/superpowers/specs/2026-08-04-cloud-team-agent-design.md`  
**Target repository:** `/Users/zhangqianze/Documents/minori`  
**Delivery strategy:** vertical slices, with a runnable and testable result after every milestone

## 1. Outcome

Deliver a single-container TypeScript service that:

- receives messages from approved Feishu groups and eligible private chats;
- runs an open-ended Vercel AI SDK Agent;
- uses the official Lark CLI under a dedicated Feishu user identity;
- searches, reads, creates, appends to, and patches knowledge-base documents;
- executes autonomous scheduled Agent tasks;
- persists conversations, schedules, idempotency, and audit state in Neon PostgreSQL;
- runs without Redis or a local persistent database volume.

## 2. Technical Baseline

- Node.js 22 LTS and TypeScript with ESM.
- npm with a committed lockfile.
- Vercel AI SDK `ToolLoopAgent` and a central provider registry.
- Vercel AI Gateway as the default provider path; model selected by `AI_MODEL`.
- Feishu official Node SDK for long-connection events and replies.
- Official `@larksuite/cli`, pinned through the npm lockfile and Docker build.
- Neon PostgreSQL using `pg` and Drizzle ORM.
- Zod for configuration and tool schemas.
- Fastify for liveness and readiness endpoints.
- Vitest for unit, integration, and contract tests.
- Pino-compatible structured logs with explicit redaction.

## 3. Repository Shape

```text
minori/
├── docs/
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── drizzle/
├── scripts/
│   ├── lark-auth.ts
│   └── verify-runtime.ts
├── src/
│   ├── agent/
│   │   ├── create-agent.ts
│   │   ├── instructions.ts
│   │   ├── model-registry.ts
│   │   ├── run-agent.ts
│   │   └── sources.ts
│   ├── audit/
│   │   └── audit-service.ts
│   ├── config/
│   │   └── config.ts
│   ├── db/
│   │   ├── client.ts
│   │   ├── migrate.ts
│   │   ├── repositories/
│   │   └── schema.ts
│   ├── feishu/
│   │   ├── eligibility.ts
│   │   ├── gateway.ts
│   │   ├── membership-cache.ts
│   │   ├── messages.ts
│   │   └── types.ts
│   ├── health/
│   │   └── health-server.ts
│   ├── lark/
│   │   ├── auth-status.ts
│   │   ├── command-catalog.ts
│   │   ├── errors.ts
│   │   ├── lark-runner.ts
│   │   ├── read-tools.ts
│   │   ├── schemas.ts
│   │   └── write-tools.ts
│   ├── scheduler/
│   │   ├── recurrence.ts
│   │   ├── schedule-service.ts
│   │   └── scheduler-loop.ts
│   ├── app.ts
│   └── main.ts
├── test/
│   ├── agent/
│   ├── contract/
│   ├── db/
│   ├── feishu/
│   ├── fixtures/
│   ├── lark/
│   └── scheduler/
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── compose.yaml
├── drizzle.config.ts
├── package-lock.json
├── package.json
├── README.md
└── tsconfig.json
```

Files may be split further when a module becomes difficult to understand in isolation. Domain boundaries in this plan take precedence over exact filenames.

## 4. Milestone 1 — Bootable Service and Quality Gates

### Goal

Establish a minimal service that builds, tests, runs in Docker, validates configuration, and exposes health endpoints.

### Work

1. Create `package.json`, lockfile, TypeScript configuration, and scripts:
   - `build`
   - `dev`
   - `start`
   - `typecheck`
   - `test`
   - `test:integration`
   - `db:generate`
   - `db:migrate`
   - `lark:auth`
   - `verify`
2. Implement `src/config/config.ts` as the only environment-variable reader.
3. Validate required and optional configuration with Zod and return secret-free startup errors.
4. Add `src/health/health-server.ts` with:
   - `GET /health/live` for process liveness;
   - `GET /health/ready` with component status categories.
5. Add structured logging and redaction rules for tokens, cookies, secrets, authorization URLs, and connection strings.
6. Add `src/app.ts` for dependency construction and `src/main.ts` for lifecycle and signal handling.
7. Add a multi-stage `Dockerfile`, `.dockerignore`, and `compose.yaml`.
8. Run the final image as a non-root user.

### Tests

- Configuration accepts a minimal valid environment.
- Missing configuration names the missing field but never prints secret values.
- Health endpoints return the expected schema.
- Shutdown closes the HTTP server cleanly.
- `npm run build`, `npm run typecheck`, and `npm test` pass in the container.

### Done when

`docker compose up` starts the service and liveness is healthy without requiring Feishu, Neon, or a model to be operational. Readiness correctly reports those dependencies as unconfigured.

## 5. Milestone 2 — Neon Persistence and Idempotency

### Goal

Create the durable data layer before connecting external event sources.

### Work

1. Define Drizzle schema for:
   - `allowed_chats`;
   - `conversations`;
   - `messages`;
   - `processed_events`;
   - `agent_runs`;
   - `tool_runs`;
   - `write_operations`;
   - `schedules`;
   - `schedule_runs`.
2. Add primary keys, foreign keys, unique event constraints, schedule-run uniqueness, and indexes for active conversations and due schedules.
3. Generate and commit the initial SQL migration.
4. Implement repositories behind interfaces so the Agent, Feishu gateway, and scheduler do not depend on Drizzle query syntax.
5. Implement atomic event acquisition:
   - first worker inserts the event as `processing`;
   - duplicates read the existing state;
   - completion records a durable outcome;
   - stale `processing` events can be reconciled safely.
6. Add the daily retention job for message and audit metadata.
7. Extend readiness with a database probe that uses a short timeout.

### Tests

- Migrations apply to a clean PostgreSQL database.
- Repositories round-trip every core entity.
- Concurrent acquisition of the same event produces one owner.
- Unique schedule/run keys prevent duplicate runs.
- Retention removes only records older than configured limits.
- Database errors do not expose `DATABASE_URL`.

### Done when

The service can restart with persisted conversations and idempotency state, and database integration tests run against a disposable PostgreSQL database.

## 6. Milestone 3 — Safe Lark CLI Runtime and Read Tools

### Goal

Prove that the application can authenticate and perform typed knowledge-base reads without giving the model a shell.

### Work

1. Install and pin the official Lark CLI.
2. Implement `scripts/lark-auth.ts` to:
   - start the non-blocking user login flow;
   - show the authorization URL only to the operator;
   - poll or resume with the device code;
   - verify login status and required scopes.
3. Store the CLI credential directory only in the configured secret/persistent mount.
4. Implement `LarkRunner` using `child_process.spawn` with `shell: false`.
5. Create a fixed command catalog; callers select a command ID and typed arguments rather than passing executable text.
6. Parse Lark CLI JSON success and error envelopes into a discriminated TypeScript result.
7. Enforce timeouts, maximum stdout/stderr sizes, user identity, JSON format, redaction, and cancellation.
8. Implement read tools for:
   - Wiki/Drive search;
   - knowledge-space metadata and node tree;
   - document metadata and URL;
   - document content fetch.
9. Record sanitized tool-run metadata without retaining fetched document bodies.
10. Extend readiness with Lark CLI presence and login status.

### Tests

- Arguments containing spaces, quotes, newlines, semicolons, pipes, or substitutions remain literal arguments.
- No tool can select an executable outside the command catalog.
- Success, API error, auth error, timeout, cancellation, oversized output, and malformed JSON are classified correctly.
- Tokens and authorization data are redacted from logs and errors.
- Contract tests replay captured, sanitized CLI envelopes.
- An opt-in real integration test searches and reads a document from the dedicated test knowledge space.

### Done when

Running a local verification command can search and fetch a real Feishu document through Lark CLI as the dedicated user, with no generic shell interface in application code.

## 7. Milestone 4 — Feishu Gateway and Eligibility

### Goal

Connect approved Feishu conversations to a deterministic message handler before adding model reasoning.

### Work

1. Configure the official Feishu Node SDK and long-connection client.
2. Normalize message events into internal message envelopes with event ID, message ID, chat ID, thread/root ID, sender open ID, chat type, content type, and timestamp.
3. Store allowed chats in PostgreSQL, with environment bootstrap for the initial list.
4. Implement group eligibility and private-chat eligibility.
5. Implement the five-minute membership cache with explicit invalidation and fail-closed behavior.
6. Acquire the event idempotency record before handling a message.
7. Persist the conversation and inbound message.
8. Add reply helpers for text, citations, progress notices, errors, and write receipts.
9. Add a deterministic echo/status handler used only for gateway verification.
10. Send operational auth failures only to configured administrator open IDs.

### Tests

- Allowed group member is accepted.
- Disallowed group is rejected.
- Eligible private-chat user is accepted.
- User in no allowed group is rejected.
- Membership API failure fails closed.
- Cache expiry and invalidation work.
- Duplicate Feishu events produce at most one reply.
- Unsupported message types return a safe, useful response.

### Done when

A real message in a configured group and an eligible private chat receives one deterministic response, while ineligible traffic never reaches Agent or Lark tools.

## 8. Milestone 5 — Open-ended Knowledge Agent

### Goal

Replace the deterministic handler with a multi-turn AI SDK Agent that can autonomously use read tools and cite sources.

### Work

1. Implement the provider registry and configure Vercel AI Gateway by default.
2. Build `ToolLoopAgent` with:
   - team-Agent instructions;
   - strict read-tool schemas;
   - runtime context containing trusted trigger metadata;
   - step, time, and token limits;
   - per-step audit callbacks.
3. Load a bounded, recent conversation window from PostgreSQL.
4. Keep retrieved document bodies in run memory only.
5. Normalize retrieved sources into title, URL, token, and evidence snippets.
6. Require grounded factual answers to expose source metadata to the response formatter.
7. Persist assistant messages, model usage, and run outcomes.
8. Send an immediate progress acknowledgement only when the response will exceed the fast-response threshold.
9. Implement cancellation when the user requests it or the service shuts down.

### Tests and evaluations

- Direct conversational answer without unnecessary retrieval.
- Iterative search with multiple queries.
- Parent/child navigation and multi-document synthesis.
- Working source links in the final Feishu response.
- Honest response with no source.
- Model-provider substitution through configuration.
- Prompt-injection documents cannot change trusted trigger metadata or reveal secrets.
- Step, token, time, and cancellation limits terminate cleanly.

### Done when

An allowed member can conduct a multi-turn Feishu conversation in which the Agent searches and reads real team documents as needed and returns useful, source-linked answers.

## 9. Milestone 6 — Autonomous Knowledge Writes

### Goal

Allow the Agent to create, append, and patch documents directly while keeping the effect surface narrow and auditable.

### Work

1. Add typed write tools for:
   - create document;
   - append content;
   - patch a known block or section.
2. Do not add delete, move, permission, sharing, raw API, full-overwrite, shell, generic HTTP, or filesystem tools.
3. Require a trusted eligible-user or registered-schedule trigger in run context before any write tool executes.
4. Read target content and metadata immediately before updates.
5. Calculate and store the pre-write revision or normalized content hash.
6. Use the smallest available Lark CLI patch operation.
7. On precondition mismatch, re-read once and recompute; return a conflict instead of overwriting when a safe merge remains ambiguous.
8. Record write intent before execution and outcome after execution.
9. Reconcile uncertain create or patch results by reading the target before retrying.
10. Send a write receipt with action, target, concise change summary, and document URL.

### Tests and evaluations

- Eligible user can trigger create, append, and targeted patch.
- Retrieved document text cannot independently trigger a write.
- Read-only runs cannot gain write authority through prompt content.
- Concurrent edit causes recompute or safe conflict, never blind overwrite.
- Duplicate events and retried tool calls do not duplicate a write.
- Uncertain results are reconciled before retry.
- Every completed write has one durable audit record and one visible receipt.
- The Agent cannot discover or call a destructive command.

### Done when

The Agent can autonomously modify a real test knowledge space from Feishu and every effect is traceable, idempotent, and protected from blind overwrites.

## 10. Milestone 7 — Autonomous Schedules

### Goal

Allow eligible members to register recurring Agent work that survives restarts and writes autonomously.

### Work

1. Implement strict schedule schemas with recurrence, timezone, owner, instructions, context, and notification target.
2. Add Agent tools to create, list, inspect, edit, pause, resume, and cancel schedules.
3. Enforce owner access; configured administrators may manage all schedules.
4. Implement the scheduler loop using PostgreSQL as source of truth.
5. Acquire schedules with a lease and unique schedule/run key.
6. Coalesce missed intervals into one overdue execution after restart.
7. Invoke the same Agent runtime with a trusted scheduler trigger and schedule-owner identity.
8. Persist run status and notify the configured chat on success or failure.
9. Prevent document text or model output from manufacturing a trusted scheduler trigger.
10. Add daily retention as an internal registered maintenance schedule.

### Tests

- Natural-language schedule intent becomes a valid typed schedule.
- Owner and administrator management rules hold.
- Restart reloads enabled schedules.
- Two scheduler loops cannot claim the same run.
- Missed intervals produce one coalesced run.
- Paused or cancelled schedules do not execute.
- Scheduled Agent run receives write authority and produces a receipt.
- Failures are recorded and do not create rapid retry loops.

### Done when

A team member can schedule a recurring knowledge-base update in Feishu, restart the container, and observe exactly one autonomous run and notification at the next due time.

## 11. Milestone 8 — Production Hardening and Deployment Verification

### Goal

Close the security, recovery, documentation, and deployment gaps required for an MVP rollout.

### Work

1. Add reconciliation on startup for stale events, Agent runs, write operations, and schedule runs.
2. Add bounded retry policies by error category.
3. Add readiness detail for PostgreSQL, Feishu long connection, Lark CLI login, and model configuration.
4. Add security regression tests for secrets, prompt injection, CLI injection, unauthorized chats, and destructive-tool absence.
5. Add a curated Agent evaluation set covering the design's acceptance criteria.
6. Verify the image with a read-only root filesystem and the minimum writable credential/temp mounts.
7. Document:
   - Feishu app and event setup;
   - dedicated user and OAuth setup;
   - required Lark scopes;
   - allowed groups and administrators;
   - Neon creation and migrations;
   - Vercel AI Gateway/model configuration;
   - local Docker validation;
   - generic cloud-container deployment;
   - credential rotation, backup, restore, and incident response.
8. Add `scripts/verify-runtime.ts` to check external prerequisites without exposing secrets.
9. Run the complete acceptance test in a dedicated Feishu test group and test knowledge space.

### Tests

- Cold start with valid secrets reaches ready state.
- Revoked Lark auth blocks knowledge tools and privately notifies administrators.
- Neon outage blocks writes and schedules that cannot be audited.
- Model outage is not reported as missing knowledge.
- Process interruption during a write is reconciled without duplicate effect.
- Read-only filesystem container passes runtime verification.
- Full unit, integration, contract, evaluation, and Docker verification suites pass.

### Done when

All 14 design acceptance criteria have recorded evidence and the same image runs locally and on the chosen cloud container platform.

## 12. Commit Strategy

Use small, independently verifiable commits. Suggested sequence:

1. `chore: scaffold team agent service`
2. `feat: add postgres persistence and event idempotency`
3. `feat: add safe lark cli read adapter`
4. `feat: connect feishu gateway and eligibility checks`
5. `feat: add open-ended knowledge agent`
6. `feat: enable audited autonomous document writes`
7. `feat: add durable autonomous schedules`
8. `docs: complete deployment and operations guide`

Do not combine real credentials, generated local auth state, or `.env` values with any commit.

## 13. Verification Commands

Every implementation milestone must finish with the relevant subset of:

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
npm run verify
docker compose build
docker compose up
```

Real Feishu and model integration suites remain opt-in and require explicit test credentials. Mock and contract suites run by default in CI.

## 14. External Setup Needed During Implementation

The following values are intentionally supplied at integration time rather than embedded in the repository:

- Neon `DATABASE_URL`.
- Feishu app ID, app secret, and long-connection event configuration.
- Dedicated Feishu user login and approved Lark scopes.
- IDs of approved Feishu groups.
- Administrator Feishu open IDs.
- Vercel AI Gateway credential and `AI_MODEL`.
- A dedicated test knowledge space and test group.

Local scaffolding, unit tests, mocked contracts, Docker build, and database schema can be completed before these external values are available. Real end-to-end verification begins once they are provided.
