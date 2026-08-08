# Lark CLI Runtime Trust and Home Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exact-commit production image able to persist Lark CLI keychain state and initiate Feishu device authorization with normal TLS verification.

**Architecture:** Keep the non-root, read-only runtime and existing `/var/lib/minori/lark` volume. Install Debian's runtime CA trust store and place `HOME` under that persistent volume so Lark CLI can store its keychain without writing `/home/minori`.

**Tech Stack:** Docker multi-stage build, Debian bookworm-slim, Node.js 22, Lark CLI 1.0.84, Vitest, Vultr Docker runtime.

## Global Constraints

- TLS verification remains mandatory; never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or an equivalent bypass.
- Keep runtime UID/GID `10001:10001`, the read-only root filesystem contract, and the existing `/var/lib/minori/lark` host mount.
- Persist CLI home at exactly `/var/lib/minori/lark/home`; do not introduce another host mount or copy credentials into the image.
- Never print OAuth URLs, device codes, App ID, App Secret, tokens, environment values, or credential-file contents.
- Build and verify only full 40-character exact commits for Vultr release work.
- Do not start the Minori service, run migrations, or deploy until interactive OAuth and the allowed chat are configured.

---

### Task 1: Add runtime trust store and persistent CLI home

**Files:**
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `Dockerfile`
- Modify: `.superpowers/sdd/2026-08-08-lark-cli-runtime-trust-home/task-1-report.md` (gitignored implementation report)

**Interfaces:**
- Produces: final image environment `HOME=/var/lib/minori/lark/home`
- Produces: final image package `ca-certificates`
- Consumes: existing `VOLUME ["/var/lib/minori/lark"]` and runtime user `10001:10001`

- [ ] **Step 1: Write the failing release-contract test**

Add this test to `test/scripts/release-contract.test.ts`:

```ts
it('installs runtime CA trust and persists the Lark CLI home', async () => {
  const dockerfile = await text('Dockerfile');
  const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'));

  expect(runtime).toContain('apt-get install --yes --no-install-recommends ca-certificates');
  expect(runtime).toContain('HOME=/var/lib/minori/lark/home');
  expect(runtime).toContain('mkdir -p /var/lib/minori/lark/home');
  expect(runtime).toContain('chown -R 10001:10001 /app /var/lib/minori/lark /tmp/minori');
  expect(runtime).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
});
```

- [ ] **Step 2: Run the focused test and verify the exact regression is red**

Run:

```bash
npm test -- test/scripts/release-contract.test.ts
```

Expected: FAIL because the runtime stage neither installs `ca-certificates` nor sets the persistent `HOME`.

- [ ] **Step 3: Install CA certificates in the runtime stage**

Immediately after `WORKDIR /app` in the final stage, add:

```dockerfile
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
```

Do not copy the build-stage trust store and do not disable certificate verification.

- [ ] **Step 4: Put CLI home inside the persistent Lark volume**

Extend the runtime `ENV` block with:

```dockerfile
HOME=/var/lib/minori/lark/home
```

Change the runtime directory creation to:

```dockerfile
mkdir -p /var/lib/minori/lark/home /tmp/minori
```

Keep the existing recursive ownership assignment to UID/GID `10001:10001`.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
npm test -- test/scripts/release-contract.test.ts
npm run verify
npm run test:integration
git diff --check
```

Expected: focused release contract, all unit tests, integration tests, type checks, and build pass.

- [ ] **Step 6: Build and inspect the local candidate**

Run:

```bash
docker build -t minori:lark-runtime-hotfix-local .
docker inspect --format '{{.Config.User}} {{.Config.Env}}' minori:lark-runtime-hotfix-local
docker run --rm minori:lark-runtime-hotfix-local sh -lc \
  'test -r /etc/ssl/certs/ca-certificates.crt && test "$HOME" = /var/lib/minori/lark/home && test -w "$HOME"'
