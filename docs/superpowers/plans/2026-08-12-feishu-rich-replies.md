# Feishu Rich Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Agent answers, Sources, operation receipts, and Scheduled Task results as Feishu rich-text posts while keeping progress and fixed failure notices on the existing plain-text control path.

**Architecture:** Add a small pure rich-content builder and semantic SDK operations for replying to a message or sending to a chat. Persist whether a prepared message is `rich` or `control` beside its prepared body so crash recovery repeats the same transport with the same idempotency key. Message and Scheduled workers select semantic operations; the adapter alone owns Feishu `post` envelopes and response validation.

**Tech Stack:** TypeScript 7, Node.js 22+, Vitest 4, Feishu Node SDK 1.72, PostgreSQL 17 Testcontainers.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-12-agent-failure-and-rich-reply-design.md`.
- Use the existing Feishu SDK Bot Authority; never invoke Lark CLI for message delivery.
- Rich Content Replies use Feishu `post` with exactly one `md` element and ordinary non-topic replies use `reply_in_thread: false`.
- Control Replies remain SDK `text`: Progress Reply, unsupported/fixed Agent failure reply, and Scheduled delivery-failure notice.
- Agent answers, authenticated Sources, Scheduled results, and budget/interruption receipts use the rich path.
- Preserve the existing bounded body, idempotency key, confirmed-message-ID requirement, deduplication window, retry classification, Typing lifecycle, and uncertain-delivery behavior.
- An ambiguous rich send must never trigger a plain-text resend of the same body.
- Neutralize Markdown image syntax into a labeled ordinary link; never fetch or upload Agent-provided image URLs.
- Pass unsupported Markdown through as best-effort content; do not add a general Markdown parser, CommonMark converter, interactive cards, or global downgrade.
- Persist only the semantic prepared kind needed for recovery; no raw SDK response or additional message body copy.
- TDD each slice, run `git diff --check`, and commit after each independently green task.

---

### Task 1: Build and send one safe Feishu Markdown post

**Files:**
- Create: `src/feishu/rich-content.ts`
- Create: `test/feishu/rich-content.test.ts`
- Modify: `src/feishu/client.ts`
- Modify: `test/feishu/client.test.ts`

**Interfaces:**
- Produces `neutralizeMarkdownImages(markdown: string): string`.
- Produces `richPostContent(markdown: string): string`, the serialized Feishu `post` content.
- Adds `FeishuMessenger.replyRichContent(messageId, markdown, idempotencyKey): Promise<string>`.
- Adds `ScheduledResultMessenger.sendRichContent(chatId, markdown, idempotencyKey): Promise<string>`.
- Retains `replyText` and `sendText` for Control Replies.

- [ ] **Step 1: Write failing pure conversion tests**

Create `test/feishu/rich-content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { neutralizeMarkdownImages, richPostContent } from '../../src/feishu/rich-content.js';

describe('Feishu rich content', () => {
  it('wraps Markdown in exactly one md element', () => {
    expect(JSON.parse(richPostContent('# 标题\n\n- **项目**\n- [来源](https://example.com)')))
      .toEqual({
        zh_cn: {
          title: '',
          content: [[{
            tag: 'md',
            text: '# 标题\n\n- **项目**\n- [来源](https://example.com)',
          }]],
        },
      });
  });

  it('turns Markdown images into labeled links without changing ordinary links', () => {
    const markdown = '![架构图](https://img.example/diagram.png) [文档](https://example.com/doc)';
    expect(neutralizeMarkdownImages(markdown)).toBe(
      '[图片：架构图](https://img.example/diagram.png) [文档](https://example.com/doc)',
    );
  });

  it('uses a stable label for empty image alt text', () => {
    expect(neutralizeMarkdownImages('![](https://img.example/a.png)'))
      .toBe('[图片](https://img.example/a.png)');
  });
});
```

- [ ] **Step 2: Write failing SDK payload contracts**

Add to `test/feishu/client.test.ts`:

```ts
it('replies with one ordinary non-topic Markdown post and exact idempotency key', async () => {
  client.im.v1.message.reply.mockResolvedValue({ data: { message_id: 'om_rich' } });
  await expect(adapter.replyRichContent(
    'om_trigger',
    '# Result\n\n[1] Source — https://example.com',
    'evt_1:reply:v1',
  )).resolves.toBe('om_rich');

  expect(client.im.v1.message.reply).toHaveBeenCalledWith({
    path: { message_id: 'om_trigger' },
    data: {
      content: expect.any(String),
      msg_type: 'post',
      reply_in_thread: false,
      uuid: 'evt_1:reply:v1',
    },
  });
  const payload = JSON.parse(client.im.v1.message.reply.mock.calls[0]![0].data.content);
  expect(payload.zh_cn.content).toEqual([[{
    tag: 'md',
    text: '# Result\n\n[1] Source — https://example.com',
  }]]);
});

