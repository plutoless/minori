# Document Cursor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an invalid Agent-supplied document cursor transparently restart the requested document read from page one while preserving valid run-local continuation behavior.

**Architecture:** Keep pagination inside the existing run-scoped `createKnowledgeTools` closure. Resolve a cursor only when its stored document/mode/query key matches the current request; otherwise retain page index zero and return the normal first-page result. Strengthen the model-facing tool contract so recovery is a backstop, not the expected path.

**Tech Stack:** TypeScript, Vercel AI SDK tools, Zod, Vitest.

## Global Constraints

- Document Continuation Cursors exist only inside one Agent Run and never cross into durable state.
- A matching cursor remains reusable for the lifetime of that Agent Run.
- Unknown or mismatched cursors recover to the current request's first page without a model-visible marker.
- Recovery must not log, persist, or expose the cursor, document token, query, title, URL, or document body.
- Genuine Lark CLI, abort, timeout, output-limit, and document-contract failures retain their existing behavior.
- Knowledge search, group history, OAuth, permissions, database schema, messaging, and deployment protocol remain unchanged.

---

### Task 1: Recover Document Reads at the Public Tool Seam

**Files:**
- Modify: `src/agent/tools.ts:291-325`
- Test: `test/agent/tools.test.ts:600-645`

**Interfaces:**
- Consumes: `createKnowledgeTools(...)` and its model-facing `fetchDocument` tool.
- Produces: unchanged `fetchDocument` input and output shapes; invalid `cursor` input behaves like an omitted cursor, while a matching cursor still selects its stored page.

- [ ] **Step 1: Add the failing unknown-cursor regression**

Add a test through `createKnowledgeTools(...).fetchDocument.execute` using a document longer than 12,000 characters. The first invocation deliberately supplies an invented cursor and must return the first page with the ordinary result shape:

```ts
it('recovers an invented document cursor by reading the requested first page', async () => {
  const knowledge = service();
  knowledge.fetchDocument = vi.fn().mockResolvedValue({
    token: 'doxcnRecovery',
    title: 'Recovery document',
    url: 'https://acme.feishu.cn/docx/recovery',
    markdown: `# Recovery\n${'first-page evidence '.repeat(900)}`,
    revisionId: 1,
  });
  const tools = createKnowledgeTools(
    knowledge,
    { search: vi.fn().mockResolvedValue([]) },
    new SourceRegistry(),
    { run: (_input, operation) => operation() },
  );

  const result = await tools.fetchDocument.execute?.(
    { doc: 'doxcnRecovery', mode: 'full', cursor: 'invented_cursor' },
    { toolCallId: 'call_recovery', messages: [] },
  );

  expect(result?.markdown).toContain('first-page evidence');
  expect(result?.markdown.length).toBeLessThanOrEqual(12_000);
  expect(result?.source.nextCursor).toEqual(expect.any(String));
  expect(result).not.toHaveProperty('cursorRecovered');
  expect(knowledge.fetchDocument).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Add mismatched-cursor isolation and valid-reuse regressions**

At the same public seam, first read a long document A and capture its `nextCursor`. Assert that supplying it for document B returns B's first page and never A's content. Then use A's cursor twice with the original document/mode/query and assert both calls return the same continuation page:

```ts
it('isolates mismatched cursors while keeping matching cursors reusable', async () => {
  const knowledge = service();
  knowledge.fetchDocument = vi.fn(async ({ doc }) => ({
    token: doc,
    title: doc,
    url: `https://acme.feishu.cn/docx/${doc}`,
    markdown: doc === 'doxcnA'
      ? `# A\n${'A'.repeat(13_000)}`
      : `# B\n${'B-only evidence '.repeat(900)}`,
    revisionId: 1,
  }));
  const tools = createKnowledgeTools(
    knowledge,
    { search: vi.fn().mockResolvedValue([]) },
    new SourceRegistry(),
    { run: (_input, operation) => operation() },
  );
  const context = { toolCallId: 'call_cursor', messages: [] };

  const firstA = await tools.fetchDocument.execute?.(
    { doc: 'doxcnA', mode: 'full' }, context,
  );
  const cursor = firstA?.source.nextCursor;
  expect(cursor).toEqual(expect.any(String));

  const firstB = await tools.fetchDocument.execute?.(
    { doc: 'doxcnB', mode: 'full', cursor }, context,
  );
  expect(firstB?.markdown).toContain('B-only evidence');
  expect(firstB?.markdown).not.toContain('AAAA');

  const changedMode = await tools.fetchDocument.execute?.(
    { doc: 'doxcnA', mode: 'relevant', query: 'A', cursor }, context,
  );
  expect(changedMode?.markdown.length).toBe(12_000);

  const changedQuery = await tools.fetchDocument.execute?.(
    { doc: 'doxcnA', mode: 'full', query: 'different', cursor }, context,
  );
  expect(changedQuery?.markdown.length).toBe(12_000);

  const nextA = await tools.fetchDocument.execute?.(
    { doc: 'doxcnA', mode: 'full', cursor }, context,
  );
  const repeatedA = await tools.fetchDocument.execute?.(
    { doc: 'doxcnA', mode: 'full', cursor }, context,
  );
  expect(repeatedA?.markdown).toBe(nextA?.markdown);
  expect(knowledge.fetchDocument).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 3: Lock the model-facing cursor instructions**

