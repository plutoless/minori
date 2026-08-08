# Allow autonomous reversible knowledge writes

Minori may autonomously create documents, append content, and apply targeted patches through typed tools under Delegated Knowledge Authority. These operations do not require per-write confirmation; the Dedicated Knowledge User's native Feishu permissions remain the content boundary.

This improves the Agent's usefulness for requested and scheduled work without exposing an unrestricted execution surface. Destructive deletion, permission or sharing changes, arbitrary shell, arbitrary HTTP, and raw API execution remain unavailable. Write tools must return the affected resource identity and operation result so Minori can record an audit event and surface conflicts or failures without pretending success.
