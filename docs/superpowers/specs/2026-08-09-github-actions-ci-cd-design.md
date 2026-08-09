# GitHub Actions CI/CD Design

**Status:** Approved for implementation  
**Date:** 2026-08-09

## Goal

Minori uses GitHub Actions for repeatable pull-request validation and exact-artifact production releases. A release begins only when an operator pushes a protected `v*` tag whose version matches `package.json`. GitHub builds one public `linux/amd64` image, records its immutable digest, waits for Production Environment approval, and deploys that same digest to the existing Vultr host.

The design replaces production source builds with build-once/deploy-by-digest delivery while preserving the existing preflight, additive migration, readiness, release-contract, and verified rollback behavior.

## Non-goals

- The workflow does not create or increment application versions.
- The workflow does not create tags on behalf of an operator.
- The first CI/CD release does not add preview environments, canary traffic, blue/green routing, Kubernetes, or a self-hosted GitHub runner.
- The workflow does not automate Lark OAuth, Feishu permission grants, production secret creation, or destructive database rollback.
- The first CI/CD release does not generate or verify build provenance attestations or SBOMs; immutable digest delivery and OCI revision verification are the initial supply-chain boundary.
- The first CI/CD release does not add an operator-invoked emergency deployment mode. If GitHub's release control plane is unavailable, the current healthy production release remains running and no new release begins.
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

GitHub-hosted runners execute CI and image builds. Vultr does not run a GitHub self-hosted runner. The image package is public in GitHub Container Registry because the repository source is already public and the image contains no runtime secrets. Vultr pulls the immutable digest anonymously and stores no GHCR credential.

## Workflow boundaries

### Continuous integration

`.github/workflows/quality-gate.yml` is a repository-local reusable workflow invoked through `workflow_call`. It owns the complete validation implementation. `.github/workflows/ci.yml` runs on pull requests and pushes to `main` and delegates its checks to that reusable workflow. `.github/workflows/release.yml` invokes the same reusable workflow for the tagged commit before image publication; it does not copy or independently redefine the validation commands.

The first CI/CD release uses no path filters. Documentation-only and deployment-contract changes run the same complete gate because repository documentation, Compose, release scripts, and release-contract tests participate in the operational release boundary. Path-based optimization is deferred until measured CI duration justifies the extra routing logic.

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

The deploy job belongs to the GitHub `production` Environment. The public repository supports required reviewers, and the Environment requires an owner review before the job can read its SSH secret or contact Vultr. `Prevent self-review` remains disabled because the first CI/CD release permits the same operator to create the Release Intent and grant Production Approval. This is a deliberate two-step safeguard against accidental release, not two-person review or separation of duties. Production deployments use a concurrency group that queues releases and never cancels an in-progress deployment.

## Image and release contract

The production image contains the exact release-time Compose contract and Deployment Protocol declaration at fixed read-only paths. The server deployment entrypoint extracts that contract from the pulled digest rather than reading `/root/minori`, a dirty checkout, a branch, or a separately uploaded file.

Before any production mutation, the server verifies:

- the image reference matches the exact public GHCR repository and contains a `sha256` digest;
- the requested Deployment Protocol, image-declared protocol, and host-supported protocol are all exactly `v1`;
- the image is locally addressable by that digest after pull;
- OCI revision equals the requested full commit SHA;
- architecture is `amd64`;
- configured runtime user is `10001:10001`;
- the extracted Compose contract resolves to the same digest reference;
- runtime preflight reports database, Feishu, Lark, and model as healthy categories without printing secrets.

No App Secret, OpenAI key, database URL, OAuth material, message body, member identity, or provider output enters the image, Actions artifact store, release metadata, or workflow logs.

## Restricted production access

GitHub uses a dedicated deployment SSH key for `root`, separate from the operator's existing interactive root key. Its public key is installed in root's `authorized_keys` with a forced command and `restrict`. It cannot open an interactive shell, forward ports, forward an agent, or run arbitrary remote commands. Root is retained because Docker, the mode-`0600` production environment, saved release contracts, and rollback state are already root-owned; introducing a nominal non-root deploy user would still require root-equivalent Docker and file authority.

The forced command invokes a stable server-owned entrypoint at `/opt/minori/bin/ci-deploy`. The entrypoint reads `SSH_ORIGINAL_COMMAND` without `eval` and accepts exactly:

```text
deploy v1 <40-lowercase-hex-commit-sha> ghcr.io/plutoless/minori@sha256:<64-lowercase-hex-digest>
```

Every other command, Deployment Protocol version, repository, tag reference, malformed digest, extra argument, or concurrent deployment is rejected before Docker or the database is touched. A host-local lock serializes releases.

