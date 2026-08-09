# Deploy the first release to the existing Vultr host

Minori's first cloud deployment will run as a Docker Compose service on the team's existing Ubuntu 24.04 LTS x86_64 Vultr host, with Neon remaining external and Lark credentials stored in a host-mounted directory. This avoids another hosting subscription and keeps the service continuously connected to Feishu; the Docker image remains portable so the team can move providers later.

Candidate migrations run before service replacement, while rollback restores the previous image without a database downgrade. Migrations must therefore remain backward compatible with the supported rollback image. The open-admission release retains the obsolete `allowed_chats` table as inert physical compatibility even though the new runtime does not import, read, or write it; destructive cleanup is deferred until the rollback floor advances beyond `4f936ab`.
