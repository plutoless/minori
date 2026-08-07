# Bind Lark CLI to the Existing Feishu App

**Date:** 2026-08-07  
**Status:** Approved design; awaiting written-spec review  
**Audience:** Minori maintainers and operators

## Problem

The first real Vultr bootstrap showed that `lark-cli config init --new` opens the Feishu app-registration flow. Minori already has a released custom Feishu app for its bot and long connection, so creating a second CLI app would duplicate credentials, permissions, and operational ownership.

## Decision

Bind Lark CLI to the existing Minori Feishu app before authenticating the Dedicated Knowledge User.

The operator command reads `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from the process environment. It invokes:

```text
lark-cli config init --app-id <app-id> --app-secret-stdin --brand feishu
```

The App Secret is written only to the child process standard input. It must never appear in command arguments, stdout, stderr, errors, logs, or tests. After configuration, the existing device-code flow logs in the Dedicated Knowledge User and verifies that the active identity is `user`.

Minori continues to use one Feishu app for bot messaging and delegated user knowledge access. The bot calls use tenant/app credentials; Lark CLI knowledge calls use the Dedicated Knowledge User's OAuth grant and therefore remain bounded by that user's permissions.

## Interface and Data Flow

`npm run lark:auth` remains the operator interface.

1. Validate that the Lark config directory is absolute.
2. Require `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.
3. Initialize the CLI profile with the existing app, passing the secret through stdin.
4. Start recommended device login without waiting.
5. Print only the verification URL.
6. Continue with the device code.
7. Verify and print only the sanitized user-identity status.

The command runner gains an explicit optional stdin input field. It still uses `spawn` with an argument array and `shell: false`, bounds combined output, parses JSON only from stdout, and never echoes child stdin.

## Failure Behavior

- Missing app ID or secret fails with a stable configuration error before spawning the CLI.
- CLI initialization failure reports only `lark_auth_command_failed`.
- Invalid device authorization or status JSON keeps the existing stable errors.
- A failed attempt may leave partial non-secret CLI configuration in the persistent mount; rerunning the same command is the supported recovery path.

## Test Contract

Tests observe the public `runLarkAuth` and `AuthCommandRunner` seam:

- initialization uses `--app-id`, `--app-secret-stdin`, and `--brand feishu`;
- the secret is supplied through stdin and absent from every argument and printed line;
- missing credentials fail before any runner call;
- verification URL and sanitized final user status remain unchanged;
- the full operator script typecheck and existing release verification remain green.

## Non-goals

- Creating or managing a second Feishu application.
- Changing Minori's group authorization model.
- Expanding Lark read/write tools or knowledge permissions.
- Storing app credentials inside the repository or Lark config directory.