it('sends a Scheduled result as a top-level Markdown post', async () => {
  client.im.v1.message.create.mockResolvedValue({ data: { message_id: 'om_scheduled' } });
  await expect(adapter.sendRichContent('oc_target', '**Done**', 'sched_1:result'))
    .resolves.toBe('om_scheduled');
  expect(client.im.v1.message.create).toHaveBeenCalledWith({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_target',
      msg_type: 'post',
      content: expect.any(String),
      uuid: 'sched_1:result',
    },
  });
});
```

Retain the existing `replyText` and `sendText` tests unchanged to lock the Control Reply path.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run test/feishu/rich-content.test.ts test/feishu/client.test.ts
```

Expected: FAIL because the module and rich SDK methods do not exist.

- [ ] **Step 4: Implement image neutralization and the post envelope**

Create `src/feishu/rich-content.ts`:

```ts
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;

export function neutralizeMarkdownImages(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE, (_match, rawAlt: string, url: string) => {
    const alt = rawAlt.trim();
    return `[${alt ? `图片：${alt}` : '图片'}](${url})`;
  });
}

export function richPostContent(markdown: string): string {
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: neutralizeMarkdownImages(markdown) }]],
    },
  });
}
```

Do not perform HTTP requests, file reads, or SDK image uploads in this module.

- [ ] **Step 5: Implement semantic rich SDK operations**

Widen only the local `FeishuSdk` payload types from `msg_type: 'text'` to:

```ts
msg_type: 'text' | 'post';
```

Add `replyRichContent` and `sendRichContent` to the interfaces and adapter. They mirror the existing idempotency validation and API success checks, but set `msg_type: 'post'` and `content: richPostContent(markdown)`:

```ts
async replyRichContent(
  messageId: string,
  markdown: string,
  idempotencyKey: string,
): Promise<string> {
  this.assertMessageKey(idempotencyKey, 'invalid_reply_idempotency_key');
  const response = await this.client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      content: richPostContent(markdown),
      msg_type: 'post',
      reply_in_thread: false,
      uuid: idempotencyKey,
    },
  });
  assertApiSuccess(response, 'reply_failed');
  const replyMessageId = response.data?.message_id;
  if (!replyMessageId) throw new Error('reply_missing_message_id');
  return replyMessageId;
}
```

Extract the duplicated key length check into a private adapter helper and use it from both text and rich operations without changing error codes.

- [ ] **Step 6: Run focused tests and prove there is no media side effect**

Run:

```bash
npx vitest run test/feishu/rich-content.test.ts test/feishu/client.test.ts
npm run typecheck
```

Expected: all tests pass. The fake SDK observes only `message.reply`/`message.create`; no fetch, media, file, or Lark CLI method exists in the conversion path.

- [ ] **Step 7: Commit the adapter slice**

```bash
git add src/feishu/rich-content.ts src/feishu/client.ts \
  test/feishu/rich-content.test.ts test/feishu/client.test.ts
git commit -m "feat: send Feishu rich content replies"
```

