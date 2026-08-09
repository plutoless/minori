# Allow autonomous typed knowledge writes

Minori may autonomously create documents, append content, and apply targeted patches through Typed Knowledge Writes under Delegated Knowledge Authority. These operations form the **Initial Typed Write Set** and do not require per-write confirmation; the Dedicated Knowledge User's native Feishu permissions remain the content boundary.

This improves the Agent's usefulness for requested and scheduled work without exposing an unrestricted execution surface. Write tools must return the affected resource identity and operation result so Minori can record an audit event and surface conflicts or failures without pretending success. Typed Knowledge Writes are bounded and audited, but they do not promise automatic rollback.

The Initial Typed Write Set is a first-release boundary, not a permanent claim that Minori only supports those three operations. Rename, move, trash, and complete-content update may be added later as typed tools. Permission, membership, ownership, and sharing management remain a separate future capability decision; arbitrary shell, HTTP, and raw API execution are not implied by expanding knowledge operations.
