# GitHub Actions CI/CD Design

**Status:** Approved for implementation  
**Date:** 2026-08-09

## Goal

Minori uses GitHub Actions for repeatable pull-request validation and exact-artifact production releases. A release begins only when an operator pushes a protected `v*` tag whose version matches `package.json`. GitHub builds one private `linux/amd64` image, records its immutable digest, waits for Production Environment approval, and deploys that same digest to the existing Vultr host.

The design replaces production source builds with build-once/deploy-by-digest delivery while preserving the existing preflight, additive migration, readiness, release-contract, and verified rollback behavior.

## Non-goals

- The workflow does not create or increment application versions.
- The workflow does not create tags on behalf of an operator.
- The first CI/CD release does not add preview environments, canary traffic, blue/green routing, Kubernetes, or a self-hosted GitHub runner.
- The workflow does not automate Lark OAuth, Feishu permission grants, production secret creation, or destructive database rollback.
- The workflow does not claim the currently deferred multi-person Live Group History acceptance has passed.

## Chosen architecture

The release path is:

```text
Pull request / main push
  -> validation checks
  -> protected v* tag
  -> tag/version/main-ancestry validation
  -> one linux/amd64 GHCR image
  -> immutable image digest
  -> GitHub Production Environment approval
  -> restricted SSH deployment request
  -> Vultr pulls that digest
  -> preflight
  -> additive migrations
  -> Compose replacement
  -> readiness
  -> success record or verified rollback
```

GitHub-hosted runners execute CI and image builds. Vultr does not run a GitHub self-hosted runner. The image package is private in GitHub Container Registry. Vultr holds a pull-only `read:packages` credential; GitHub Actions does not send that credential over SSH.

## Workflow boundaries

### Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`.

It exposes stable required-check names for repository rules:

- `CI / verify`
- `CI / integration`
- `CI / image-amd64`

The jobs perform:

1. clean checkout and `npm ci` on the supported Node.js version;
2. `npm run verify`;
3. `npm run test:integration` with the GitHub-hosted Docker runtime;
4. a non-pushed `linux/amd64` production-image build;
5. workflow and shell validation, including `actionlint` and `bash -n` for changed shell entrypoints.

Pull-request runs use concurrency cancellation for an older run of the same branch. A `main` run is never cancelled after it becomes the source of a release tag.

### Release

`.github/workflows/release.yml` runs only for pushed tags matching `v*`.

Before building, it fails closed unless all of the following are true:

- the tag is exactly `v` plus the `package.json` version;
- the tag resolves to a full commit SHA;
- the tagged commit is reachable from `origin/main`;
- the same commit passes the complete validation gate;
- the target image repository is exactly the configured Minori GHCR package.

The build job uses `linux/amd64`, labels the image with `org.opencontainers.image.revision=<full-sha>`, and pushes:

- `ghcr.io/plutoless/minori:<full-sha>`;
- `ghcr.io/plutoless/minori:<semver>`.

Those tags are discovery metadata only. Deployment uses the immutable reference:

```text
ghcr.io/plutoless/minori@sha256:<64-hex-digest>
```

The build job returns the digest as a job output. The deploy job must consume that exact output; it may not resolve a tag again.

The deploy job belongs to the GitHub `production` Environment. The Environment requires an owner review before the job can read its SSH secret or contact Vultr. Production deployments use a concurrency group that queues releases and never cancels an in-progress deployment.

## Image and release contract

The production image contains the exact release-time Compose contract at a fixed read-only path. The server deployment entrypoint extracts that contract from the pulled digest rather than reading `/root/minori`, a dirty checkout, a branch, or a separately uploaded file.

Before any production mutation, the server verifies:

- the image reference matches the exact private GHCR repository and contains a `sha256` digest;
- the image is locally addressable by that digest after pull;
- OCI revision equals the requested full commit SHA;
- architecture is `amd64`;
- configured runtime user is `10001:10001`;
- the extracted Compose contract resolves to the same digest reference;
- runtime preflight reports database, Feishu, Lark, and model as healthy categories without printing secrets.

No App Secret, OpenAI key, database URL, OAuth material, message body, member identity, or provider output enters the image, Actions artifact store, release metadata, or workflow logs.

## Restricted production access

GitHub uses a dedicated deployment SSH key. Its public key is installed in the target account's `authorized_keys` with a forced command and `restrict`. It cannot open an interactive shell, forward ports, forward an agent, or run arbitrary remote commands.

The forced command invokes a stable server-owned entrypoint at `/opt/minori/bin/ci-deploy`. The entrypoint reads `SSH_ORIGINAL_COMMAND` without `eval` and accepts exactly:

```text
deploy <40-lowercase-hex-commit-sha> ghcr.io/plutoless/minori@sha256:<64-lowercase-hex-digest>
```

Every other command, repository, tag reference, malformed digest, extra argument, or concurrent deployment is rejected before Docker or the database is touched. A host-local lock serializes releases.

The stable entrypoint is installed or upgraded through an explicit operator bootstrap, not by the restricted CI key. This keeps a compromised workflow from rewriting its own server-side authority boundary.

Vultr stores the GHCR pull-only credential in Docker's root-owned credential store. Its token has only `read:packages`. The token is entered directly during bootstrap and is never placed in chat, the repository, an Actions secret, or command output.

## Deployment transaction

For an admitted SHA and digest, `/opt/minori/bin/ci-deploy`:

1. acquires the deployment lock;
2. records the current container image and saved Compose contract;
3. pulls the requested digest;
4. performs all image/revision/architecture/user/contract checks;
5. runs sanitized runtime preflight with the production env and persistent Lark mount;
6. runs additive migrations from the requested digest;
7. saves the digest-addressed Compose contract under `/opt/minori/releases`;
8. replaces the stable `minori` Compose service without rebuilding;
9. waits for `/health/ready`;
10. records success, or restores the previous image and previous saved Compose contract and verifies rollback readiness.

Database rollback is never attempted. Every migration remains compatible with the supported previous runtime because migrations precede replacement and image rollback does not downgrade the schema.

For the transition release, the previous image may still be the legacy local `minori:<40-char-sha>` format. The entrypoint accepts that format only as an already-running rollback source with an existing saved contract. New deployment targets must always be the private GHCR digest form.

Release metadata contains only commit SHA, immutable image digest/reference, timestamp, operator category, result, and rollback target category. It excludes environment values, credentials, prompts, message content, names, Open IDs, OAuth data, and raw provider errors.

## GitHub configuration

Repository variables:

- `VULTR_HOST`
- `VULTR_USER`
- `VULTR_KNOWN_HOSTS`
- `GHCR_IMAGE`, fixed to `ghcr.io/plutoless/minori`

Production Environment secret:

- `VULTR_DEPLOY_SSH_KEY`

`VULTR_KNOWN_HOSTS` contains a pinned host key captured and verified during bootstrap. Workflows do not use `StrictHostKeyChecking=no` or accept a newly observed key automatically.

Workflow permissions are job-scoped and minimal:

- validation: `contents: read`;
- image publishing: `contents: read`, `packages: write`;
- deployment: `contents: read`, with access to the Production Environment SSH secret only after approval.

Third-party Actions are pinned to immutable commit SHAs. Mutable action tags are not accepted in the committed workflow.

## Repository rules

The `main` ruleset requires pull requests and the three stable CI checks. Direct pushes that bypass those checks are not part of the normal release path.

A `v*` tag ruleset prevents update and deletion. Creating a new protected release tag remains an explicit operator action. A release workflow still independently verifies package-version equality and `main` ancestry; repository rules are not treated as the only enforcement layer.

## Failure handling

- Dependency, type, unit, integration, shell, workflow, or image-build failures stop before publishing or deployment.
- Version or ancestry mismatch stops before image publication.
- GHCR push failure leaves production unchanged.
- Missing Production approval leaves the image published but production unchanged.
- SSH host-key mismatch, restricted-command rejection, digest mismatch, OCI mismatch, wrong architecture/user, Compose mismatch, or preflight failure stops before migration and replacement.
- Migration failure stops before service replacement.
- Replacement/readiness failure invokes the existing verified image-and-Compose rollback transaction.
- Rollback failure is a terminal release failure and is surfaced prominently; the workflow does not hide it or repeatedly mutate production.

Workflow output and server output use stable categories. Raw secrets, raw database errors containing connection data, provider payloads, and chat data are suppressed.

## Tests and release gates

Implementation adds contracts that prove:

- workflow triggers and stable job/check names;
- minimal workflow permissions and Production Environment binding;
- tag/package-version equality and `main` ancestry validation;
- one build digest flows unchanged into deployment;
- deployment accepts only the exact GHCR digest grammar;
- forced-command parsing rejects extra arguments and arbitrary commands without shell evaluation;
- lock contention causes a clean rejection;
- image repository, digest, OCI revision, architecture, user, and Compose-contract mismatches fail closed;
- transition rollback accepts the current legacy local image only as a previous release;
- successful deployment saves the new contract and record;
- readiness failure restores and verifies the previous image/contract;
- no workflow, script, test fixture, or release record contains production secrets or chat content.

Local and CI verification includes `actionlint`, shell syntax checks, focused deployment-script tests with stubbed Docker/SSH boundaries, `npm run verify`, `npm run test:integration`, and a non-pushed amd64 image build. The first real tag release additionally verifies GHCR package visibility, Environment approval, restricted SSH admission, exact digest deployment, readiness, and rollback readiness without intentionally breaking production.

## Bootstrap and rollout

Bootstrap is a one-time operator-assisted procedure:

1. create a dedicated Ed25519 deployment key;
2. install its public key with the forced-command restriction on Vultr;
3. install the reviewed stable deployment entrypoint under `/opt/minori/bin`;
4. log Vultr into private GHCR with a pull-only token entered directly on the host;
5. pin Vultr's SSH host key in the GitHub repository variable;
6. create the GitHub `production` Environment, owner reviewer, variables, and deployment secret;
7. apply and verify the `main` and `v*` rulesets;
8. merge the workflows only after local contract tests pass;
9. publish the next version by updating `package.json`, merging through the protected branch, then explicitly creating and pushing the matching tag.

The currently deployed release remains healthy throughout bootstrap. CI/CD does not redeploy `v0.1.0` merely because workflows are added. The first automated release uses a new version tag and preserves the current exact image as the transition rollback source.

## Acceptance criteria

The CI/CD setup is accepted when:

1. a pull request cannot merge while any required CI check fails;
2. a tag/version or tag/main-ancestry mismatch cannot publish or deploy an image;
3. the GHCR package is private and Vultr can pull it with a read-only credential;
4. the deploy job cannot access its SSH secret before Production approval;
5. the restricted key cannot execute an arbitrary command or open a shell;
6. the digest built and validated by GitHub is the digest referenced by the production container;
7. OCI revision, architecture, user, preflight, migrations, Compose contract, and readiness are verified before success;
8. a deployment failure restores and verifies the previous saved release without a schema downgrade;
9. release logs and records remain within the sanitized metadata boundary;
10. the existing production release remains healthy until an explicitly tagged and approved successor is deployed.