---

### Task 2: Preserve reply semantics across message retries and recovery

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/event-store.ts`
- Modify: `src/worker/message-worker.ts`
- Modify: `test/storage/event-store.test.ts`
- Modify: `test/worker/message-worker.test.ts`
- Modify: `test/worker/progress-reply.test.ts`

**Interfaces:**
- Adds `PreparedReplyKind = 'rich' | 'control'` in `src/storage/event-store.ts`.
- Extends `StoredEvent` with optional `preparedReplyKind?: PreparedReplyKind`.
- Changes `markReplyStarted(..., prepared?: { text: string; kind: PreparedReplyKind })` so text and kind enter the existing outcome JSON atomically.
- `MessageWorker` uses `replyRichContent` only for rich prepared replies and `replyText` only for controls.

- [ ] **Step 1: Write the failing durable-kind storage tests**

In `test/storage/event-store.test.ts`, update the prepared-reply case:

```ts
await store.markReplyStarted('evt_1', 1, 'reply-key', attemptedAt, {
  text: '# Answer',
  kind: 'rich',
});
await store.retry('evt_1', 1, 'reply_failed', new Date());
const [recovered] = await store.claimReady(1, new Date(Date.now() + 60_000));
expect(recovered).toMatchObject({
  preparedReplyText: '# Answer',
  preparedReplyKind: 'rich',
  replyIdempotencyKey: 'reply-key',
});
```

Add a legacy outcome assertion proving an absent kind is treated as unsafe recovery, not silently guessed.

- [ ] **Step 2: Write failing MessageWorker semantic-delivery tests**

Extend the messenger fixture in `test/worker/message-worker.test.ts`:

```ts
replyRichContent: vi.fn(async () => 'om_reply_1'),
```

Change the completed answer/Sources expectations to `replyRichContent`, and add:

```ts
it('keeps unsupported and final fixed failure replies on plain text', async () => {
  // Run the existing unsupported fixture and the third-attempt Agent failure fixture.
  expect(messenger.replyText).toHaveBeenCalled();
  expect(messenger.replyRichContent).not.toHaveBeenCalled();
});

it('recovers a prepared rich reply with the same operation and key', async () => {
  await worker.process(storedEvent({
    replyAttemptedAt: new Date('2026-08-05T00:59:30Z'),
    replyIdempotencyKey: 'minori-fixed-key',
    preparedReplyText: '# Recovered',
    preparedReplyKind: 'rich',
  }));
  expect(messenger.replyRichContent).toHaveBeenCalledWith(
    'om_1', '# Recovered', 'minori-fixed-key',
  );
  expect(messenger.replyText).not.toHaveBeenCalled();
});

it('marks a legacy prepared reply without a kind uncertain without sending', async () => {
  await worker.process(storedEvent({
    replyAttemptedAt: new Date('2026-08-05T00:59:30Z'),
    replyIdempotencyKey: 'legacy-key',
    preparedReplyText: 'legacy body',
  }));
  expect(eventStore.calls).toContain('uncertain');
  expect(messenger.replyText).not.toHaveBeenCalled();
  expect(messenger.replyRichContent).not.toHaveBeenCalled();
});
```

Keep `test/worker/progress-reply.test.ts` asserting Progress Reply calls `replyText` exactly once and never calls `replyRichContent`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npx vitest run test/storage/event-store.test.ts \
  test/worker/message-worker.test.ts test/worker/progress-reply.test.ts
```

Expected: FAIL on the missing prepared kind and rich messenger method.

- [ ] **Step 4: Persist prepared text and kind in the existing outcome JSON**

In `src/storage/event-store.ts` add:

```ts
export type PreparedReplyKind = 'rich' | 'control';
```

In `src/storage/schema.ts`, extend the existing `EventOutcome` TypeScript shape without adding a column:

```ts
export type EventOutcome = {
  replyMessageId?: string;
  errorCode?: string;
  preparedReplyText?: string;
  preparedReplyKind?: 'rich' | 'control';
};
```

