# Minori

Minori is an open-ended Team Agent for Feishu conversations where the Minori Feishu App is available. It uses a Dedicated Knowledge User through `lark-cli`, keeps 30 days of Agent Thread history in Neon, and replies with clickable Feishu sources. The Agent can answer directly, read authorized knowledge, and autonomously create, append, or make one exact targeted replacement in a document. It has no delete, move, overwrite, permission, sharing, raw API, shell, arbitrary HTTP, or filesystem tool.

## Required services

- Ubuntu 24.04 LTS x86_64 host with Docker Engine and the Compose plugin. Follow Docker's [official Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/); do not use the convenience script for production.
- A Neon PostgreSQL project. Copy its pooled connection string from the **Connect** dialog as described in the [Neon connection guide](https://neon.com/docs/connect/connection-errors).
- A Feishu custom app with a bot, long connection, and a Dedicated Knowledge User.
- An OpenAI API key, or a Responses-compatible provider URL that supports structured tool calls.

## Feishu app

1. Enable the bot and configure its Feishu App availability for the people and conversations that should be able to invoke Minori.
2. Enable long connection event delivery and subscribe to `im.message.receive_v1`.
3. Grant the message-read/reply permissions required by the app and `im:message.reactions:write_only` for the Processing Reaction.
4. Add the bot to the intended groups. Feishu App availability and the events Feishu delivers to Minori are the sole admission boundary; Minori has no second chat or membership allowlist.
5. Record the app ID, app secret, and bot open ID. The bot open ID is required for mention and reply-thread activation checks.

Every Feishu-delivered private message can invoke Minori. In groups, a direct mention, a reply to Minori, or a continuation in a known Agent Thread can invoke it; unrelated group-timeline messages remain ignored. External collaborators may invoke Minori when Feishu delivers their messages under the app's availability settings.

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
- `AGENT_MAX_STEPS` (default `20`) and `AGENT_TIMEOUT_MS` (default `180000`)
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

The application container runs as UID 10001 with a read-only root filesystem. Only the health port is bound, and only on `127.0.0.1`. Feishu communication uses the outbound long connection. Create, append, and patch do not require confirmation; each is recorded in the sanitized `agent_runs` / `tool_runs` audit trail. Append and patch read the current revision, and a targeted patch fails rather than overwriting when its exact phrase is not unique or the document changed concurrently.

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

The deployment operator must be able to use Docker and read the repository. If Docker was just installed, add that operator to the host's `docker` group and start a fresh login session before continuing.

Keep the repository checkout on the host. For the first release, build the exact commit and authenticate the Dedicated Knowledge User before deployment. Run the authorization container directly in an interactive terminal so `/dev/tty` is available:

```bash
COMMIT_SHA="$(git rev-parse HEAD)"
git cat-file -e "${COMMIT_SHA}^{commit}"
git archive "$COMMIT_SHA" | docker build -t "minori:${COMMIT_SHA}" -
docker run --rm -it \
  --env-file /opt/minori/minori.env \
  -v /opt/minori/lark:/var/lib/minori/lark \
  "minori:${COMMIT_SHA}" npm run lark:auth
./scripts/deploy-vultr.sh "$COMMIT_SHA"
```

The archive build guarantees that the image receiving the App Secret and OAuth mount comes only from the verified commit, never dirty or untracked working-tree files. The deploy command accepts only a full 40-character commit SHA. It builds the image and loads the production Compose contract from that same detached commit, verifies the candidate image, applies backward-compatible migrations, replaces the running service under the stable `minori` Compose project, waits for readiness, and restores and verifies both the previous image and its saved Compose contract on failure. Because migrations run before replacement and rollback does not downgrade the database, the open-admission migration intentionally retains the obsolete `allowed_chats` table as inert compatibility for the fixed-point image. The current runtime never reads or writes that table; remove it only in a later release after the production rollback floor advances beyond `4f936ab`. Sanitized release records and commit-addressed `<commit>.compose.yaml` contracts are written under `/opt/minori/releases`. If an already-running Minori image has no saved contract, deployment stops before replacing it.

The Lark mount survives removal of the one-off authorization container. If OAuth expires, credentials are lost, or the Dedicated Knowledge User changes, rerun the same interactive `npm run lark:auth` command; Minori intentionally has no credential backup or silent fallback identity.

Rollback requires an already-built exact image. If the target is unhealthy, the command restores and verifies the version that was running before the attempt:

```bash
./scripts/rollback-vultr.sh minori:<full-commit-sha>
```

## Real acceptance

After deployment:

1. Ask a general question in a group where the app is available by mentioning Minori; confirm it can answer without forcing a knowledge workflow.
2. Continue in the same Agent Thread without mentioning it again, then ask a knowledge question and open the returned source link.
3. Ask a question in a private chat, including from an external collaborator allowed by the Feishu App availability policy.
4. Create a disposable document under an authorized fixture parent, append a clearly marked section, and patch one unique phrase.
5. Make a concurrent edit before another patch; confirm Minori re-reads or reports a conflict rather than overwriting.
6. Confirm the final reply includes the document URL and concise write receipt, and the audit table records sanitized create, append, patch, and conflict outcomes.
7. Restart the service, confirm conversation continuity, Lark readiness, and another knowledge read, then remove the disposable document manually in Feishu because Minori has no delete tool.

Record only message IDs, document URLs, commit SHA, image tag, timestamps, readiness categories, and pass/fail outcomes in the gitignored `acceptance.local.jsonl`. Do not record tokens, message bodies, or document contents.

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

For credential rotation, update `/opt/minori/minori.env` with mode `0600`, reauthenticate `/opt/minori/lark` when rotating the CLI app or user grant, then deploy an explicit commit again. Revoke the old credential only after readiness and the real group/private acceptance checks pass.
