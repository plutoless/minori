# GitHub Actions CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate every pull request with one shared quality gate, publish one immutable public `linux/amd64` GHCR image for each protected release tag, and deploy that exact digest to Vultr only after GitHub Production Environment approval.

**Architecture:** CI and release callers reuse one repository-local quality workflow. The release workflow validates tag/version/main ancestry, builds and publishes once, then sends only a versioned, strictly parsed deployment request through a restricted SSH key. A stable root-owned Vultr entrypoint extracts the Compose contract from the image, verifies the complete image contract, performs preflight and additive migrations, replaces the service, verifies readiness, and rolls back to the saved prior image and contract on failure.

**Tech Stack:** GitHub Actions, GHCR, Docker Buildx, Node.js 22, npm, Vitest/Testcontainers, Bash, Docker Compose, Ubuntu 24.04 x86_64, GitHub CLI, OpenSSH.

**Approved design:** `docs/superpowers/specs/2026-08-09-github-actions-ci-cd-design.md`

## Global constraints

- Keep the currently healthy `v0.1.0` production release running until the approved `v0.1.1` deployment transaction begins.
- New production targets are only `ghcr.io/plutoless/minori@sha256:<64-lowercase-hex>`; tags are discovery metadata and are never resolved during deployment.
- The release request is exactly `deploy v1 <40-lowercase-hex-sha> <digest-reference>`.
- The GitHub deployment key is separate from the interactive operator key and is constrained by `restrict` plus a forced root-owned command.
- The forced command reads `SSH_ORIGINAL_COMMAND` as data, never via `eval`, shell interpolation, or an unrestricted subcommand.
- Runtime secrets remain only in `/opt/minori/minori.env` with mode `0600`; they never enter GitHub artifacts, image layers, release records, or logs.
- CI uses no path filters. Documentation and deployment-contract changes run the full gate.
- Release and CI must invoke the same `.github/workflows/quality-gate.yml`; the release workflow may not duplicate validation commands.
- Third-party Actions use immutable commit SHAs:
  - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (`v4.2.2`)
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (`v4.4.0`)
  - `docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435` (`v3.11.1`)
  - `docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772` (`v3.4.0`)
  - `docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83` (`v6.18.0`)
- Workflow syntax is checked with actionlint pinned to commit `03d0035246f3e81f36aed592ffb4bebf33a03106` (`v1.7.7`).
- No provenance attestation, SBOM, preview environment, canary, self-hosted runner, Feishu deployment notification, emergency deploy verb, or automatic Dependabot merge is added in v1.
- The Local Rollback Set retains the current healthy image plus the two most recent verified healthy predecessors. Saved Compose contracts and sanitized release records are retained independently.
- Database migrations remain additive and compatible with every image in the Local Rollback Set.
- Do not claim the deferred multi-person Live Group History acceptance has passed.

---

### Task 1: Add release validation and immutable image contracts

**Files:**
- Create: `scripts/validate-release.ts`
- Create: `test/scripts/validate-release.test.ts`
- Modify: `Dockerfile`
- Create: `deploy/vultr/deployment-protocol`
- Modify: `test/scripts/release-contract.test.ts`

**Interfaces:**
- Produces: a release validator that emits only `commitSha`, `version`, `semverTag`, and fixed `ghcrImage` outputs after every invariant passes.
- Produces: an image containing `/opt/minori/release/compose.production.yaml` and `/opt/minori/release/deployment-protocol`.
- Consumes: `GITHUB_REF_NAME`, `GITHUB_SHA`, `GHCR_IMAGE`, the checked-out `package.json`, and fetched `origin/main`.

- [ ] **Step 1: Write failing validator and image-contract tests**

Create table-driven tests for these cases:

