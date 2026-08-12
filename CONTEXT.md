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

**Persistent Agent Write**:
Any audited Agent tool operation that changes durable state: a Typed Knowledge Write, a Team Context mutation, or a Scheduled Task lifecycle mutation. Reads, searches, list operations, and reply delivery are not Persistent Agent Writes.
_Avoid_: Read tool, reply transport, unrestricted write, database access

**Write Replay Boundary**:
The moment the first Persistent Agent Write begins in an Agent run. Before this boundary, a transient model or read-only-tool failure may safely retry a message run under its existing policy; after it, Minori never automatically replays the whole run, even when the write outcome is unknown. Scheduled Runs never receive a business retry on either side of the boundary. Idempotent retry of reply transport is separate from Agent-run replay.
_Avoid_: Retry every failure, completed-write boundary, reply retry

**Feishu Delivered Member**:
A user whose message Feishu delivers to the Minori Feishu App from private chat or a group where the bot is present. Minori treats the delivered event as sufficient admission and does not distinguish internal members from external collaborators.
_Avoid_: Eligible Member, allowed-group member, internal-only user

**Persistent Agent Control**:
The authority every Feishu Delivered Member has to change Team Context and manage Scheduled Tasks, including cross-group result targets. External collaborators and internal members have the same Persistent Agent Control; Minori does not add an internal-member or maintainer gate.
_Avoid_: Administrator permission, internal-member privilege, maintainer allowlist

**Team Context**:
The single configured Feishu document containing team-wide durable facts, decisions, preferences, terminology, and working defaults. It is loaded for every Agent run but an explicit Current Invocation may override it; only Core Policy is non-overridable. Only a member-triggered message run may modify it; Scheduled Runs always treat it as read-only.
_Avoid_: System prompt, separate memory database, mandatory team policy, per-conversation memory

**Team Context Snapshot**:
The latest complete, within-budget Team Context revision that Minori successfully loaded and cached in Neon. It may bridge transient read failures for at most 24 hours, but explicit permission denial or document absence invalidates it immediately.
_Avoid_: Permanent cache, partial document, independent memory store, authorization bypass

**Durable Context Assertion**:
Stable, team-wide information that the member directly states or explicitly adopts in the Current Invocation and that Minori may persist into Team Context without prior confirmation. Retrieved content, Live Group History, tool results, and model inference are not Durable Context Assertions unless the member explicitly asks Minori to retain them.
_Avoid_: Model inference, retrieved fact, automatic summary, historical instruction

**Scheduled Task**:
A team-global persistent instruction with a stable ID and globally unique non-terminal name that creates future Agent runs on a one-time or recurring calendar. Every Feishu Delivered Member may list, read, change, pause, resume, or delete every Scheduled Task regardless of its Origin Conversation. A due one-time task is in flight until its run reaches a terminal outcome; its full definition and revisions persist while active, paused, or in flight and for 30 days after terminal completion or deletion.
_Avoid_: Private reminder, conversation-owned task, hidden cron job, workflow graph

**Origin Conversation**:
The private chat or Group Context in which a Scheduled Task was created. It supplies audit provenance and the default result target, but it does not own or restrict access to the task.
_Avoid_: Task owner, schedule permission boundary, result target

**Result Target**:
The stable Feishu chat selected to receive a Scheduled Run's ordinary result message and used as that run's Durable Conversation Queue serialization key. If delivery there fails, Minori does not retry the target and may send one body-free failure notice to the Origin Conversation.
_Avoid_: Origin Conversation, task owner, reply thread, retry destination

**Scheduled Context**:
The optional Group Context whose Live Group History a Scheduled Task explicitly requests as background. It is independent of Result Target, is stored as a stable chat ID, and uses `scheduled_for` as its Invocation Context Cutoff.
_Avoid_: Automatic result-target history, Origin Conversation, implicit group context

**Calendar Schedule**:
The deterministic one-time timestamp or basic recurring calendar rule attached to a Scheduled Task. It supports minute, hour, weekday, month, and day-of-month recurrence in one IANA timezone, but not holidays, business-day inference, event-relative timing, conditions, or workflow dependencies.
_Avoid_: Conditional trigger, holiday calendar, event dependency, model-interpreted run time

**Scheduled Run**:
One durable execution created from a Scheduled Task for one `scheduled_for` occurrence and a task snapshot frozen at run creation. Ordinary task updates never rewrite a queued or processing run. A never-started one-time run may be cancelled, deliberately rebound to the updated task version, and explicitly requeued; once processing begins it is not interrupted and is never automatically retried.
_Avoid_: Scheduled Task, mutable run, automatic retry, restored Agent process

**Group Context**:
The ordinary Feishu group chat identified by its chat ID and used as shared context when a member invokes Minori there or a Scheduled Task explicitly binds it as Scheduled Context. Recent group messages may inform an Agent run even when they did not invoke Minori; Minori never intentionally creates a topic or treats every group message as a trigger.
_Avoid_: Agent Thread, Group Reply Chain, Feishu topic, always-on Agent

**Live Group History**:
A bounded window of ordinary messages read from the Group Context selected by a message invocation or explicit Scheduled Context. When it loads, it supplies group background without mixing in Retained Conversation History. It may be sent to the model for that run but is not copied wholesale into Minori's persistence; Feishu remains its source of truth. If it is unavailable, a message-triggered group run receives prior Retained Conversation History plus a stable limitation fact, while a Scheduled Run receives the limitation fact without retained-history fallback.
_Avoid_: Retained Conversation History, group mirror, always-on ingestion

