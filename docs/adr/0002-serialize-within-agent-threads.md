# Serialize within Agent Threads and parallelize across them

Minori processes messages in order within each Agent Thread or private conversation, while allowing a configurable number of different conversations to run concurrently (four by default). PostgreSQL-backed leases enforce this boundary so that a slow retrieval cannot block the entire team, without allowing two messages from the same conversation to race or reorder context.