```ts
expect(validateRelease({
  refName: 'v0.1.1',
  sha: 'a'.repeat(40),
  packageVersion: '0.1.1',
  ghcrImage: 'ghcr.io/plutoless/minori',
  isOnMain: true,
})).toEqual({
  commitSha: 'a'.repeat(40),
  version: '0.1.1',
  semverTag: 'v0.1.1',
  ghcrImage: 'ghcr.io/plutoless/minori',
});
```

Reject missing `v`, prerelease-like text not represented by the package version, uppercase/malformed SHA, wrong repository, tag/version mismatch, and a commit not reachable from `origin/main`. The CLI contract test must stub the ancestry command and assert that no output file is written on failure.

Extend `test/scripts/release-contract.test.ts` to assert that the Dockerfile copies the exact Compose contract and the literal protocol file into fixed read-only runtime paths.

- [ ] **Step 2: Run the focused tests and capture RED**

```bash
npm test -- test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
```

Expected: the validator module and protocol file do not exist, and the Dockerfile does not contain the release contract.

- [ ] **Step 3: Implement strict validation**

Implement a pure `validateRelease` function and a small CLI boundary. The CLI must:

1. parse `package.json` locally;
2. require `GITHUB_REF_TYPE=tag` and `GITHUB_REF_NAME=v${version}`;
3. require `GITHUB_SHA` to match `^[0-9a-f]{40}$`;
4. require `GHCR_IMAGE === 'ghcr.io/plutoless/minori'`;
5. run `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` without invoking a shell;
6. append the four sanitized fields to `GITHUB_OUTPUT` only after all validation succeeds;
7. print only stable failure categories such as `release_tag_version_mismatch`.

Use dependency injection around the ancestry check and output writer so tests do not mutate the process environment or GitHub files.

- [ ] **Step 4: Embed the immutable deployment contract**

Create `deploy/vultr/deployment-protocol` containing exactly:

```text
v1
```

Modify the runtime stage of `Dockerfile` to copy:

```dockerfile
COPY --chown=minori:minori deploy/vultr/compose.production.yaml /opt/minori/release/compose.production.yaml
COPY --chown=minori:minori deploy/vultr/deployment-protocol /opt/minori/release/deployment-protocol
```

Do not copy `.env`, Git history, SSH material, acceptance records, or operator scripts into the image.

- [ ] **Step 5: Run GREEN checks and inspect the image**

```bash
npm test -- test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
npm run typecheck:scripts
docker build --platform linux/amd64 --label org.opencontainers.image.revision=$(git rev-parse HEAD) -t minori:ci-contract .
docker run --rm --entrypoint sh minori:ci-contract -c 'test "$(cat /opt/minori/release/deployment-protocol)" = v1 && test -r /opt/minori/release/compose.production.yaml'
docker inspect minori:ci-contract --format '{{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Expected: tests pass; image reports `amd64 10001:10001 <current-full-sha>`; both fixed contract paths are readable.

- [ ] **Step 6: Commit the validation slice**

```bash
git add Dockerfile deploy/vultr/deployment-protocol scripts/validate-release.ts test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
git commit -m "feat: define immutable release contract"
```

---

### Task 2: Add one reusable CI quality gate

**Files:**
- Create: `.github/workflows/quality-gate.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `test/scripts/ci-workflow-contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: reusable gates `verify`, `integration`, and `image-amd64`.
- Produces: pull-request and `main` checks with stable intended contexts `CI / verify`, `CI / integration`, and `CI / image-amd64`.
- Consumes: Node 22, npm lockfile, GitHub-hosted Docker, and the Task 1 image contract.

- [ ] **Step 1: Write failing workflow-contract tests**

Parse workflow YAML as data; do not rely only on substring assertions. Assert:

- `quality-gate.yml` has only `workflow_call` and owns all validation commands;
- `ci.yml` triggers on every PR to `main` and every push to `main`, with no `paths` or `paths-ignore`;
- PR concurrency cancels older runs for the same branch, while a `main` run is not cancelled;
- three logical jobs are named `verify`, `integration`, and `image-amd64`;
- `ci.yml` calls `./.github/workflows/quality-gate.yml` and does not repeat `npm run verify`, `npm run test:integration`, or `docker build`;
- permissions default to `{ contents: read }` and do not grant write scopes;
- every external `uses:` value is a 40-character SHA from the approved list;
- shell validation covers every tracked `*.sh` file and actionlint runs at the pinned commit;
- Dependabot updates `github-actions` weekly with an open-PR limit and no auto-merge configuration.

Add `yaml` as a development dependency only if the existing dependency tree has no safe YAML parser; update the lockfile through `npm install --save-dev yaml` rather than hand editing.

- [ ] **Step 2: Run the contract test RED**

```bash
npm test -- test/scripts/ci-workflow-contract.test.ts
```

Expected: all three GitHub configuration files are missing.

- [ ] **Step 3: Implement the reusable workflow**

Use a required `gate` input with allowed values `verify`, `integration`, and `image-amd64`. Each caller invokes the same file once per logical gate, so commands remain centralized while checks remain independently requireable.

The reusable jobs must:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
    with:
      node-version: '22'
      cache: npm
  - run: npm ci
```

