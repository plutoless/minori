# Minori Non-Threaded Feishu Replies

**Date:** 2026-08-08

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
- A member can continue without another mention by replying to a Minori message
  in that reply chain.
- A normal group-timeline message that neither mentions nor replies to Minori is
  ignored.
- The existing root/reply-chain identifier, rather than a Feishu topic UI,
  scopes retained conversation history.

Existing historical topics are not migrated. The new release stops intentionally
creating topics for new replies.

## Component changes

`FeishuClientAdapter.replyText` keeps its current message-reply endpoint and UUID
idempotency key, but sends `reply_in_thread: false`. The gateway continues to
recognize a direct mention, a reply to Minori, and a continuation whose reply-chain
conversation already exists.

No database schema, Agent flow, knowledge tool, Typing lifecycle, retry policy,
write replay boundary, or permission boundary changes.

Product and operator documentation replaces the misleading `Agent Thread`
wording with `group reply chain` where it describes the active interaction model.

## Failure behavior

Reply transport remains independently idempotent. A Feishu send failure keeps the
prepared reply durable and retries only the reply transport; it does not rerun the
Agent. Typing ownership and terminal removal remain unchanged.

No configuration switch is added. Non-threaded replies are the sole supported
behavior.

## Verification

Automated tests prove:

1. every reply request sets `reply_in_thread: false`;
2. private and directly mentioned group messages still receive replies;
3. replying to Minori in a group reply chain continues the conversation without
   another mention;
4. unrelated group-timeline messages remain ignored;
5. reply idempotency, Typing, retry, restart recovery, and release contracts remain
   green.

Live acceptance on one exact release image proves:

1. a private message receives an ordinary, non-topic reply;
2. a direct group mention receives an ordinary, non-topic reply;
3. replying to that Minori group message continues without another mention;
4. the same behavior remains after a service restart.

