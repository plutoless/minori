# Minori Team Agent

Minori is a team-facing Agent that participates in approved Feishu conversations and works with team knowledge through a dedicated Feishu user identity.

## Language

**Dedicated Knowledge User**:
The Feishu user account prepared exclusively for Minori. Everything visible to this account is inside the Agent's Knowledge Boundary.
_Avoid_: Requesting user, impersonated user, bot identity

**Minori Feishu App**:
The single custom Feishu application used by Minori for both Bot Authority and Delegated Knowledge Authority. Sharing the app does not merge the two authorities or their credentials.
_Avoid_: Bot user, knowledge user, second CLI app

**Bot Authority**:
Application-level authority derived from the Minori Feishu App credentials and used for Feishu messaging and event context.
_Avoid_: Knowledge authority, dedicated-user permission

**Delegated Knowledge Authority**:
The intersection of user-level permissions published for the Minori Feishu App, scopes granted through OAuth, and content access held by the Dedicated Knowledge User. It is the only authority Minori uses for knowledge operations, and its Lark CLI workspace refuses Bot Authority.
_Avoid_: Bot authority, tenant authority, requesting-user authority

**Lark Credential Store**:
The persistent, operator-protected directory containing Lark CLI configuration, its Linux master key, and encrypted app and user OAuth credentials. The directory is a single high-sensitivity asset because its master key and ciphertext are intentionally preserved together for unattended token refresh.
_Avoid_: Public config, secretless cache, knowledge database

**Knowledge Boundary**:
The complete set of Feishu content currently accessible to the Dedicated Knowledge User and therefore publishable through Minori to every Feishu Delivered Member. Minori does not maintain a second application-level allowlist or re-filter results using the requesting member's own document permissions.
_Avoid_: Requester permission boundary, allowed-space list, configured knowledge scope

**Typed Knowledge Write**:
A Minori operation with an explicit input and effect contract that creates a document, appends content, or applies a targeted patch using Delegated Knowledge Authority. It may run autonomously without per-write confirmation and is audited, but Minori does not promise automatic rollback. Deletion, permission or sharing changes, arbitrary shell, arbitrary HTTP, and raw API execution are not Typed Knowledge Writes.
_Avoid_: Reversible write, unrestricted write, destructive action, raw CLI access

**Initial Typed Write Set**:
The first production release's three Typed Knowledge Writes: create a document, append content, and apply a targeted patch. This is a release boundary, not Minori's permanent knowledge-management capability ceiling; rename, move, trash, and complete-content update may be added later as typed tools.
_Avoid_: Final tool set, scenario restriction, unrestricted knowledge management

**Write Replay Boundary**:
The moment the first Typed Knowledge Write begins in an Agent run. Before this boundary, a transient model or read-only-tool failure may safely retry the run; after it, Minori never automatically replays the whole run, even when the write outcome is unknown. Idempotent retry of the Feishu reply transport is separate from Agent-run replay.
_Avoid_: Retry every failure, completed-write boundary, reply retry

**Feishu Delivered Member**:
A user whose message Feishu delivers to the Minori Feishu App from private chat or a group where the bot is present. Minori treats the delivered event as sufficient admission and does not distinguish internal members from external collaborators.
_Avoid_: Eligible Member, allowed-group member, internal-only user

**Agent Thread**:
A Feishu reply thread started when a Feishu Delivered Member mentions Minori or replies to a Minori message. Members may continue inside the same thread without mentioning Minori again; unrelated messages on the group timeline do not activate the Agent.
_Avoid_: Global group session, always-on listening

**Durable Conversation Queue**:
The PostgreSQL-backed queue of accepted Feishu events waiting for Agent execution. Minori runs at most four different conversations concurrently by default, serializes messages within each conversation, and lets additional conversations wait without imposing per-user or per-group quotas.
_Avoid_: Admission limit, user quota, in-memory backlog

**Processing Reaction**:
The temporary `Typing` reaction Minori places immediately after an accepted Feishu message is durably persisted. It may remain while the event waits in the Durable Conversation Queue and is removed after reply, explicit failure, or stopped processing; it does not mean model execution has already started.
_Avoid_: Queue position, progress message, reasoning trace, status card

**Execution Budget Exhaustion**:
The deliberate end of one Agent run after its configured model/tool step limit or wall-clock deadline is reached. Minori preserves completed writes, blocks further tools and writes, does not automatically rerun the task, records whether the step limit or timeout was reached, and tells the member they may explicitly continue in a new run.
_Avoid_: Successful completion, generic Agent failure, automatic retry

**Continuation Run**:
A new Agent run explicitly requested after Execution Budget Exhaustion. It receives the visible conversation history and the prior run's confirmed operation receipts and resource links, then re-reads current knowledge state before planning remaining work. It does not restore hidden model reasoning or an in-memory tool loop.
_Avoid_: Resumed chain of thought, restored process, automatic continuation

**Agent-managed Recovery**:
Recovery in which Minori receives durable facts about confirmed, failed, and unknown operations plus its normal knowledge tools, then decides whether to inspect, search, retry, change approach, or ask the member. Runtime code enforces replay and write-safety invariants but does not prescribe a recovery workflow.
_Avoid_: Hard-coded reconciliation flow, mandatory confirmation, silent worker replay

**Model Data Boundary**:
The configured OpenAI-compatible model endpoint, which receives the conversation context, relevant knowledge content, and tool results needed for an Agent run. Minori treats its operator as a trusted data processor for the entire Knowledge Boundary; `store: false` is a request constraint, not independent proof of a third-party retention policy.
_Avoid_: Secretless model call, locally isolated inference, guaranteed deletion

**Persistence Data Boundary**:
The trusted Neon PostgreSQL database that stores plaintext conversation bodies for 30 days and retains structural message records plus sanitized Agent and tool audit metadata afterward. Minori does not persist complete retrieved document bodies as a separate knowledge copy and does not add application-level encryption that would prevent conversation search.
_Avoid_: Encrypted search index, permanent message body, document mirror

**Source-linked Answer**:
An Agent answer accompanied by the deduplicated titles and links of Feishu documents actually read during that run. The Agent may cite them naturally in its prose; Minori verifies source authenticity but does not classify every claim or reject an answer for citation formatting.
_Avoid_: Fabricated source, mandatory per-claim marker, citation repair pass

**Team Knowledge Claim**:
A factual statement about the team's internal decisions, history, status, processes, or owned materials. General assistance and transformations based only on the current user-provided content are not Team Knowledge Claims.
_Avoid_: Every model-generated statement, general knowledge

**Uncertain Reply**:
A reply whose Feishu send was attempted but whose success was not durably recorded before the one-hour Feishu deduplication window expired. Minori does not resend an Uncertain Reply automatically because avoiding a duplicate takes priority over recovering the old answer.
_Avoid_: Failed reply, queued reply

**Retained Thread History**:
Unexpired messages from the current Agent Thread or private conversation. Minori automatically supplies a recent context window and lets the Agent search older messages from that same conversation; it does not summarize them into long-term memory or expose another conversation.
_Avoid_: Global chat search, durable memory, hidden summary