The `verify` gate runs `npm run verify`, `bash -n` across tracked shell files, and actionlint pinned to commit `03d0035246f3e81f36aed592ffb4bebf33a03106`. The `integration` gate runs `npm run test:integration`. The image gate uses Buildx to build `linux/amd64` with `push: false` and the current full SHA as OCI revision.

Do not share `node_modules` artifacts between jobs. The simpler duplicate `npm ci` cost is accepted for isolation and clarity.

- [ ] **Step 4: Implement the CI caller and Dependabot**

Give the workflow literal `name: CI`. Set PR concurrency to `ci-${{ github.event.pull_request.number || github.ref }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

Call the reusable workflow three times with caller job names `verify`, `integration`, and `image-amd64`. After the first pushed PR run, inspect the actual GitHub check-run names. They must be exactly the three approved contexts. If GitHub renders an extra reusable-workflow segment, adjust caller/called job naming and rerun before enabling the ruleset; never configure a required context that has not completed successfully on the repository.

- [ ] **Step 5: Run local workflow checks GREEN**

```bash
npm test -- test/scripts/ci-workflow-contract.test.ts
npm run verify
go run github.com/rhysd/actionlint/cmd/actionlint@03d0035246f3e81f36aed592ffb4bebf33a03106
```

Expected: contracts and full verification pass, and actionlint reports no errors.

- [ ] **Step 6: Commit the quality gate**

```bash
git add .github/workflows/quality-gate.yml .github/workflows/ci.yml .github/dependabot.yml package.json package-lock.json test/scripts/ci-workflow-contract.test.ts
git commit -m "ci: add shared pull request quality gate"
```

---

### Task 3: Implement the restricted Vultr deployment transaction

**Files:**
- Create: `deploy/vultr/ci-deploy`
- Create: `deploy/vultr/minori-release`
- Create: `deploy/vultr/install-ci-deploy.sh`
- Create: `deploy/vultr/rehearse-release.sh`
- Create: `test/scripts/ci-deploy.test.ts`
- Create: `test/scripts/minori-release.test.ts`
- Modify: `scripts/deploy-vultr.sh`
- Modify: `scripts/rollback-vultr.sh`
- Modify: `test/scripts/release-contract.test.ts`

**Interfaces:**
- Produces: `/opt/minori/bin/ci-deploy`, a stable forced-command parser accepting only Deployment Protocol v1.
- Produces: one transactional release engine with stable categories, rollback, lock, state, record, and retention behavior.
- Produces: a one-time rehearsal command limited to the current accepted release and its immediate saved predecessor.
- Consumes: immutable GHCR digest, embedded image contract, `/opt/minori/minori.env`, `/opt/minori/lark`, Docker, Compose, and the existing healthy service.

- [ ] **Step 1: Create a fake-runtime harness and write RED tests**

Run the scripts against a temporary root with fake `docker`, `curl`, `flock`, `install`, and `date` executables. Tests must never touch real `/opt/minori`, Docker, SSH, or production.

Cover parser rejection before any fake Docker call for:

- missing/extra arguments;
- commands other than `deploy`;
- protocol other than `v1`;
- uppercase/short SHA;
- tag references or a repository other than `ghcr.io/plutoless/minori`;
- malformed/uppercase digest;
- shell metacharacters, whitespace injection, and newline injection;
- missing `SSH_ORIGINAL_COMMAND`;
- lock contention.

Transaction tests must cover:

- pull failure;
- image protocol, OCI revision, architecture, UID/GID, and Compose image mismatch;
- sanitized preflight failure before migration;
- migration failure before service replacement;
- successful replacement and readiness;
- readiness failure with verified rollback;
- rollback failure as a terminal stable category;
- first GHCR transition with legacy `minori:<40-sha>` as the saved previous image only;
- saving exactly current plus two verified predecessors;
- never pruning an image referenced by rollback state;
- records containing only the approved metadata keys;
- rehearsal refusing arbitrary SHAs/digests and accepting only saved positions 0 and 1.

- [ ] **Step 2: Run the deployment tests RED**

```bash
npm test -- test/scripts/ci-deploy.test.ts test/scripts/minori-release.test.ts test/scripts/release-contract.test.ts
```

Expected: the new server scripts do not exist and the old source-build scripts cannot satisfy digest deployment or retention.

- [ ] **Step 3: Implement the forced-command parser**

`deploy/vultr/ci-deploy` must:

- use `set -euo pipefail` and `umask 077`;
- reject direct positional arguments; its only command input is `SSH_ORIGINAL_COMMAND`;
- split only after matching the complete anchored grammar;
- never use `eval`, `bash -c "$SSH_ORIGINAL_COMMAND"`, command substitution of user text, or unquoted expansion;
- acquire `/run/lock/minori-ci-deploy.lock` non-blockingly;
- invoke the root-owned release engine with three already-validated positional arguments;
- emit only one stable result line.

The installed authorized-key entry is exactly the operator-supplied public key prefixed with:

```text
restrict,command="/opt/minori/bin/ci-deploy"
```

The installer must verify root ownership and non-writable-by-group/other modes for `/opt/minori/bin`, the entrypoint, release engine, and rehearsal script. It must preserve all unrelated existing `authorized_keys` lines and refuse ambiguous duplicate deployment-key entries.

- [ ] **Step 4: Implement the release engine**

`deploy/vultr/minori-release` accepts only already-parsed positional values: `v1`, full SHA, exact digest reference. It then:

1. captures the current container image and exact saved Compose contract;
2. anonymously pulls the requested digest;
3. verifies protocol, OCI revision, `amd64`, `10001:10001`, and exact repository/digest;
4. creates a temporary container and copies out only the embedded Compose contract;
5. renders Compose with `MINORI_IMAGE=<digest>` and `/opt/minori/minori.env`, requiring `config --images` to equal the digest;
6. runs `runtime:verify` read-only with the persistent Lark mount;
7. runs `db:migrate` only after every preflight invariant passes;
8. installs the digest-addressed Compose contract under `/opt/minori/releases/contracts`;
9. performs `docker compose --project-name minori up -d --no-build`;
10. polls `/health/ready` for the existing bounded window;
11. records the new healthy release and updates rollback state atomically, or restores the captured prior contract/image and verifies readiness;
12. prunes only local images outside the current-plus-two predecessor set after success.

Represent release state in a root-only, atomically replaced file whose rows contain protocol, SHA, exact image reference, and contract path. Validate every row before consuming it. Do not source this file as shell code.

Release records use stable JSON keys only:

```json
{
  "protocol": "v1",
  "commitSha": "<sha>",
  "image": "<digest-reference>",
  "timestamp": "<UTC>",
  "operatorCategory": "github_actions",
  "result": "success|rolled_back|rollback_failed|failed_before_replace",
  "rollbackTargetCategory": "none|legacy_local|saved_digest"
}
```

No raw command stderr is copied into the JSON or GitHub-visible output.

- [ ] **Step 5: Constrain the rehearsal and retire general manual release paths**

`rehearse-release.sh` must require the expected current SHA and digest, confirm they equal saved state position 0, switch once to position 1, verify readiness, then restore the same position-0 digest without rebuild and verify readiness. It must not accept an arbitrary target image or create a new release.

Replace the old `scripts/deploy-vultr.sh` and `scripts/rollback-vultr.sh` behavior with explicit refusal/help text pointing to the CI release and tightly constrained rehearsal. Do not leave a second operational deployment protocol hidden behind legacy scripts.

- [ ] **Step 6: Run GREEN and security residue checks**

```bash
npm test -- test/scripts/ci-deploy.test.ts test/scripts/minori-release.test.ts test/scripts/release-contract.test.ts
bash -n deploy/vultr/ci-deploy deploy/vultr/minori-release deploy/vultr/install-ci-deploy.sh deploy/vultr/rehearse-release.sh scripts/deploy-vultr.sh scripts/rollback-vultr.sh
rg -n 'eval|StrictHostKeyChecking=no|docker build|git worktree|ghcr\.io/.+:[^@ ]+' deploy/vultr scripts/deploy-vultr.sh scripts/rollback-vultr.sh
npm run verify
```

Expected: tests pass; the only `docker build`/worktree behavior is absent from production deployment scripts; no tag-form new deployment target or unsafe SSH setting remains.

- [ ] **Step 7: Commit the server transaction**

```bash
git add deploy/vultr scripts/deploy-vultr.sh scripts/rollback-vultr.sh test/scripts/ci-deploy.test.ts test/scripts/minori-release.test.ts test/scripts/release-contract.test.ts
git commit -m "feat: deploy approved GHCR digests"
```

---

### Task 4: Add the release workflow and production approval boundary

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/quality-gate.yml`
- Modify: `test/scripts/ci-workflow-contract.test.ts`
- Modify: `test/scripts/validate-release.test.ts`
- Modify: `test/scripts/release-contract.test.ts`

