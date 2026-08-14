# Risk-Based PostgreSQL Testing Guidance

**Status:** Approved for implementation

## Goal

Add a concise rule to the repository-root `AGENTS.md` so coding agents prefer fast local mocks and fixtures instead of running slow real dependencies for every edit.

## Rule

- Local verification prefers mocks and sanitized fixtures.
- Real PostgreSQL, containers, external services, and production data are verified by required GitHub CI by default.
- Those dependencies are run locally only when their boundary changes, and when reproducing or fixing a related CI failure.
- Pull-request CI always runs the PostgreSQL integration suite and keeps it as a required merge check.

## Placement and scope

The rule belongs in the root `AGENTS.md`, which governs coding-agent workflow. It does not change application behavior, CI configuration, or the existing required check set. The guidance should remain short and link no new process documents.

## Verification

Confirm that the root guidance states all four boundaries without implying that real dependencies run locally only after CI fails. No runtime, database, or integration test is required for this documentation-only change.
