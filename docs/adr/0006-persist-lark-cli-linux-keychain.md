# Persist the Lark CLI Linux Credential Store

Minori sets `LARKSUITE_CLI_DATA_DIR` inside its persistent Lark mount and uses Lark CLI's native Linux keychain implementation. The CLI stores a local master key beside AES-256-GCM encrypted App Secret and user OAuth tokens, allowing unattended refresh and restart recovery without placing plaintext credentials in CLI config or command arguments.

## Consequences

The whole Lark Credential Store is one high-sensitivity asset: host root or disclosure of both the master key and encrypted files defeats the at-rest encryption. The directory is owned by Minori's UID with restrictive permissions, is never committed or logged, and must be backed up or migrated only as a protected unit. Environment-only app credentials are not an alternative because Lark CLI treats that provider as externally managed and disables interactive `auth login`.
