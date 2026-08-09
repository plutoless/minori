# Minori

Minori is an open-ended Team Agent for Feishu conversations where the Minori Feishu App is available. It uses a Dedicated Knowledge User through `lark-cli`, keeps 30 days of invoked conversation history in Neon, and replies with clickable Feishu sources. The Agent can answer directly, read authorized knowledge, and autonomously create, append, or make one exact targeted replacement in a document. It has no delete, rename, move, overwrite, trash, permission, sharing, raw API, shell, arbitrary HTTP, or filesystem tool.

## Required services

- Ubuntu 24.04 LTS x86_64 host with Docker Engine and the Compose plugin. Follow Docker's [official Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/); do not use the convenience script for production.
- A Neon PostgreSQL project. Copy its pooled connection string from the **Connect** dialog as described in the [Neon connection guide](https://neon.com/docs/connect/connection-errors).
- A Feishu custom app with a bot, long connection, and a Dedicated Knowledge User.
- An OpenAI API key, or a Responses-compatible provider URL that supports structured tool calls.

## Feishu app

1. Enable the bot and configure its Feishu App availability for the people and conversations that should be able to invoke Minori.
2. Enable long connection event delivery and subscribe to `im.message.receive_v1`.
3. Grant the existing message-read/reply permissions and `im:message.reactions:write_only` for the Processing Reaction. For Live Group History and real member names, also grant exactly `im:message.group_msg` and `im:chat.members:read`, then publish an app version containing both grants. Do not add contact, media, chat-management, or user-impersonation authority.
4. Add the bot to the intended groups. Feishu App availability and the events Feishu delivers to Minori are the sole admission boundary; Minori has no second chat or membership allowlist.
5. Record the app ID, app secret, and bot open ID. The bot open ID is required for mention and direct-reply activation checks.

Minori sends ordinary private and group replies; Feishu topic-mode groups are unsupported. Every Feishu-delivered private message can invoke Minori. In an ordinary-message group, only a direct mention or a direct reply to Minori invokes it. Other group messages are context and never trigger. All invocations in one group share the group `chat_id` as their Group Context and serialize, while different groups and private chats retain the global four-conversation concurrency. External collaborators may invoke Minori when Feishu delivers their messages under the app's availability settings.

When a group invocation begins, Minori transiently reads an initial Live Group History window of at most 20 ordinary messages at or before that invocation's cutoff. It labels supported text and rich-text messages with real display names resolved from the current group's member list, represents unsupported content with typed omission markers such as `[未读取：image 消息]`, and may page older messages through the run-scoped `readEarlierGroupHistory` tool. That tool cannot select another group or a later cutoff.

Feishu remains the source of truth for ordinary group history: Minori does not mirror those message bodies, display names, or member Open IDs into Neon. Only invoked requests and Minori replies enter retained conversation history; Group Context audit metadata contains availability, counts, page count, cutoff, and a stable error category. If the history read is unavailable, Minori records `group_history_unavailable` and continues with prior Retained Conversation History, a stable limitation fact, and the Current Invocation. If only member-name lookup is unavailable, the Live Group History remains loaded with unresolved-name labels and Minori records `group_member_names_unavailable`; it does not claim that history itself was unavailable. Neither path exposes a raw provider error.

The same existing app is also bound to Lark CLI; Minori never creates a second app. Its user OAuth capabilities must cover the Docs, Drive, and Wiki domains. The Dedicated Knowledge User's native Feishu content permissions are the content boundary: share only the intended spaces, folders, and documents with that account. Every delivered member, including an external collaborator, receives answers and operations from this same Dedicated Knowledge User's Knowledge Boundary—not permissions scoped to the requesting member. Minori does not add a second content allowlist or elevate that user's access.

## Local configuration

```bash
cp .env.example .env
# Edit .env and replace both Lark directories with absolute writable paths.
mkdir -p /absolute/path/to/minori-lark/config /absolute/path/to/minori-lark/data
npm ci
npm run build
npm run db:migrate
npm run lark:auth
npm run runtime:verify
```

The operator commands load `.env` when it exists; variables already supplied by the container or shell take precedence. `npm run lark:auth` validates both Lark directories, binds the existing app using its secret over stdin, and starts Docs/Drive/Wiki device authorization. The operator opens the verification URL shown only on that interactive terminal (`/dev/tty`) and authorizes the intended Dedicated Knowledge User. The URL never enters stdout, stderr, logs, or persistent files; the device code is never displayed; and the command fails closed if no operator TTY is available. After authorization it prints only a sanitized user-identity status. Both directories must already be writable by the operator.

Required environment values:

- `DATABASE_URL`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BOT_OPEN_ID`
- `OPENAI_API_KEY`
- `AI_MODEL` (the release example uses `5.6-terra`)
- optional `OPENAI_BASE_URL`; it must support the OpenAI Responses API and structured tool calls
- `AGENT_MAX_STEPS` (default `40`) and `AGENT_TIMEOUT_MS` (default `300000`, or 300 seconds)
- `LARKSUITE_CLI_CONFIG_DIR` and `LARKSUITE_CLI_DATA_DIR`

OpenAI requests set `store: false`. Minori never falls back to Chat Completions when a custom base URL fails the Responses/tool-call probe.

## Tests and local container

```bash
npm run verify
npm run test:integration
docker compose build
docker compose run --rm app npm run runtime:verify
docker compose up -d
curl --fail http://127.0.0.1:3000/health/ready
```

The application container runs as UID/GID `10001:10001` with a read-only root filesystem. The production image is `amd64`. Only the health port is bound, and only on `127.0.0.1`. Feishu communication uses the outbound long connection. Create, append, and patch do not require confirmation; each is recorded in the sanitized `agent_runs` / `tool_runs` audit trail. Append and patch read the current revision, and a targeted patch fails rather than overwriting when its exact phrase is not unique or the document changed concurrently.

## Vultr host bootstrap

Install Docker from its official apt repository, then prepare operator-only state:

```bash
operator="$(id -un)"
operator_group="$(id -gn)"
sudo install -d -m 0750 -o "$operator" -g "$operator_group" /opt/minori/releases
sudo install -d -m 0750 -o 10001 -g 10001 /opt/minori/lark
sudo install -m 0600 -o "$operator" -g "$operator_group" \
  deploy/vultr/env.example /opt/minori/minori.env
sudoedit /opt/minori/minori.env
```

The deployment operator must be able to use Docker and read the operator-only host state. If Docker was just installed, add that operator to the host's `docker` group and start a fresh login session before continuing. The initial interactive OAuth authorization uses the approved release image and persistent Lark mount; it is not a deployment path. The Lark mount survives that one-off authorization container. If OAuth expires, credentials are lost, or the Dedicated Knowledge User changes, repeat the interactive authorization with the persistent mount; Minori intentionally has no credential backup or silent fallback identity.

## CI/CD operator runbook

All production releases use Deployment Protocol `v1`: GitHub sends the approved immutable digest through the restricted server entrypoint. The host accepts only that protocol and keeps the current healthy image plus its two most recent verified healthy predecessors as its Local Rollback Set. Operators do not run a separate host-side release or rollback command. A rollback does not downgrade the database; the current runtime never reads or writes that table, which remains as inert `allowed_chats` compatibility.

### Normal PR and merge

Open a pull request to the Release Line, `main`. It must complete the observed required checks `CI / verify`, `CI / integration`, and `CI / image-amd64`; merge only through the pull request. The Emergency Merge Bypass belongs only to GitHub user `plutoless` (actor ID `471561`) and is pull-request-only, for repairing broken CI governance. It never permits a direct push, tag mutation, deployment, or Production Approval bypass.

### Public-package bootstrap

For the first CI release, create `main` at the deployed `v0.1.0` commit, configure the production Environment and restricted deployment key, then merge the CI/CD pull request. Then create and push `v0.1.1` from `main`. The tag causes GitHub to build and publish the first package, while deployment waits at Production Approval. Before approving, the operator changes the new GHCR package to **Public** exactly once, and Vultr proves an anonymous digest pull of the built immutable digest. The operator only then grants Production Approval. Do not add a package-admin token or bootstrap image.

### Release Intent and Production Approval

A protected `v*` tag whose version matches `package.json` and whose commit is contained in `main` is the Release Intent. GitHub validates it, publishes exactly one `linux/amd64` image, and passes its immutable digest unchanged to the GitHub `production` Environment. The same person may create the tag and grant Production Approval: Prevent self-review is disabled, making this a two-step confirmation, not two-person separation. GitHub Deployment status, Actions result/email, job summary, and sanitized server release record are the only notification surfaces.

### Failure-category diagnosis

Use GitHub deployment status, Actions result/email, the concise job summary, and the sanitized server release record to identify the stable failure category. Do not disclose secret values or raw log bodies. A GitHub outage means the current healthy release stays running; use interactive access for diagnosis, not a manual or emergency deploy path. There is no second Deployment Protocol `v1` release command.

### One-time transition rehearsal

After the first automated release is healthy, perform the single bounded rehearsal: `v0.1.1` -> `v0.1.0` -> the same `v0.1.1` digest. It reuses the saved `v0.1.0` contract and already approved `v0.1.1` digest without rebuilding either image, verifies readiness after each transition, and stops if either exact target or readiness check is unhealthy. This is a one-time acceptance action, not a normal rollback or alternate deploy path.

## Real acceptance

After both Live Group History permissions are granted and published, verify through sanitized probes that history loading and group-member name resolution succeed in an ordinary-message test group containing Minori. If either grant is pending approval or publication, keep the current production image healthy and stop before Group Context acceptance.

Against one exact commit and image:

1. Send a private message; verify an ordinary reply, `Typing` after durable persistence, and terminal `Typing` removal.
2. In an ordinary-message group, send several human messages from two people, then directly mention Minori and request a summary. Verify both display names and pre-trigger content influence the answer without creating a topic.
3. Send a new top-level direct mention in the same group and verify it serializes under the same Group Context.
4. Directly reply to Minori without another mention and verify it invokes Minori with recent group history.
5. Send an unrelated ordinary group message and verify it does not enqueue an Agent event.
6. Ask for information older than 20 messages and verify `readEarlierGroupHistory` is audited with a page count greater than one while ordinary group bodies and names remain absent from Neon.
7. Verify `group_history_unavailable` locally with a controlled permission/API double; do not revoke a production permission during acceptance.
8. Restart the service and repeat one private and one group invocation. Verify readiness, persisted OAuth, Group Context, and ordinary non-topic replies remain healthy.
9. Re-run one real knowledge read and source link, then disposable create, append, and exact patch operations. Preserve the Write Replay Boundary evidence, and manually remove the disposable document in Feishu because Minori has no delete tool.

Append one object per check to the gitignored `acceptance.local.jsonl`. Records may contain only the check name, exact full commit and image, trigger/reply IDs for invoked messages, cutoff timestamp, history status/count/page count, readiness category, timestamp, and pass/fail result. Never record group-history bodies, member names, Open IDs, prompts, provider output, OAuth data, environment values, credentials, or document contents.

## Operations

Readiness exposes categories only:

```bash
curl --fail http://127.0.0.1:3000/health/ready
docker logs --since 30m minori 2>&1 | tail -200
```

The readiness response and recent logs contain component categories and stable error codes only. Never paste raw provider, Feishu, database, or OAuth response bodies into an incident record.

Troubleshooting:

- `database`: verify the Neon connection string, TLS, migrations, and host egress.
- `model`: verify `OPENAI_API_KEY`, `AI_MODEL`, and that `OPENAI_BASE_URL` supports Responses plus structured tool calls.
- `lark`: rerun `npm run lark:auth` with the persistent credential mount and verify the Dedicated Knowledge User still has access.
- `feishu`: verify app credentials, bot open ID, long connection, event subscription, bot availability, and app permissions.
- `worker`: inspect redacted logs for stable error codes; do not copy raw secrets into tickets.

For credential rotation, update `/opt/minori/minori.env` with mode `0600`, reauthenticate `/opt/minori/lark` when rotating the CLI app or user grant, then create a later approved GitHub Release Intent. Revoke the old credential only after readiness and the real group/private acceptance checks pass.
