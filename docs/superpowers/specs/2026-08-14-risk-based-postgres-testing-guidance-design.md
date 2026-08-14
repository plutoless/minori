# Risk-Based PostgreSQL Testing Guidance

**Status:** Approved for implementation

## Goal

Add a concise rule to the repository-root `AGENTS.md` so coding agents choose local PostgreSQL verification by change risk instead of running the slow container suite for every edit.

## Rule

- Local PostgreSQL tests are optional when a change does not touch persistence, migrations, queueing, transactions, leases, recovery, or database-backed contracts.
- Local PostgreSQL tests are required when any of those boundaries change, and when reproducing or fixing a related CI failure.
- Pull-request CI always runs the PostgreSQL integration suite and keeps it as a required merge check.

## Placement and scope

The rule belongs in the root `AGENTS.md`, which governs coding-agent workflow. It does not change application behavior, CI configuration, or the existing required check set. The guidance should remain short and link no new process documents.

## Verification

Confirm that the root guidance states all three boundaries without implying that database tests run only after CI fails. No runtime, database, or integration test is required for this documentation-only change.