Change the optional `markReplyStarted` parameter to:

```ts
preparedReply?: { text: string; kind: PreparedReplyKind };
```

Write it through the existing update:

```ts
...(preparedReply === undefined ? {} : {
  outcome: {
    preparedReplyText: preparedReply.text,
    preparedReplyKind: preparedReply.kind,
  },
}),
```

Return both JSON fields from `claimReady`:

```sql
event.outcome ->> 'preparedReplyText' as "preparedReplyText",
event.outcome ->> 'preparedReplyKind' as "preparedReplyKind"
```

Validate the returned kind explicitly:

```ts
const preparedReplyKind = row.preparedReplyKind === 'rich'
  || row.preparedReplyKind === 'control'
  ? row.preparedReplyKind
  : undefined;
```

Do not add a database column or migration: this semantic recovery metadata lives beside the already persisted prepared body.

- [ ] **Step 5: Select rich versus control before durable reply start**

In `MessageWorker.prepareReply`, carry this shape:

```ts
type PreparedReply = {
  text: string;
  kind: PreparedReplyKind;
  key: string;
  attemptedAt: Date;
};
```

Use `control` for `UNSUPPORTED_REPLY` and `TEMPORARY_ERROR_REPLY`. Use `rich` for `formatAgentReply(reply)`, including recovered write receipts and budget/interruption outcomes. Persist both values:

```ts
await this.options.eventStore.markReplyStarted(
  event.eventId,
  event.attempts,
  key,
  attemptedAt,
  { text, kind },
);
```

At delivery:

```ts
const send = prepared.kind === 'rich'
  ? this.options.messenger.replyRichContent(
    event.payload.messageId, prepared.text, prepared.key,
  )
  : this.options.messenger.replyText(
    event.payload.messageId, prepared.text, prepared.key,
  );
replyMessageId = await this.withAbort(send, signal);
```

Require both `preparedReplyText` and `preparedReplyKind` in the recovery eligibility check. An older in-flight prepared reply without the kind moves to existing `reply_uncertain`; do not guess or resend.

- [ ] **Step 6: Prove ambiguous rich delivery does not downgrade**

Add a worker test whose `replyRichContent` rejects after the prepared marker. Assert the event follows the existing `reply_failed` retry/uncertain path, `replyText` is never called with the body, and `runAgent` is not invoked again during prepared-reply recovery.

- [ ] **Step 7: Run focused worker, storage, and progress tests**

Run:

```bash
npx vitest run test/worker/message-worker.test.ts test/worker/progress-reply.test.ts \
  test/worker/restart-recovery.test.ts
npx vitest run --config vitest.integration.config.ts test/storage/event-store.test.ts
npm run typecheck
```

Expected: rich answers recover through rich transport; controls remain text; idempotency and uncertain-delivery behavior remain unchanged.

- [ ] **Step 8: Commit the message-worker slice**

```bash
git add src/storage/schema.ts src/storage/event-store.ts src/worker/message-worker.ts \
  test/storage/event-store.test.ts test/worker/message-worker.test.ts \
  test/worker/progress-reply.test.ts test/worker/restart-recovery.test.ts
git commit -m "feat: preserve rich reply delivery semantics"
```

---

### Task 3: Send Scheduled results richly and failure notices plainly

