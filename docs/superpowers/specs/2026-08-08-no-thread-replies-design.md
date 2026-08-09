# Minori Non-Threaded Feishu Replies

**Date:** 2026-08-08
**Status:** Approved

**Active implementation plan:** `docs/superpowers/plans/2026-08-08-live-group-context.md`

## Decision

Minori never intentionally creates a Feishu topic for a reply. Private and group
answers appear as ordinary messages in the existing chat timeline.

The Feishu reply API remains the transport because it preserves the relationship
to the triggering message and the existing idempotency contract. Every request
sets `reply_in_thread` to `false`.

## Conversation behavior

### Private chat

- Every delivered private message may invoke Minori.
- Minori replies as an ordinary private-chat message, not as a topic.
- The private chat remains one conversation context.

### Group chat

- A direct mention starts a Minori conversation.
- Minori replies as an ordinary group message that references the triggering
  message, without creating a topic.
- A member invokes Minori only by directly mentioning it or directly replying to
  one of its ordinary messages. Replying is an invocation signal, not a context
  boundary.
- A normal group-timeline message that neither mentions nor replies to Minori is
  ignored.
- The group chat ID is the Group Context boundary. When invoked, Minori reads a
  bounded window of recent ordinary group messages before the trigger so it can
  understand the surrounding discussion.
- Recent ordinary messages may be sent to the configured model as context even
  though they did not themselves invoke Minori. This is an accepted data boundary.

Existing historical topics are not migrated. The new release stops intentionally
creating topics for new replies.

The no-topic guarantee applies to private chats and ordinary-message groups.
Feishu topic-mode groups inherently represent messages as topics and are outside
this release's supported interaction surface; Minori does not add a special
compatibility path for them.

## Component changes

`FeishuClientAdapter.replyText` keeps its current message-reply endpoint and UUID
idempotency key, but sends `reply_in_thread: false`. The gateway recognizes a
direct mention or a reply to Minori. Group conversations use the chat ID rather
than a root or thread ID as their conversation key.

Bot Authority reads a bounded recent-history window from the current group only
when Minori is invoked. This requires the Feishu group-message history permission.
The initial window is 20 messages.

The initial window and Current Invocation share the existing 24,000-token context
target. Selection keeps the newest messages before the cutoff first and may include
fewer than 20 when messages are large. Ordinary system events are excluded. The
Current Invocation remains explicit and is not duplicated inside Live Group
History.

The normal group Agent tool set also includes `readEarlierGroupHistory`. It is a
read-only paginated tool bound internally to the current group and Invocation
Context Cutoff; neither the chat ID nor cutoff is model-controlled. The tool accepts
only the opaque cursor from the prior page and a bounded page size of at most 50.
It returns older messages, resolved group display names, typed non-text omission
markers, and a next cursor. It does not provide a second full-text or semantic
index and never persists the returned history in Neon.

The default Agent budget increases from 20 steps and 180 seconds to 40 steps and
300 seconds. These are ceilings rather than targets: natural completion still
stops immediately, and whichever ceiling is reached first ends the run. The
existing explicit budget-exhaustion receipt, continuation behavior, Write Replay
Boundary, and audit rules remain unchanged. History pagination has no separate
page-count quota; it uses the same Agent budget, with at most 50 messages per tool
call.

Live Group History is transient. Minori sends the selected messages to the model
for the current run but does not copy ordinary non-triggering group messages into
Neon. Feishu remains the source of truth. Neon continues to retain only accepted
trigger messages, Minori replies, tool receipts, and audit records under the
existing retention policy.

The initial history reader supplies text and rich-text content. Image, file, card,
audio, video, and other message types appear only as typed omission markers. Minori
does not download or interpret those resources in this change; the Agent may ask a
member for the missing material when it matters.

For one invocation, Bot Authority reads the current group's member list and maps
history sender Open IDs to their real group display names. The model receives the
names but not the Open IDs. Minori does not call the enterprise contact directory,
persist a member directory, or use this lookup for admission. A sender that the
group member API cannot resolve is labeled `姓名不可用的成员`; this does not fail the
run or hide other resolved names. The App therefore requires the Feishu permission
to view group members in addition to group-message history. Member-list pagination
stops once all senders in the selected history are resolved or the API is exhausted;
there is no separate contact-directory fallback or persistent member cache.

The Current Invocation is the request for the run. Live Group History is quoted
background, not a backlog of commands. The Agent may follow a current request such
as "apply the plan above", but an old instruction in history cannot independently
authorize a tool call or write.

Minori does not add an activation timer or an always-active group session. A later
ordinary group message remains context only until a member explicitly mentions or
replies to Minori again.

Live Group History is bounded by the Current Invocation's occurrence time, not by
the later worker start time. Messages sent while an event waits in the Durable
Conversation Queue cannot enter that event's context. A later invocation may read
those newer messages.

All invocations from one Group Context share the group chat ID as their durable
conversation key and execute serially in delivery order. Different groups and
private chats may use the existing four-way conversation concurrency.

One additive, rollback-compatible migration adds nullable Agent-run audit fields
for group-history status, message count, page-call count, cutoff, and stable error
category. It stores no history content or member identity. There are no write-flow,
Typing-lifecycle, retry-policy, or Write Replay Boundary changes. The scoped
group-history read tool, two Bot Authority read permissions, Group Context
assembly, durable metadata, and default execution budget are the only runtime
capability changes.

Product and operator documentation replaces the misleading `Agent Thread`
wording with `Group Context` where it describes the active interaction model.

## Failure behavior

Reply transport remains independently idempotent. A Feishu send failure keeps the
prepared reply durable and retries only the reply transport; it does not rerun the
Agent. Typing ownership and terminal removal remain unchanged.

No configuration switch is added. Non-threaded replies are the sole supported
behavior.

Live Group History is optional context, not an admission dependency. If its API
permission, timeout, or rate limit prevents loading it, the Agent still receives
the Current Invocation and retained Minori conversation records plus a stable
`group_history_unavailable` fact. It may answer independently or disclose the
missing context and ask for it. Runtime never claims history was loaded, never
serializes Feishu's raw provider error, and does not replay the whole Agent run
solely because this optional context was unavailable.

Audit metadata records only history availability, the number of messages supplied,
the Invocation Context Cutoff, page-call count, and a stable error category. It
does not record ordinary group-message bodies, display names, Open IDs, a message-ID
manifest, or Feishu's raw error. This supports operational diagnosis but deliberately
does not make a past model context fully replayable.

## Verification

Automated tests prove:

1. every reply request sets `reply_in_thread: false`;
2. private and directly mentioned group messages still receive replies;
3. replying to Minori invokes it without another mention and receives the same
   bounded Group Context;
4. unrelated group-timeline messages remain ignored;
5. earlier-history pagination cannot cross the current group or Invocation Context
   Cutoff and does not persist ordinary group messages;
6. history audit metadata contains status and counts but no content or identity;
7. reply idempotency, Typing, retry, restart recovery, and release contracts remain
   green.

Live acceptance on one exact release image proves:

1. a private message receives an ordinary, non-topic reply;
2. a direct group mention receives an ordinary, non-topic reply;
3. replying to that Minori group message invokes it without another mention and
   uses recent group history;
4. the same behavior remains after a service restart.

The acceptance group must use Feishu's ordinary-message group mode.
