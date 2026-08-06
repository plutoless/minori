# Minori

Minori is a read-only team Agent for approved Feishu conversations. It uses a Dedicated Knowledge User through `lark-cli`, keeps 30 days of Agent Thread history in Neon, and replies with clickable Feishu sources. Plan 1 has no knowledge-write tools, implicit long-term memory, public webhook, or proactive alert channel.

## Required services

- Ubuntu 24.04 LTS x86_64 host with Docker Engine and the Compose plugin. Follow Docker's [official Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/); do not use the convenience script for production.
- A Neon PostgreSQL project. Copy its pooled connection string from the **Connect** dialog as described in the [Neon connection guide](https://neon.com/docs/connect/connection-errors).
- A Feishu custom app with a bot, long connection, and a Dedicated Knowledge User.
- An OpenAI API key, or a Responses-compatible provider URL that supports structured tool calls.

## Feishu app

1. Enable the bot and make it available to the intended team.
2. Enable long connection event delivery and subscribe to `im.message.receive_v1`.
3. Grant the message-read/reply permissions required by the app and `im:message.reactions:write_only` for the Processing Reaction.
4. Add the bot only to intended groups. Record those group IDs as `ALLOWED_CHAT_IDS`.
5. Record the app ID, app secret, and bot open ID. The bot open ID is required for mention and reply-thread activation checks.

An Eligible Member is a current member of any Allowed Chat. They can use Minori in that group or in a private chat with the bot.

## Local configuration

```bash
cp .env.example .env
# Edit .env and replace LARKSUITE_CLI_CONFIG_DIR with an absolute writable path.
mkdir -p /absolute/path/to/minori-lark
npm ci
npm run build
npm run db:migrate
npm run lark:auth
npm run runtime:verify
```

The operator commands load `.env` when it exists; variables already supplied by the container or shell take precedence. `npm run lark:auth` validates that `LARKSUITE_CLI_CONFIG_DIR` is absolute, initializes the CLI app, prints only browser verification URLs, completes the device-code flow, and prints a sanitized user-identity status. It never prints tokens. The directory must already be writable by the operator. The installed CLI uses `--json`; the script also performs the required `--device-code` continuation after `--no-wait`.

Required environment values:

- `DATABASE_URL`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BOT_OPEN_ID`
- `ALLOWED_CHAT_IDS`, comma-separated
- `OPENAI_API_KEY`
- `AI_MODEL` (default `gpt-5.6-terra`)
- optional `OPENAI_BASE_URL`; it must support the OpenAI Responses API and structured tool calls
- `LARKSUITE_CLI_CONFIG_DIR`

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

The application container runs as UID 10001 with a read-only root filesystem. Only the health port is bound, and only on `127.0.0.1`. Feishu communication uses the outbound long connection.

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

Keep the repository checkout on the host. For the first release, build the exact commit and authenticate the Dedicated Knowledge User before deployment:

```bash
COMMIT_SHA="$(git rev-parse HEAD)"
docker build -t "minori:${COMMIT_SHA}" .
docker run --rm -it \
  --env-file /opt/minori/minori.env \
  -v /opt/minori/lark:/var/lib/minori/lark \
  "minori:${COMMIT_SHA}" npm run lark:auth
./scripts/deploy-vultr.sh "$COMMIT_SHA"
```

The deploy command accepts only a full 40-character commit SHA. It builds the image and loads the production Compose contract from that same detached commit, verifies the candidate image, applies backward-compatible migrations, replaces the running service under the stable `minori` Compose project, waits for readiness, and restores and verifies both the previous image and its saved Compose contract on failure. Sanitized release records and commit-addressed `<commit>.compose.yaml` contracts are written under `/opt/minori/releases`. If an already-running Minori image has no saved contract, deployment stops before replacing it.

Rollback requires an already-built exact image. If the target is unhealthy, the command restores and verifies the version that was running before the attempt:

```bash
./scripts/rollback-vultr.sh minori:<full-commit-sha>
```

## Real acceptance

After deployment:

1. Ask a question in one Allowed Chat by mentioning Minori.
2. Continue in the same Agent Thread without mentioning it again.
3. Ask a question in a private chat as an Eligible Member.
4. Confirm both answers read a real Feishu document and include a working source URL.
5. Restart the container, repeat one question, and confirm conversation continuity and removal of stale Processing Reactions.

Record only message IDs and source URLs in the gitignored `acceptance.local.jsonl`. Do not record tokens, message bodies, or document contents.

## Operations

Readiness exposes categories only:

```bash
curl --fail http://127.0.0.1:3000/health/ready
docker logs --since 30m minori 2>&1 | tail -200
```

Troubleshooting:

- `database`: verify the Neon connection string, TLS, migrations, and host egress.
- `model`: verify `OPENAI_API_KEY`, `AI_MODEL`, and that `OPENAI_BASE_URL` supports Responses plus structured tool calls.
- `lark`: rerun `npm run lark:auth` with the persistent credential mount and verify the Dedicated Knowledge User still has access.
- `feishu`: verify app credentials, bot open ID, long connection, event subscription, bot availability, and app permissions.
- `worker`: inspect redacted logs for stable error codes; do not copy raw secrets into tickets.

For credential rotation, update `/opt/minori/minori.env` with mode `0600`, reauthenticate `/opt/minori/lark` when rotating the CLI app or user grant, then deploy an explicit commit again. Revoke the old credential only after readiness and the real group/private acceptance checks pass.