**Interfaces:**
- Produces: tag-triggered build-once/publish-once/deploy-by-digest workflow.
- Produces: GitHub `production` Environment approval immediately before SSH access.
- Consumes: Task 1 validator, Task 2 quality gate, Task 3 forced-command protocol, GHCR, and four GitHub configuration variables plus one environment secret.

- [ ] **Step 1: Extend workflow tests RED**

Assert `release.yml`:

- triggers only on pushed `v*` tags and has no manual dispatch;
- invokes all three gates from `quality-gate.yml` before publishing;
- validates exact tag/version/main ancestry;
- grants `packages: write` only to the image-publish job;
- logs in to `ghcr.io` using `github.actor` and `GITHUB_TOKEN`;
- builds once for `linux/amd64`, sets OCI revision to the full SHA, and pushes full-SHA plus semantic-version tags;
- passes the build step's digest output directly to deploy without tag re-resolution;
- deploy job has `environment: production`, `contents: read`, and no package write permission;
- deploy concurrency queues and never cancels an in-progress production release;
- creates a temporary `known_hosts` file from `vars.VULTR_KNOWN_HOSTS` and uses strict host checking;
- sends exactly one remote command matching Deployment Protocol v1;
- contains no production secret echo, `set -x`, source upload, checkout on Vultr, or GHCR credential transfer.