```

Expected: image user is `10001:10001`, `HOME` is the persistent Lark path, the CA bundle is readable, and the home is writable.

- [ ] **Step 7: Commit the hotfix**

```bash
git add Dockerfile test/scripts/release-contract.test.ts
git commit -m "fix: enable lark OAuth in runtime image"
```

---

### Task 2: Prove the exact hotfix image on Vultr and prepare OAuth handoff

**Files:**
- Modify: `.superpowers/sdd/2026-08-08-lark-cli-runtime-trust-home/task-2-report.md` (gitignored verification report)
- Modify: `.superpowers/sdd/2026-08-07-team-agent/progress.md` (gitignored execution ledger)

**Interfaces:**
- Consumes: Task 1's full hotfix commit SHA and Dockerfile contract
- Produces: one exact-commit native amd64 image on Vultr and sanitized device-flow readiness evidence

- [ ] **Step 1: Transfer and verify the exact commit without changing the server worktree**

Create a complete Git bundle for the hotfix head, transfer it to Vultr, import it under a release-only ref, and verify:

```bash
git rev-parse HEAD
git bundle create /tmp/minori-lark-runtime-hotfix.bundle HEAD
git bundle verify /tmp/minori-lark-runtime-hotfix.bundle
scp /tmp/minori-lark-runtime-hotfix.bundle root@198.13.34.221:/root/
ssh root@198.13.34.221 \
  'git -C /root/minori fetch /root/minori-lark-runtime-hotfix.bundle HEAD:refs/remotes/hotfix/lark-runtime && git -C /root/minori rev-parse refs/remotes/hotfix/lark-runtime'
```

Expected: local HEAD and the remote release-only ref resolve to the same 40-character SHA; `/root/minori` remains on its previous clean worktree state.

- [ ] **Step 2: Build the native amd64 image from the exact Git object**

On Vultr, archive only the verified commit and build:

```bash
hotfix_sha="$(git -C /root/minori rev-parse refs/remotes/hotfix/lark-runtime)"
git -C /root/minori archive refs/remotes/hotfix/lark-runtime | \
  docker build -t "minori:${hotfix_sha}" -
docker image inspect "minori:${hotfix_sha}" \
  --format '{{.Id}} {{.Architecture}} {{.Config.User}}'
```

Expected: architecture `amd64`, runtime user `10001:10001`, and a non-empty image digest. `hotfix_sha` must be the exact Task 1 commit; never use a short SHA.

- [ ] **Step 3: Verify CA and persistent home without credentials**

Run the exact image with the existing Lark mount but no production environment:

```bash
hotfix_sha="$(git -C /root/minori rev-parse refs/remotes/hotfix/lark-runtime)"
docker run --rm \
  -v /opt/minori/lark:/var/lib/minori/lark \
  "minori:${hotfix_sha}" sh -lc \
  'test -r /etc/ssl/certs/ca-certificates.crt && mkdir -p "$HOME" && test -w "$HOME"'
```

Expected: exit status 0. After the container exits, verify only that `/opt/minori/lark/home` exists with owner `10001:10001`; do not display file contents.

- [ ] **Step 4: Run sanitized configuration and device-flow probes**

Use the production env file and persistent mount, but capture all CLI output inside the container. Return only exit codes and stable error categories after redacting exact environment values, URLs, device codes, and long identifiers.

First run `config init`, then `config strict-mode user`, then `auth login --domain docs,drive,wiki --no-wait --json`. Expected statuses are all 0. Delete captured output immediately. A successful no-wait response must not be copied to terminal logs, chat, or the report.

If an existing partial configuration makes `config init` non-repeatable, move `/opt/minori/lark` to a timestamped mode-0700 backup, recreate `/opt/minori/lark` as `10001:10001` mode 0750, and rerun once. Do not delete the backup until interactive OAuth is complete.

- [ ] **Step 5: Verify the interactive operator command uses the new exact image**

Resolve the exact Task 1 commit and prepare this operator command:

```bash
hotfix_sha="$(git -C /root/minori rev-parse refs/remotes/hotfix/lark-runtime)"
docker run --rm -it \
  --env-file /opt/minori/minori.env \
  -v /opt/minori/lark:/var/lib/minori/lark \
  "minori:${hotfix_sha}" \
  npm run lark:auth
```

Expected: the operator, not captured automation, sees the verification URL on `/dev/tty`. The task remains incomplete until the dedicated user authorizes and sanitized `auth status --verify` confirms user readiness.

---
