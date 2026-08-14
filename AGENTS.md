# Repository Agent Guidance

## Verification

- Choose local verification by change risk. PostgreSQL tests are optional when a change does not touch persistence, migrations, queueing, transactions, leases, recovery, or database-backed contracts.
- Run the relevant PostgreSQL tests locally when any of those boundaries change, and when reproducing or fixing a related CI failure.
- Pull-request CI must always run the PostgreSQL integration suite as a required merge check.