- [ ] **Step 2: Run contract test RED**

```bash
npm test -- test/scripts/ci-workflow-contract.test.ts test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
```

Expected: release workflow is absent.

- [ ] **Step 3: Implement validation and publication jobs**

Release workflow order is:

```text
quality gates -> validate release -> publish image -> deploy production
```

Fetch `origin/main` explicitly for ancestry validation. Build/push with the approved immutable Actions, exact labels, and tags:

```text
ghcr.io/plutoless/minori:<full-sha>
ghcr.io/plutoless/minori:<package-version>
```

Capture `${{ steps.build.outputs.digest }}` as the only deployment digest. Add a summary containing tag, SHA, digest, and stable result category only.

- [ ] **Step 4: Implement the approved SSH handoff**

The deploy job begins only after `environment: production` approval. Write the environment SSH key to a mode-`0600` temporary file and the pinned host-key variable to a separate temporary known-hosts file. Run OpenSSH with batch mode, identities-only, and strict host checking. The remote command is exactly:

```text
deploy v1 ${GITHUB_SHA} ghcr.io/plutoless/minori@${BUILD_DIGEST}
```

Validate the digest again in the workflow before constructing the command. Remove temporary key material in an `always()` cleanup step.

- [ ] **Step 5: Run all local workflow gates GREEN**

