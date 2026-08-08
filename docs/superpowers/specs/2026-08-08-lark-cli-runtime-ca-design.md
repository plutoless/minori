# Lark CLI Runtime CA Hotfix Design

## Problem

The release candidate can initialize and read its persisted Lark CLI configuration,
but `lark-cli auth login --domain docs,drive,wiki --no-wait --json` exits before
device authorization. A sanitized production reproduction reports TLS verification
failure: the runtime image does not trust the certificate chain used by the Feishu
device-authorization endpoint.

The `.env not found` line printed by the npm script is informational because the
container receives production configuration through `--env-file`.

## Decision

Install Debian's `ca-certificates` package in the final runtime image. Keep normal
certificate verification enabled. Do not add custom certificates, disable TLS
verification, or change the Lark OAuth flow.

The build stage already installs `ca-certificates`, but multi-stage Docker builds do
not carry installed operating-system packages into the final stage. The runtime stage
must install its own trust store explicitly.

## Scope

- Update the runtime stage in `Dockerfile` to install `ca-certificates` with no
  recommended packages and remove the apt package lists afterward.
- Add a release-contract regression assertion proving the runtime stage installs the
  trust store, rather than relying on the build stage.
- Keep the image's non-root runtime user, persistent Lark mount, exact-commit release
  process, and secret handling unchanged.
- Build and verify a new exact-commit image locally and natively on Vultr.
- Run a sanitized `auth login --no-wait` probe on Vultr. A successful probe may create
  a pending device authorization, but its URL and device code must be discarded and
  never enter logs or chat.
- After the probe passes, ask the operator to run the normal interactive OAuth command
  against the new exact image.

## Error Handling and Security

- TLS verification remains mandatory.
- OAuth URLs, device codes, App ID, App Secret, tokens, and environment values remain
  excluded from captured output.
- If the rebuilt image still fails, report only the sanitized error category and stop;
  do not weaken TLS or guess at application permissions.
- The existing `7aa3abba` image remains superseded for OAuth and deployment after the
  hotfix commit is built and verified.

## Verification

1. The focused release-contract test fails before the Dockerfile change and passes
   afterward.
2. `npm run verify` and `npm run test:integration` pass.
3. The new image builds and still runs as UID/GID `10001:10001`.
4. Secret-free runtime verification remains sanitized and fails closed as designed.
5. On Vultr, the exact-commit amd64 image completes the sanitized Lark device-flow
   initiation with exit status 0.
6. Interactive OAuth is still considered incomplete until the dedicated user finishes
   authorization and `auth status --verify` reports the user identity ready.