**Current Invocation**:
The authority-bearing request for one Agent run: a delivered private message, direct group mention, direct reply to Minori, or the frozen instruction of a Scheduled Run. Live Group History and other historical content are background; they do not independently authorize actions unless Current Invocation adopts or refers to them.
_Avoid_: Latest group message, historical command, always-active session

**Invocation Context Cutoff**:
The upper bound for Live Group History supplied to one Agent run: the delivered message occurrence time for a message invocation, or `scheduled_for` for a Scheduled Run. Messages after that cutoff belong only to later invocations, even when execution or catch-up starts later.
_Avoid_: Execution-start context, live tail, future messages

**Durable Conversation Queue**:
The PostgreSQL-backed queue of accepted Feishu events and Scheduled Runs waiting for Agent execution. Minori runs at most four different conversations concurrently by default, serializes message invocations by their conversation and Scheduled Runs by Result Target, and lets additional conversations wait without imposing per-user or per-group quotas. At most one Scheduled Run executes at once, and a queued message wins admission when both invocation kinds are waiting; processing work is never preempted.
_Avoid_: Admission limit, user quota, in-memory backlog

**Processing Reaction**:
The temporary `Typing` reaction Minori places immediately after an accepted Feishu message is durably persisted. It may remain while the event waits in the Durable Conversation Queue and is removed after reply, explicit failure, or stopped processing; it does not mean model execution has already started.
_Avoid_: Queue position, progress message, reasoning trace, status card

**Progress Reply**:
The single fixed ordinary reply Minori may send when a supported member-triggered event is still processing after 20 seconds. It is not retained in Minori's conversation history and has no authority, though Feishu may later return it as ordinary Live Group History.
_Avoid_: Processing Reaction, periodic update, progress percentage, reasoning trace

**Rich Content Reply**:
A normal Agent answer, Source-linked Answer, Scheduled Task result, or operation receipt delivered as Feishu rich content generated from Markdown. Its formatting path does not own retry or Agent execution semantics.
_Avoid_: Control Reply, interactive card, Agent rerun, reply thread

**Control Reply**:
A short fixed progress, failure, or delivery notice sent through the simplest plain-text messaging path so it does not depend on rich-content conversion. It carries no retrieved body or detailed Agent answer.
_Avoid_: Rich Content Reply, system prompt, operational log, status card

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

**Agent Failure Detail**:
The bounded diagnostic message retained internally for 30 days on one Agent Run that ended after a caught exception. It supports operator investigation but is not a member-facing explanation, model context, or permanent audit fact.
_Avoid_: Failure reply, permanent error log, raw prompt, error category

**Persistence Data Boundary**:
The trusted Neon PostgreSQL database that stores plaintext conversation bodies and Agent Failure Details for 30 days, active, paused, or in-flight Scheduled Task definitions, and completed or deleted task bodies for 30 days. It retains structural message, task, Agent, and tool audit metadata afterward. Minori does not persist complete retrieved document bodies as a separate knowledge copy and does not add application-level encryption that would prevent conversation search.
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

**Retained Conversation History**:
Unexpired invoked messages and Minori replies from the current Group Context or private conversation that Minori has durably retained. Private runs automatically receive a recent retained context window. Group runs receive it only as a fallback when Live Group History is unavailable; successfully loaded Live Group History does not mix with retained records. Minori may search retained history only from that same conversation and does not summarize messages into long-term memory or expose another conversation.
_Avoid_: Retained Thread History, Live Group History, global chat search, durable memory, hidden summary

**Release Intent**:
An operator-created protected `v*` tag whose version matches the application version and whose commit is contained in `main`. It is the explicit request to build a production candidate, not permission to deploy it.
_Avoid_: Main push, automatic version bump, Production Approval, deployment

**Production Approval**:
The explicit GitHub Production Environment confirmation that admits one immutable release candidate to the restricted deployment path. In the first CI/CD release, the same operator may create the Release Intent and grant Production Approval, so this is a two-step safeguard rather than separation of duties.
_Avoid_: Release Intent, two-person approval, automatic deployment, CI success

**Emergency Merge Bypass**:
The repository owner's audited, pull-request-only escape hatch for repairing broken CI governance when required checks cannot complete. It does not permit direct production deployment, tag mutation, or replacement of Release Intent and Production Approval.
_Avoid_: Direct push, release bypass, tag overwrite, Production Approval

**Local Rollback Set**:
The production host's current healthy image plus its two most recent verified healthy predecessors. Compose contracts and sanitized release records outlive this local image set; remote GHCR retention is separate.
_Avoid_: Entire release history, Docker cache, GHCR retention, unverified image

**Deployment Protocol**:
Deployment Protocol `v1` is the explicitly versioned command and immutable digest image-contract agreement between GitHub's approved deploy job and the stable Vultr deployment entrypoint. A release is admitted only when the requested protocol, image-declared protocol, and host-supported protocol are identical.
_Avoid_: Workflow version, application version, implicit script compatibility, release tag

**Release Line**:
The canonical `main` branch whose history contains every commit eligible for a Release Intent. Temporary feature branches may propose changes to the Release Line but are never permanent release ancestry or alternate default branches.
_Avoid_: Default feature branch, deployment branch, release tag, production environment