```bash
npm test -- test/scripts/ci-workflow-contract.test.ts test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
go run github.com/rhysd/actionlint/cmd/actionlint@03d0035246f3e81f36aed592ffb4bebf33a03106
npm run verify
npm run test:integration
```

Expected: all pass. Review generated action permissions manually and confirm only publication has `packages: write` and only deployment references `production`/the SSH secret.

- [ ] **Step 6: Commit the release workflow**

```bash
git add .github/workflows/release.yml .github/workflows/quality-gate.yml test/scripts/ci-workflow-contract.test.ts test/scripts/validate-release.test.ts test/scripts/release-contract.test.ts
git commit -m "ci: publish and deploy approved releases"
```

---

### Task 5: Align version, operator documentation, and repository-rule contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-08-09-github-actions-ci-cd-design.md`
- Create: `.github/rulesets/main.json`
- Create: `.github/rulesets/release-tags.json`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `test/scripts/ci-workflow-contract.test.ts`

**Interfaces:**
- Produces: exact `0.1.1` release intent and source-controlled GitHub ruleset contracts.
- Produces: one operator runbook for bootstrap, release, failure diagnosis, and rehearsal without a second deploy path.
- Consumes: every preceding workflow/server contract.

- [ ] **Step 1: Write documentation and ruleset contract tests RED**

Assert:

- package and lockfile versions are exactly `0.1.1`;
- README describes tag creation, Environment approval, public-package bootstrap, immutable digest deployment, current-plus-two retention, and GitHub-only notification surfaces;
- README explicitly says the same person may tag and approve, `Prevent self-review` is disabled, and this is two-step confirmation rather than two-person separation;
- README has no operator deploy command and directs GitHub outages to diagnosis while the current release stays running;
- main rules require PR plus the three observed CI check contexts and allow GitHub user `plutoless` (actor ID `471561`) to bypass only through PR;
- `v*` tag rules block update and deletion and expose no overwrite bypass;
- design, ADR 0014, CONTEXT, README, workflows, and rule contracts use the same Deployment Protocol v1 terms.

- [ ] **Step 2: Run focused RED**

```bash
npm test -- test/scripts/release-contract.test.ts test/scripts/ci-workflow-contract.test.ts
```

Expected: version and operator/ruleset contracts fail.

- [ ] **Step 3: Bump the first CI release version**

```bash
npm version 0.1.1 --no-git-tag-version
```

Confirm only `package.json` and `package-lock.json` receive the version change.

- [ ] **Step 4: Write the operator runbook**

Document four short paths:

1. normal PR and merge;
2. explicit `v0.1.1` Release Intent and Production Approval;
3. stable failure-category diagnosis without secret/log-body disclosure;
4. the one-time, bounded `v0.1.1 -> v0.1.0 -> same v0.1.1 digest` rehearsal.

Document the first-package bootstrap exactly: tag causes the package build, deployment waits at Production Approval, operator changes the GHCR package to Public once, Vultr proves an anonymous digest pull, and only then is Production approved. Do not add a package-admin token or bootstrap image.