Inspect the public tool metadata and input schema. Assert that the tool description says the first read omits the cursor, and that the cursor field description requires the exact returned `nextCursor` with unchanged document, mode, and query:

```ts
expect(tools.fetchDocument.description).toContain('First read must omit cursor');
const fetchSchema = tools.fetchDocument.inputSchema as {
  shape: { cursor: { description?: string } };
};
expect(fetchSchema.shape.cursor.description).toContain(
  'Exact nextCursor from the preceding page of the same doc, mode, and query',
);
```

- [ ] **Step 4: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run test/agent/tools.test.ts --pool=threads --reporter=verbose
```

Expected: the invented and mismatched cursor cases fail with `invalid_document_cursor`; existing valid continuation tests remain green.

- [ ] **Step 5: Implement transparent fallback and explicit instructions**

Replace the throwing cursor lookup with a matching lookup that leaves `index` at zero when the cursor is unknown or belongs to a different key. Keep matching cursors reusable by not deleting them:

```ts
fetchDocument: tool({
  description: [
    'Read an authorized Feishu document as bounded markdown evidence.',
    'First read must omit cursor.',
    'Continue only with the exact nextCursor returned for the same doc, mode, and query.',
  ].join(' '),
  inputSchema: z.object({
    doc: TOKEN_SCHEMA,
    mode: z.enum(['relevant', 'full']),
    query: z.string().min(1).max(500).optional(),
    cursor: z.string().min(1).max(200).optional().describe(
      'Exact nextCursor from the preceding page of the same doc, mode, and query; omit on first read.',
    ),
  }).strict(),
  execute: async ({ doc, mode, query, cursor }, { abortSignal }) => {
    const key = JSON.stringify([doc, mode, query ?? '']);
    const continuation = cursor ? cursors.get(cursor) : undefined;
    const index = continuation?.key === key ? continuation.index : 0;
    const document = await getDocument(doc, abortSignal);
    // Existing page-set creation and normal result construction remain unchanged.
  },
}),
```

Retain the existing `markdown === undefined` defensive error because a matching internally generated cursor pointing outside its immutable page set indicates an implementation invariant failure, not an untrusted cursor mismatch.

- [ ] **Step 6: Run the focused tests and confirm GREEN**

Run:

```bash
npx vitest run test/agent/tools.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
```

Expected: all Agent tool tests pass, typecheck passes, and the diff has no whitespace errors.

- [ ] **Step 7: Run repository verification**

Run:

```bash
npm run verify
npm run test:integration
```

Expected: typechecks, unit tests, build, and all PostgreSQL-backed integration tests pass. If the default local Vitest fork completes assertions but delays process cleanup, rerun the affected suite with `--pool=threads` and report the runner limitation separately; do not reinterpret it as a behavior pass without a successful exit.

- [ ] **Step 8: Review the scoped diff**

Verify all of the following before committing:

```bash
git diff --check
git diff -- src/agent/tools.ts test/agent/tools.test.ts CONTEXT.md \
  docs/superpowers/specs/2026-08-12-document-cursor-recovery-design.md
rg -n "cursorRecovered|document_cursor_recovered|invalid_document_cursor" src test
```

Expected: no recovery marker or recovery logging was added; `invalid_document_cursor` remains only where another strict cursor boundary or an internal invariant still needs it.

- [ ] **Step 9: Commit the implementation**

```bash
git add src/agent/tools.ts test/agent/tools.test.ts
git commit -m "fix: recover invalid document cursors"
```