**Files:**
- Modify: `src/schedule/delivery.ts`
- Modify: `src/schedule/worker.ts`
- Modify: `test/schedule/worker.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Consumes `ScheduledResultMessenger.sendRichContent` and `.sendText` from Task 1.
- Produces `deliverScheduledRichContent(...)` for frozen Scheduled results.
- Produces `deliverScheduledControlText(...)` for body-free Origin failure notices and fixed run failures.
- Uses `formatAgentReply` so authenticated Scheduled sources are included once.

- [ ] **Step 1: Write failing Scheduled delivery tests**

Extend the fixture in `test/schedule/worker.test.ts`:

```ts
const messenger = {
  sendRichContent: vi.fn().mockResolvedValue('om_result'),
  sendText: vi.fn().mockResolvedValue('om_control'),
};
```

For a completed Agent reply with a source:

```ts
agent.runScheduled.mockResolvedValue({
  text: '**Done**',
  outcome: 'completed',
  sources: [{ id: 1, title: 'Plan', url: 'https://example.com/plan' }],
  usage: {},
  writeAttempts: [],
});
await worker.processOne(new Date());
expect(messenger.sendRichContent).toHaveBeenCalledWith(
  'oc_target',
  '**Done**\n\nSources:\n[1] Plan — https://example.com/plan',
  `s:${run.id}:result`,
);
expect(messenger.sendText).not.toHaveBeenCalled();
```

For ambiguous rich delivery, reject `sendRichContent`, allow the existing Origin fallback, and assert:

```ts
expect(messenger.sendRichContent).toHaveBeenCalledOnce();
expect(messenger.sendText).toHaveBeenCalledOnce();
expect(messenger.sendText.mock.calls[0]![0]).toBe('oc_origin');
expect(messenger.sendText.mock.calls[0]![1]).not.toMatch(/Done|Sources|example\.com/iu);
```

Add a fixed Scheduled Agent failure case and assert the result-target failure notice uses `sendText`, while a returned budget/interruption receipt uses `sendRichContent`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/schedule/worker.test.ts
```

Expected: FAIL because the worker only calls `sendText` and drops Scheduled sources.

- [ ] **Step 3: Split semantic Scheduled delivery helpers**

In `src/schedule/delivery.ts`, replace `deliverScheduledText` with:

```ts
export function deliverScheduledRichContent(
  messenger: ScheduledResultMessenger,
  chatId: string,
  markdown: string,
  idempotencyKey: string,
) {
  return messenger.sendRichContent(chatId, markdown, idempotencyKey);
}

export function deliverScheduledControlText(
  messenger: ScheduledResultMessenger,
  chatId: string,
  text: string,
  idempotencyKey: string,
) {
  return messenger.sendText(chatId, text, idempotencyKey);
}
```

Keep `scheduledFailureNotice` unchanged and body-free.

- [ ] **Step 4: Route results, fixed failures, and fallbacks deliberately**

In `src/schedule/worker.ts`, import `formatAgentReply`. When `runScheduled` returns, compute:

```ts
text = formatAgentReply(reply);
deliveryKind = 'rich';
```

When `runScheduled` throws without lease loss, keep the fixed failure text and set:

```ts
deliveryKind = 'control';
```

After `prepareDelivery`, call the rich or control helper based on this local kind. The Origin fallback always calls `deliverScheduledControlText`. Do not retry the Result Target and do not send the prepared rich body to Origin.

- [ ] **Step 5: Extend PostgreSQL acceptance across message and schedule paths**

In `test/contract/team-agent.acceptance.test.ts`, update the fake messenger to record `{ format: 'rich' | 'control' }`. Assert:

```ts
expect(messenger.repliesWithSources.every((reply) => reply.format === 'rich')).toBe(true);
expect(messenger.progressAndFixedFailures.every((reply) => reply.format === 'control')).toBe(true);
expect(messenger.scheduledResults).toContainEqual(expect.objectContaining({
  chatId: 'oc_target',
  format: 'rich',
  key: expect.stringContaining(':result'),
}));
```

Keep assertions for ordinary non-topic reply keys, confirmed message IDs, Typing cleanup, exact Scheduled target, and no Agent rerun.

- [ ] **Step 6: Run focused and integration tests**

Run:

```bash
npx vitest run test/schedule/worker.test.ts test/worker/message-worker.test.ts \
  test/feishu/client.test.ts test/feishu/rich-content.test.ts
npx vitest run --config vitest.integration.config.ts test/contract/team-agent.acceptance.test.ts
npm run typecheck
```

