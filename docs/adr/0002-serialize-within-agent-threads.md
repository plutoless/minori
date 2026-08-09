---
status: superseded by ADR-0013
---

# Serialize within Agent Threads and parallelize across them

Minori processes messages in order within each Agent Thread or private conversation, while allowing a configurable number of different conversations to run concurrently (four by default). PostgreSQL-backed leases enforce this boundary so that a slow retrieval cannot block the entire team, without allowing two messages from the same conversation to race or reorder context.

Every accepted event is persisted before slow Agent work. When all global execution slots are occupied, additional conversations wait in this Durable Conversation Queue rather than being rejected; queued events do not consume a model execution slot. Minori imposes no per-user or per-group quota because those would become a second admission policy. The global concurrency limit bounds active resource and model usage, while Feishu delivery remains the sole admission boundary.
