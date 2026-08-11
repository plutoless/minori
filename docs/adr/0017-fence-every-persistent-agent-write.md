# Fence every Persistent Agent Write against whole-run replay

The Write Replay Boundary begins before the first Persistent Agent Write, not only before a knowledge-document write. Team Context mutations and Scheduled Task lifecycle mutations atomically fence and audit the invocation before changing durable state, so later failure cannot replay the whole Agent run. This preserves one safety invariant across every persistent tool instead of creating side-effect-specific replay rules.
