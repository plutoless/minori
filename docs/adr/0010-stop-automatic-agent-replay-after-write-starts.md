# Stop automatic Agent replay after a write starts

Minori may automatically retry a whole Agent run after a transient model or read-only-tool failure only before the first Typed Knowledge Write begins. Beginning the first write crosses the **Write Replay Boundary**. From that point onward, Minori never automatically replays the whole run, including when a write's outcome is unknown; it reports confirmed and unknown outcomes and waits for an explicit Continuation Run.

Create and append are not inherently idempotent, and a process may lose the response after Feishu has already applied a write. Replaying the complete Agent run can therefore duplicate durable side effects. Using the start of the write—not its observed success—as the boundary handles unknown outcomes conservatively. This does not prohibit retries below the Agent-run level when a specific operation has a proven idempotency contract.

Feishu reply delivery is a separate transport. It may continue using its stable idempotency key and existing deduplication window because retrying the same prepared reply is not replaying Agent reasoning or knowledge writes.

Recovery after the member continues is **Agent-managed Recovery**. Runtime code exposes durable operation outcomes, receipts, resource links, and normal knowledge tools, then lets the Agent decide whether to inspect, search, retry, change approach, or ask the member. It does not encode separate reconciliation branches for create, append, or patch, and it does not impose a mandatory confirmation step. Deterministic code remains responsible only for replay prevention, cancellation, auditing, and each typed tool's own conflict contract.
