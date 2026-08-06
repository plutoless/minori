# Do not resend replies after the deduplication window

Minori persists a deterministic Feishu reply `uuid` and automatically retries an unresolved send only within Feishu's one-hour deduplication window. If the send result is still unknown after that window, Minori marks an Uncertain Reply and does not resend it: we prefer a rare missing old answer, which the member can ask for again, over posting a duplicate into an active team conversation.
