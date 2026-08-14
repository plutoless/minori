# Repository Agent Guidance

## Verification

- Prefer fast local tests with mocks and sanitized fixtures.
- Leave real PostgreSQL, container, external-service, and production-data verification to required GitHub CI by default.
- Run those dependencies locally only when their boundary changes or when reproducing and fixing a related CI failure.
- Pull-request CI must always run the PostgreSQL integration suite as a required merge check.
