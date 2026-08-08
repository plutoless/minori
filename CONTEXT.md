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
Application-level authority derived from the Minori Feishu App credentials and used for Feishu messaging and membership checks.
_Avoid_: Knowledge authority, dedicated-user permission

**Delegated Knowledge Authority**:
The intersection of user-level permissions published for the Minori Feishu App, scopes granted through OAuth, and content access held by the Dedicated Knowledge User. It is the only authority Minori uses for knowledge operations, and its Lark CLI workspace refuses Bot Authority.
_Avoid_: Bot authority, tenant authority, requesting-user authority

**Lark Credential Store**:
The persistent, operator-protected directory containing Lark CLI configuration, its Linux master key, and encrypted app and user OAuth credentials. The directory is a single high-sensitivity asset because its master key and ciphertext are intentionally preserved together for unattended token refresh.
_Avoid_: Public config, secretless cache, knowledge database

**Knowledge Boundary**:
The complete set of Feishu content currently accessible to the Dedicated Knowledge User. Minori does not maintain a second application-level allowlist of knowledge spaces.
_Avoid_: Allowed-space list, configured knowledge scope

**Reversible Knowledge Write**:
A typed Minori operation that creates a document, appends content, or applies a targeted patch using Delegated Knowledge Authority. It may run autonomously without per-write confirmation. Deletion, permission or sharing changes, arbitrary shell, arbitrary HTTP, and raw API execution are not Reversible Knowledge Writes.
_Avoid_: Unrestricted write, destructive action, raw CLI access

**Allowed Chat**:
A Feishu group explicitly configured as an entry point for Minori conversations.
_Avoid_: Authorized knowledge space, knowledge boundary

**Eligible Member**:
A current member of an Allowed Chat. Eligible Members may invoke Minori in that group or in a private conversation with the bot.
_Avoid_: Knowledge user, administrator

**Agent Thread**:
A Feishu reply thread started when an Eligible Member mentions Minori or replies to a Minori message. Eligible Members may continue inside the same thread without mentioning Minori again; unrelated messages on the group timeline do not activate the Agent.
_Avoid_: Global group session, always-on listening

**Processing Reaction**:
The temporary `Typing` reaction Minori places on an accepted Feishu message while processing it. It is removed when processing finishes or fails; it does not describe a fixed workflow stage.
_Avoid_: Progress message, reasoning trace, status card

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