Expected: Agent and Scheduled results are rich; Progress/fixed/fallback notices are text; sources are retained once.

- [ ] **Step 7: Commit the Scheduled delivery slice**

```bash
git add src/schedule/delivery.ts src/schedule/worker.ts \
  test/schedule/worker.test.ts test/contract/team-agent.acceptance.test.ts
git commit -m "feat: render scheduled results as rich content"
```

---

### Task 4: Lock the product contract and run release gates

**Files:**
- Modify: `README.md`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Produces active product guidance that distinguishes Rich Content Reply from Control Reply.
- Produces a source-level contract that Lark CLI remains strict-user-only and is absent from message delivery.
- Does not change prompts, Team Context, history assembly, tool routing, or response length.

- [ ] **Step 1: Write the failing active-guidance contract**

Add to `test/scripts/release-contract.test.ts`:

```ts
it('documents SDK rich replies without granting Lark CLI Bot Authority', async () => {
  const readme = await text('README.md');
  const client = await text('src/feishu/client.ts');
  const larkRunner = await text('src/lark/runner.ts');

  expect(readme).toContain('Rich Content Reply');
  expect(readme).toContain('Control Reply');
  expect(readme).toContain('Feishu `post`');
  expect(readme).toContain('Markdown images become ordinary links');
  expect(readme).toContain('Lark CLI remains strict-user-only');
  expect(client).toContain("msg_type: 'post'");
  expect(larkRunner).not.toMatch(/sendRichContent|replyRichContent|message\.create|message\.reply/u);
});
```

- [ ] **Step 2: Run the release contract and confirm RED**

Run:

```bash
npx vitest run test/scripts/release-contract.test.ts
```

Expected: FAIL because active README guidance does not yet describe the two reply types.

- [ ] **Step 3: Update active operator and acceptance guidance**

In `README.md`, add a compact paragraph after the existing reply/Progress Reply description stating:

```markdown
Normal Agent answers, authenticated Sources, operation receipts, and Scheduled Task results are **Rich Content Replies** sent by the Feishu SDK as `post` content with one `md` element. Markdown images become ordinary links and are never fetched or uploaded automatically. Progress and fixed failure notices are **Control Replies** sent as plain SDK text. Lark CLI remains strict-user-only and is never used for messaging. This rendering change does not alter prompts, Team Context, conversation history, retry policy, or answer length.
```

Extend live acceptance with one private rich-format sample, one Source-linked answer, one short answer, and one Scheduled result. Record only the already-approved sanitized acceptance fields; never record bodies, names, diagnostics, SDK responses, or credentials.

- [ ] **Step 4: Run the complete repository gate**

Run with a working local Docker runtime:

```bash
npx vitest run test/scripts/release-contract.test.ts \
  test/feishu/rich-content.test.ts test/feishu/client.test.ts \
  test/worker/progress-reply.test.ts test/worker/message-worker.test.ts \
  test/schedule/worker.test.ts
npm run verify
npm run test:integration
git diff --check
```

Expected: all unit, PostgreSQL integration, release-contract, typecheck, and build gates pass. Search the diff for `lark` messaging, `fetch(`, media upload, raw SDK logging, and text fallback of rich bodies; none may be introduced.

- [ ] **Step 5: Commit the contract slice**

```bash
git add README.md test/scripts/release-contract.test.ts \
  test/contract/team-agent.acceptance.test.ts
git commit -m "docs: define rich and control replies"
```

---

## Plan Self-Review

- Spec coverage: SDK `post`, one `md` element, Sources, image neutralization, semantic control messages, Scheduled delivery, recovery format, idempotency, message-ID validation, uncertain delivery, no CLI messaging, no media fetch, and live acceptance all map to explicit tasks.
- Placeholder scan: no generic converter, unspecified fallback, or deferred implementation instruction remains.
- Type consistency: `PreparedReplyKind`, `replyRichContent`, and `sendRichContent` names are defined once and used consistently by storage, workers, and tests.