The stable entrypoint is installed or upgraded through an explicit operator bootstrap, not by the restricted CI key. This keeps a compromised workflow from rewriting its own server-side authority boundary.

Deployment Protocol `v1` is the first contract. A future protocol change requires the operator to bootstrap a host entrypoint that supports the new version before a workflow or image may request it. Protocol mismatch fails before migration or service replacement.

The public GHCR package permits anonymous image pulls. Vultr stores no GHCR token, and the deployment workflow does not transmit one. Public package visibility does not weaken the deployment boundary: the entrypoint still accepts only the fixed repository plus an immutable digest and verifies the image's release contract.

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
10. records success, or restores the previous image and previous saved Compose contract and verifies rollback readiness;
11. only after successful readiness and any required rollback rehearsal, prunes unreferenced local release images outside the Local Rollback Set.

Database rollback is never attempted. Every migration remains compatible with the supported previous runtime because migrations precede replacement and image rollback does not downgrade the schema.

For the transition release, the previous image may still be the legacy local `minori:<40-char-sha>` format. The entrypoint accepts that format only as an already-running rollback source with an existing saved contract. New deployment targets must always be the public GHCR digest form.

Release metadata contains only commit SHA, immutable image digest/reference, timestamp, operator category, result, and rollback target category. It excludes environment values, credentials, prompts, message content, names, Open IDs, OAuth data, and raw provider errors.

The Local Rollback Set contains the current healthy production image and the two most recent verified healthy predecessors. The host retains their local image data. Older unreferenced release images may be pruned only after the new release and required rehearsal are healthy. Digest-addressed Compose contracts and sanitized release records remain under `/opt/minori/releases`; the production script does not delete remote GHCR images.

## GitHub configuration

Repository variables:

- `VULTR_HOST`
- `VULTR_USER`, fixed to `root`
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

`.github/dependabot.yml` enables weekly `github-actions` updates. Dependabot opens reviewable pull requests that update pinned action SHAs; it never auto-merges them, and the same required CI checks apply.

## Repository rules

The Release Line is the canonical `main` branch. The repository currently has no remote `main` and temporarily uses `feat/open-team-agent` as its default branch, so bootstrap first creates `main` at the exact deployed `v0.1.0` commit and changes the GitHub default branch to `main`. CI/CD implementation then proceeds on `feat/github-actions-ci` through a pull request to the Release Line. After `v0.1.1` completes deployment and rollback rehearsal, the obsolete remote `feat/open-team-agent` branch is deleted.

The `main` ruleset requires pull requests and the three stable CI checks. The repository owner retains an Emergency Merge Bypass that is usable only through a pull request when broken CI governance would otherwise prevent its own repair. It is not a normal merge path, does not allow a direct production deployment, and does not bypass the release workflow's tag, ancestry, validation, or Production Approval gates.

A `v*` tag ruleset prevents update and deletion without an overwrite bypass. An incorrectly created release tag remains immutable; the operator corrects the version and creates a new tag rather than moving the old one. Creating a new protected release tag remains an explicit operator action. A release workflow still independently verifies package-version equality and `main` ancestry; repository rules are not treated as the only enforcement layer.

## Failure handling

- Dependency, type, unit, integration, shell, workflow, or image-build failures stop before publishing or deployment.
- Version or ancestry mismatch stops before image publication.
- GHCR push failure leaves production unchanged.
- Missing Production approval leaves the image published but production unchanged.
- GitHub release-control-plane unavailability leaves the current healthy production release unchanged; interactive root access remains for diagnosis, not a second release protocol.
- SSH host-key mismatch, restricted-command rejection, digest mismatch, OCI mismatch, wrong architecture/user, Compose mismatch, or preflight failure stops before migration and replacement.
- Migration failure stops before service replacement.
- Replacement/readiness failure invokes the existing verified image-and-Compose rollback transaction.
- Rollback failure is a terminal release failure and is surfaced prominently; the workflow does not hide it or repeatedly mutate production.

Workflow output and server output use stable categories. Raw secrets, raw database errors containing connection data, provider payloads, and chat data are suppressed.

The first CI/CD release does not send deployment notifications through Minori or Feishu because the service being deployed is not a reliable notification dependency. GitHub Deployment status, the Actions result/email path, a concise job summary, and the server's sanitized release record are the notification and diagnosis surfaces. A failed job summary states the stable failure category, whether rollback succeeded, and the currently healthy image digest without printing production data.

## Tests and release gates

Implementation adds contracts that prove:

- workflow triggers and stable job/check names;
- CI and release both call the same repository-local quality gate rather than duplicating validation steps;
- minimal workflow permissions and Production Environment binding;
- immutable third-party Action references and weekly non-auto-merged Dependabot updates;
- tag/package-version equality and `main` ancestry validation;
- one build digest flows unchanged into deployment;
- deployment accepts only the exact GHCR digest grammar;
- requested, image-declared, and host-supported Deployment Protocol versions must match;
- forced-command parsing rejects extra arguments and arbitrary commands without shell evaluation;
- lock contention causes a clean rejection;
- image repository, digest, OCI revision, architecture, user, and Compose-contract mismatches fail closed;
- transition rollback accepts the current legacy local image only as a previous release;
- successful deployment saves the new contract and record;
- readiness failure restores and verifies the previous image/contract;
- cleanup retains the current and two prior healthy images, never removes a referenced rollback target, and preserves contracts and records;
- no workflow, script, test fixture, or release record contains production secrets or chat content.

Local and CI verification includes `actionlint`, shell syntax checks, focused deployment-script tests with stubbed Docker/SSH boundaries, `npm run verify`, `npm run test:integration`, and a non-pushed amd64 image build. The first real tag release additionally verifies public GHCR visibility and anonymous pull, Environment approval, restricted SSH admission, exact digest deployment, readiness, and the separately authorized rollback rehearsal.

## Bootstrap and rollout

Bootstrap is a one-time operator-assisted procedure:

1. create remote `main` at the exact deployed `v0.1.0` commit and change the GitHub default branch to `main`;
2. create `feat/github-actions-ci` from that Release Line for every code, workflow, documentation, and `0.1.1` version change;
3. create a dedicated Ed25519 deployment key;
4. install its public key with the forced-command restriction on Vultr;
5. install the reviewed stable deployment entrypoint under `/opt/minori/bin`;
6. pin Vultr's SSH host key in the GitHub repository variable;
7. create the GitHub `production` Environment, owner reviewer with self-review allowed, variables, and deployment secret;
8. run the CI workflow from the feature PR so its stable check names exist, then apply and verify the `main` and `v*` rulesets before merge;
9. merge the workflows only after local and PR contract tests pass;
10. explicitly create and push `v0.1.1` from the resulting `main` commit;
11. let the release build create the previously nonexistent GHCR package, then leave the deploy job waiting for Production Approval;
12. change that package's visibility to public once through GitHub Package Settings and verify anonymous pull of the built digest from Vultr; no package-admin token or bootstrap image is introduced;
13. grant Production Approval and verify that the complete automated path deploys the immutable `v0.1.1` digest while retaining `v0.1.0` as the transition rollback target;
14. perform one operator-authorized production rollback rehearsal: restore `v0.1.0`, verify readiness, redeploy the exact previously accepted `v0.1.1` digest without rebuilding, and verify readiness again;
15. delete the obsolete remote `feat/open-team-agent` branch after the final `v0.1.1` readiness check passes.

The currently deployed release remains healthy throughout bootstrap. CI/CD does not redeploy `v0.1.0` merely because workflows are added. The first automated release is `v0.1.1`; it contains the already-accepted application behavior plus the CI/CD delivery changes and preserves the current `v0.1.0` exact image as the transition rollback source.

The controlled rollback rehearsal is a one-time setup acceptance action, not part of every normal release. It may cause two brief container replacements. It must reuse the saved `v0.1.0` contract and the already-approved `v0.1.1` digest, must not rebuild either image, and must stop if the rollback target or either readiness check is not exact and healthy.

## Acceptance criteria

The CI/CD setup is accepted when:

1. a pull request cannot merge while any required CI check fails;
2. a tag/version or tag/main-ancestry mismatch cannot publish or deploy an image;
3. the GHCR package is public, contains no runtime secrets, and Vultr can pull its immutable digest anonymously;
4. the deploy job cannot access its SSH secret before Production approval;
5. the restricted key cannot execute an arbitrary command or open a shell;
6. the digest built and validated by GitHub is the digest referenced by the production container;
7. OCI revision, architecture, user, preflight, migrations, Compose contract, and readiness are verified before success;
8. a deployment failure restores and verifies the previous saved release without a schema downgrade;
9. release logs and records remain within the sanitized metadata boundary;
10. the existing production release remains healthy until an explicitly tagged and approved successor is deployed;
11. `v0.1.1` completes the real tag-to-GHCR-to-approval-to-restricted-SSH-to-readiness path;
12. one controlled rehearsal restores healthy `v0.1.0`, then restores the exact healthy `v0.1.1` digest without rebuilding, proving both rollback and forward recovery.
13. GitHub's default branch and Release Line are `main`, and the obsolete remote `feat/open-team-agent` branch is removed only after `v0.1.1` is healthy.