- [ ] **Step 5: Add reviewable ruleset JSON**

Keep ruleset files as valid GitHub API request bodies with no substitution tokens. The `main` ruleset uses `{"actor_id":471561,"actor_type":"User","bypass_mode":"pull_request"}` for the approved owner-only emergency repair boundary. The remaining enforcement semantics are also literal and testable: Release Line `main`, required PR, the three exact approved checks, and immutable `v*` tags with an empty bypass list.

- [ ] **Step 6: Run the complete local release gate**

```bash
npm test -- test/scripts/release-contract.test.ts test/scripts/ci-workflow-contract.test.ts
npm run verify
npm run test:integration
go run github.com/rhysd/actionlint/cmd/actionlint@03d0035246f3e81f36aed592ffb4bebf33a03106
docker build --platform linux/amd64 --label org.opencontainers.image.revision=$(git rev-parse HEAD) -t minori:ci-final .
docker inspect minori:ci-final --format '{{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
git diff --check
```

Expected: tests/typechecks/build/integration/actionlint pass; image reports `amd64 10001:10001`; diff check is clean.

- [ ] **Step 7: Review and commit the release intent**

Use the `code-review` skill along both Standards and Spec axes against Task 1's base. Fix every Critical/Important finding and rerun affected gates.

```bash
git add package.json package-lock.json README.md CONTEXT.md docs/superpowers/specs/2026-08-09-github-actions-ci-cd-design.md .github/rulesets test/scripts
git commit -m "docs: prepare v0.1.1 CI release"
```

The resulting clean full SHA is the only candidate allowed into Task 6.

---

### Task 6: Bootstrap GitHub/Vultr and accept the first CI release

**External state:**
- GitHub repository: `plutoless/minori`
- Existing release tag: `v0.1.0` at `cea9107ab9bc2f85635a2f999dc834fafb8e5a82`
- Vultr host variable: `198.13.34.221`
- Stable paths: `/opt/minori/bin`, `/opt/minori/releases`, `/opt/minori/minori.env`, `/opt/minori/lark`

**Safety boundary:** Every mutation in this task needs explicit operator authorization at the point of execution. Never print or return the private deployment key, environment values, OAuth data, chat content, member identity, or raw production logs.

- [ ] **Step 1: Verify the fixed points read-only**

Verify:

- local candidate worktree is clean and has passed Task 5;
- `v0.1.0` resolves exactly to `cea9107ab9bc2f85635a2f999dc834fafb8e5a82` locally and on GitHub;
- current production remains healthy, restart count is zero, and OCI revision is the deployed fixed point;
- `/root/minori` is clean;
- no remote `main` exists yet;
- the GHCR `minori` package does not yet exist, or if it now exists, record its current visibility without changing it.

- [ ] **Step 2: Establish the Release Line and feature PR**

Push `main` at the exact `v0.1.0` commit, change the repository default branch to `main`, then create/push `feat/github-actions-ci` at the clean Task 5 candidate. Open a PR to `main`.

Do not delete `feat/open-team-agent` yet. Do not enable required checks until the first PR run has actually emitted them.

- [ ] **Step 3: Observe and lock the CI contract**

Wait for all PR jobs. Read check-run names through the GitHub API and require exact equality with:

```text
CI / verify
CI / integration
CI / image-amd64
```

If names differ, return to Task 2, adjust naming, rerun local contracts, commit, and let the PR rerun. Once exact, resolve the owner actor ID, apply the `main` and `v*` rulesets from the source-controlled contracts, and independently read them back to verify enforcement/bypass semantics.

- [ ] **Step 4: Bootstrap the restricted Vultr authority**

Generate a dedicated Ed25519 deployment key in a temporary operator-controlled location. Transfer only its public half to Vultr. Run `install-ci-deploy.sh` interactively as root to install the reviewed candidate scripts at root-owned, non-writable paths and add the forced/restricted authorized-key line.

