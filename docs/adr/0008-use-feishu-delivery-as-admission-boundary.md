# Use Feishu message delivery as the admission boundary

Minori accepts messages from any user whose event Feishu delivers to the App, without maintaining a group allowlist, a user allowlist, a derived membership gate, or an internal-versus-external tenant check. This removes duplicated admission configuration and lets Feishu App availability and bot presence define reachability, while deliberately accepting that an external collaborator can invoke the Agent—including its autonomous Typed Knowledge Writes and access to content inside the Dedicated Knowledge User's Knowledge Boundary, regardless of the collaborator's own source permissions.

The legacy `allowed_chats` table remains physically present only while the supported previous image requires it for rollback. The current runtime never reads or writes it, so it is not an admission boundary; it will be removed by a later contract migration after the rollback floor advances.
