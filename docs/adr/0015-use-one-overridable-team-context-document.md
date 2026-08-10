# Use one overridable Team Context document

Minori uses one configured Feishu document as the complete team-wide durable context rather than separate rules and memory stores. Team Context is an overridable default beneath Current Invocation: only a member's Durable Context Assertion may be retained without confirmation, semantic consolidation requires explicit acceptance, and Scheduled Runs always treat the document as read-only. This keeps long-term context human-readable and natural without letting model inference or an old schedule silently become durable team policy.