Test the key with malformed and benign requests: arbitrary shell and malformed deploy commands must be rejected before Docker; no interactive shell may open. Do not run a valid deployment yet.

Add GitHub repository variables `VULTR_HOST`, `VULTR_USER=root`, verified `VULTR_KNOWN_HOSTS`, and `GHCR_IMAGE=ghcr.io/plutoless/minori`. Add the private key only as the `VULTR_DEPLOY_SSH_KEY` secret of the GitHub `production` Environment. Configure the owner as required reviewer and leave `Prevent self-review` disabled.

- [ ] **Step 5: Merge, tag, and bootstrap the public package**

Merge the PR only after all three required checks pass under the active main ruleset. Confirm the merge commit still has package version `0.1.1`, then create and push immutable tag `v0.1.1` at that exact main commit.

Wait for validation and image publication. Confirm the workflow-reported digest belongs to `ghcr.io/plutoless/minori`, the release job is paused at Production Approval, and production is unchanged.

Because this is the first package publication, change the new GHCR package visibility to Public once in GitHub. From Vultr, anonymously pull the exact workflow digest and verify OCI revision/architecture/user without starting or replacing the service. Only then approve the `production` Environment job.

- [ ] **Step 6: Verify exact production deployment**

After the workflow completes, verify using sanitized metadata only:

- running image equals the workflow digest, not merely a tag;
- OCI revision equals the `v0.1.1` main commit;
- architecture is `amd64`, user is `10001:10001`;
- Docker health is healthy and restart count is zero;
- `/health/ready` returns 200 with all component categories `ok`;
- saved Compose contract resolves to the same digest;
- release record reports success;
- Local Rollback Set includes new current plus the legacy `v0.1.0` predecessor;
- `/root/minori` remains unchanged and clean.

- [ ] **Step 7: Run the controlled rollback rehearsal**

Under an explicit maintenance confirmation, invoke the installed rehearsal script with the accepted `v0.1.1` SHA and exact digest. Verify:

1. it switches to the saved `v0.1.0` predecessor and readiness returns 200;
2. it restores the same accepted `v0.1.1` digest without rebuild and readiness returns 200;
3. final image/digest/revision/health/restart state matches Step 6;
4. rehearsal records contain no secrets or message data;
5. arbitrary target input remains rejected.

This is a one-time acceptance operation, not a second CI deployment verb.

- [ ] **Step 8: Close the transition**

After deployment and rehearsal are healthy:

- delete the obsolete remote `feat/open-team-agent` branch;
- keep `main` as default and protected Release Line;
- keep `v0.1.0` and `v0.1.1` immutable;
- verify Dependabot is enabled for weekly GitHub Actions updates with no auto-merge;
- save only sanitized CI/CD acceptance evidence in the ignored SDD report;
- do not mark deferred multi-person group acceptance as completed.

## Final acceptance checklist

- [ ] PR/main runs expose and enforce the exact three approved checks.
- [ ] CI and release share one local quality workflow with no command drift.
- [ ] Every external Action and actionlint is immutably pinned.
- [ ] `v0.1.1` equals package version and is reachable from protected `main`.
- [ ] One public GHCR `linux/amd64` image is built and its digest flows unchanged into deployment.
- [ ] The deploy job pauses for Production Approval and self-review remains intentionally allowed.
- [ ] The SSH key cannot open a shell or run commands outside Deployment Protocol v1.
- [ ] Vultr verifies digest/revision/architecture/user/Compose/preflight before migration or replacement.
- [ ] Failure after replacement restores the saved prior image and contract and verifies readiness.
- [ ] Current plus two verified predecessors are retained locally.
- [ ] Production ends healthy on the exact accepted `v0.1.1` digest after the controlled rehearsal.
- [ ] No secrets, chat data, member identity, OAuth data, or raw provider/database output appears in CI artifacts, logs, or release records.
- [ ] No manual/emergency deployment path, attestation, SBOM, preview environment, or Feishu notification was accidentally added.
