# Tolerant Knowledge Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `searchKnowledge` preserve independently usable Lark Wiki results, expose bounded completeness metadata, and leave a content-free diagnostic record without delaying or failing an otherwise successful read.

**Architecture:** Normalize the current `result_meta.token` response one row at a time inside `LarkKnowledgeService`, with legacy `entity_id` only as fallback and URL as optional metadata. Return a typed Knowledge Search Result Set, then let the Agent tool enqueue one best-effort completed `tool_runs` audit tied to the current Agent Run; Persistent Agent Write auditing and the Write Replay Boundary remain untouched.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK tools, Drizzle ORM, PostgreSQL/Testcontainers, Vitest.

## Global Constraints

- `result_meta.token` is the primary identifier; legacy `entity_id` is fallback only.
- A valid token and `entity_type` make a row usable; URL is optional and retained only when it is HTTP(S).
- Parse rows independently; never expose rejected rows or the raw Lark response to the model.
- Empty raw results are a complete empty success; non-empty results with zero valid rows fail as `knowledge_search_contract_error`.
- Partial success returns `status`, `rawCount`, `validCount`, and `omittedCount` to the Agent.
- Search audit uses the existing `tool_runs` table and requires no migration.
- Search audit persistence is best-effort and never marks the Write Replay Boundary.
- Never persist the query, titles, URLs, tokens, bodies, Open IDs, or raw provider errors.
- Only `searchKnowledge` changes; fetch, space/node reads, writes, retry, idempotency, and delivery remain unchanged.

---

### Task 1: Normalize search results row by row

**Files:**
- Modify: `src/lark/errors.ts`
- Modify: `src/lark/knowledge-service.ts`
- Modify: `test/lark/knowledge-service.contract.test.ts`
- Create: `test/fixtures/lark/drive-search-current-wiki.json`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/agent/injection.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Consumes: `LarkExecutor.run({ id: 'drive.search', ... })` and the existing `fetchDocument({ doc })` token contract.
- Produces: `KnowledgeSearchResultSet`, optional `KnowledgeSearchResult.url`, and `KnowledgeSearchContractError` carrying content-free completeness counts.

- [ ] **Step 1: Add literal failing contract tests for the current and legacy shapes**

Add a fixture whose `data.results` includes: one current Wiki row with `result_meta.token`, one legacy row with `entity_id`, one row containing both different identifiers, one usable row with a malformed URL, and one malformed row without either identifier. Do not put secrets or real production content in the fixture.

```json
{
  "data": {
    "results": [
      {
        "entity_type": "WIKI",
        "entity_id": "legacy_ignored",
        "result_meta": {
          "token": "wikcnCurrent",
          "url": "https://acme.feishu.cn/wiki/wikcnCurrent"
        },
        "title_highlighted": "Current <h>Wiki</h>"
      },
      {
        "entity_type": "DOCX",
        "entity_id": "doxcnLegacy",
        "result_meta": { "url": "https://acme.feishu.cn/docx/doxcnLegacy" },
        "title": "Legacy document"
      },
      {
        "entity_type": "WIKI",
        "result_meta": { "token": "wikcnNoUrl", "url": "not a url" },
        "title": "Fetchable without URL"
      },
      {
        "entity_type": "WIKI",
        "result_meta": { "url": "https://acme.feishu.cn/wiki/missing" }
      }
    ]
  }
}
```

Assert the first three rows survive in provider order, `wikcnCurrent` wins over `legacy_ignored`, the malformed URL is omitted from that result rather than rejecting it, and completeness is `{ status: 'partial', rawCount: 4, validCount: 3, omittedCount: 1 }`.

Also add separate tests for:

```ts
expect(await reader.search({ query: 'none' })).toEqual({
  status: 'complete', results: [], rawCount: 0, validCount: 0, omittedCount: 0,
});

await expect(reader.search({ query: 'broken' })).rejects.toMatchObject({
  code: 'knowledge_search_contract_error',
  completeness: { rawCount: 2, validCount: 0, omittedCount: 2 },
});
```

- [ ] **Step 2: Run the focused contract test and capture RED**

Run: `npm test -- test/lark/knowledge-service.contract.test.ts`

Expected: FAIL because search still requires array-wide `entity_id`, returns an array, and has no `KnowledgeSearchContractError`.

- [ ] **Step 3: Add the result-set and stable error types**

In `src/lark/knowledge-service.ts`, define:

```ts
export type KnowledgeSearchResult = {
  title: string;
  url?: string;
  token: string;
  type: string;
};

export type KnowledgeSearchResultSet = {
  status: 'complete' | 'partial';
  results: KnowledgeSearchResult[];
  rawCount: number;
  validCount: number;
  omittedCount: number;
};
```

Change `KnowledgeReader.search` to return `Promise<KnowledgeSearchResultSet>`.

In `src/lark/errors.ts`, add a content-free error:

```ts
export class KnowledgeSearchContractError extends Error {
  readonly code = 'knowledge_search_contract_error' as const;

  constructor(readonly completeness: {
    rawCount: number;
    validCount: 0;
    omittedCount: number;
  }) {
    super('knowledge_search_contract_error');
    this.name = 'KnowledgeSearchContractError';
  }
}
```

- [ ] **Step 4: Replace array-wide row validation with tolerant normalization**

Keep a strict outer envelope requiring `results: unknown[]`, but normalize each row independently. The implementation must follow this shape:

```ts
const driveSearchSchema = z.object({ results: z.array(z.unknown()) }).passthrough();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
```

For each object row, require non-empty `entity_type`; derive token as `result_meta.token ?? entity_id`; derive title from string-valued `title`, string-valued `title_highlighted`, then token. Include `url` only when `httpUrl(result_meta.url)` succeeds. Count every raw row once and every omitted row once.

If `rawCount > 0 && validCount === 0`, throw `KnowledgeSearchContractError`. Otherwise return:

```ts
return {
  status: omittedCount === 0 ? 'complete' : 'partial',
  results,
  rawCount,
  validCount: results.length,
  omittedCount,
};
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- test/lark/knowledge-service.contract.test.ts && npm run typecheck`

Expected: PASS. Fix only compile errors caused by the intentional `KnowledgeReader.search` return-type change. In `test/agent/tools.test.ts`, `test/agent/run.test.ts`, `test/agent/injection.test.ts`, and `test/contract/team-agent.acceptance.test.ts`, change each bare search result array into a `KnowledgeSearchResultSet`, for example:

```ts
search: vi.fn().mockResolvedValue({
  status: 'complete', results: [], rawCount: 0, validCount: 0, omittedCount: 0,
}),
```

- [ ] **Step 6: Commit the normalization slice**

```bash
git add src/lark/errors.ts src/lark/knowledge-service.ts test/lark/knowledge-service.contract.test.ts test/fixtures/lark/drive-search-current-wiki.json test/agent/tools.test.ts test/agent/run.test.ts test/agent/injection.test.ts test/contract/team-agent.acceptance.test.ts
git commit -m "fix: tolerate current Lark search results"
```

---

### Task 2: Persist a best-effort content-free search audit

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/run.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `src/app.ts`
- Modify: `test/agent/tools.test.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/storage/agent-run-store.test.ts`

**Interfaces:**
- Consumes: `KnowledgeSearchResultSet`, `KnowledgeSearchContractError`, the current Agent Run ID, and existing `tool_runs` columns.
- Produces: `KnowledgeSearchAudit.record(input)`, `AgentRunStore.recordKnowledgeSearch(agentRunId, input)`, and the operational category `search_audit_unavailable`.

- [ ] **Step 1: Write failing tool tests for success, partial success, contract failure, and audit failure**

Define the narrow interface in the test contract:

```ts
export type KnowledgeSearchAuditInput = {
  success: boolean;
  rawCount: number;
  validCount: number;
  omittedCount: number;
  errorCategory?: 'knowledge_search_contract_error';
};

export interface KnowledgeSearchAudit {
  // Must return immediately and must not throw.
  record(input: KnowledgeSearchAuditInput): void;
}
```

Tests must prove:

```ts
expect(searchAudit.record).toHaveBeenCalledWith({
  success: true, rawCount: 10, validCount: 8, omittedCount: 2,
});
```

and, when `KnowledgeSearchContractError` is thrown:

```ts
expect(searchAudit.record).toHaveBeenCalledWith({
  success: false,
  errorCategory: 'knowledge_search_contract_error',
  rawCount: 10,
  validCount: 0,
  omittedCount: 10,
});
```

The original error must still be thrown. A `record` implementation that reports its own failure must not change a successful tool result.

- [ ] **Step 2: Run the tool tests and capture RED**

Run: `npm test -- test/agent/tools.test.ts test/agent/run.test.ts`

Expected: FAIL because `searchKnowledge` calls the service directly and no search-audit dependency exists.

- [ ] **Step 3: Add the tool-level audit seam**

Add `KnowledgeSearchAuditInput` and `KnowledgeSearchAudit` to `src/agent/tools.ts`. Pass one required `searchAudit` argument immediately after `writeAudit` in `createKnowledgeTools` and through `TeamAgentDependencies`.

Wrap only `searchKnowledge.execute`:

```ts
execute: async ({ query, spaceIds }, { abortSignal }) => {
  try {
    const result = await service.search({
      query,
      ...(spaceIds ? { spaceIds } : {}),
    }, abortSignal);
    searchAudit.record({
      success: true,
      rawCount: result.rawCount,
      validCount: result.validCount,
      omittedCount: result.omittedCount,
    });
    return result;
  } catch (error) {
    if (error instanceof KnowledgeSearchContractError) {
      searchAudit.record({
        success: false,
        errorCategory: error.code,
        ...error.completeness,
      });
    }
    throw error;
  }
},
```

Do not wrap `fetchDocument`, list-space/node tools, or any write tool.

- [ ] **Step 4: Add one completed-row storage method without a migration**

Extend `AgentRunStore`:

```ts
recordKnowledgeSearch(
  agentRunId: string,
  input: KnowledgeSearchAuditInput,
): Promise<void>;
```

Implement one insert into existing `toolRuns`:

```ts
await this.db.insert(toolRuns).values({
  agentRunId,
  toolName: 'searchKnowledge',
  success: input.success,
  errorCategory: input.errorCategory ?? null,
  sanitizedSummary: `raw=${input.rawCount} valid=${input.validCount} omitted=${input.omittedCount}`,
  finishedAt: new Date(),
});
```

Do not call `beginWrite`, do not update `processed_events` or `scheduled_runs`, and do not populate `targetIdentifiers` or `resultIdentifiers`.

- [ ] **Step 5: Prove the PostgreSQL storage boundary**

In `test/storage/agent-run-store.test.ts`, start a real Agent Run, call `recordKnowledgeSearch`, and query `tool_runs`. Assert the exact allowed columns and null forbidden columns:

```ts
expect(row).toMatchObject({
  toolName: 'searchKnowledge',
  success: true,
  errorCategory: null,
  sanitizedSummary: 'raw=10 valid=8 omitted=2',
  targetIdentifiers: null,
  resultIdentifiers: null,
});
```

Assert the linked `processed_events.write_started_at` remains null. Add the failure-row assertion with only `knowledge_search_contract_error` and counts.

- [ ] **Step 6: Wire best-effort recording to the current Agent Run**

Add this dependency to `RunKnowledgeAgentDependencies`:

```ts
onOperationalError(category: 'search_audit_unavailable'): void;
```

After `agentRunStore.start` returns the run ID, construct:

```ts
const searchAudit: KnowledgeSearchAudit = {
  record(input) {
    void dependencies.agentRunStore.recordKnowledgeSearch(run.id, input)
      .catch(() => dependencies.onOperationalError('search_audit_unavailable'));
  },
};
```

Pass it into `createTeamAgentWithBudget`. This is deliberately not awaited: a slow or unavailable PostgreSQL audit must not delay the tool result. It contains no member content and does not use the Agent abort signal.

In both message and scheduled dependency construction in `src/app.ts`, provide:

```ts
onOperationalError: (errorCode) => {
  logger.warn({ errorCode }, 'agent operational audit unavailable');
},
```

Update the `agentRunStore` test factory with a resolved `recordKnowledgeSearch` mock and the dependency test factory with an `onOperationalError` spy. Test that a rejected storage promise eventually calls the spy once while the model still receives and uses the successful result set.

- [ ] **Step 7: Run focused unit and PostgreSQL tests**

Run:

```bash
npm test -- test/agent/tools.test.ts test/agent/run.test.ts
npm test -- test/storage/agent-run-store.test.ts
npm run typecheck
```

Expected: all pass. If the PostgreSQL test is skipped because the sandbox cannot reach Docker, rerun the same command with the workspace's approved local container access; do not treat a skipped container suite as passing evidence.

- [ ] **Step 8: Commit the audit slice**

```bash
git add src/agent/tools.ts src/agent/run.ts src/storage/agent-run-store.ts src/app.ts test/agent/tools.test.ts test/agent/run.test.ts test/storage/agent-run-store.test.ts
git commit -m "feat: audit tolerant knowledge searches"
```

---

### Task 3: Verify the real Agent boundary and release readiness

**Files:**
- Modify: `test/contract/team-agent.acceptance.test.ts`
- Modify: `docs/superpowers/specs/2026-08-12-tolerant-knowledge-search-design.md`

**Interfaces:**
- Consumes: the real `runKnowledgeAgent`, `LarkKnowledgeService`, `PostgresAgentRunStore`, deterministic model seam, and the normal immutable release workflow.
- Produces: one database-backed acceptance proof and a precise operator-only production verification checklist.

- [ ] **Step 1: Write a failing real-Agent acceptance test**

Add an acceptance case that uses the real `runKnowledgeAgent` and `LarkKnowledgeService`, with a fake executor returning a non-secret analogue of the current DEVX response: ten raw Wiki rows using `result_meta.token`, eight valid and two malformed. The deterministic model must call `searchKnowledge`, then call `fetchDocument` with one returned current-format token, then answer.

Assert:

```ts
expect(reply.outcome).toBe('completed');
expect(executorCommands).toContainEqual({ id: 'docs.fetch', doc: 'wikcnCurrent' });
expect(searchToolResult).toMatchObject({
  status: 'partial', rawCount: 10, validCount: 8, omittedCount: 2,
});
```

Query PostgreSQL and assert exactly one completed `searchKnowledge` row with `raw=10 valid=8 omitted=2`, no identifiers, no query, and no fixture title/token/URL in its serialized value. Assert no write receipt was produced and `processed_events.write_started_at` remains null.

Because recording is intentionally asynchronous, use `vi.waitFor` to observe the
row instead of adding a production-only flush method or making the tool await PostgreSQL.

- [ ] **Step 2: Run the acceptance test and capture RED, then GREEN**

Run: `npm test -- test/contract/team-agent.acceptance.test.ts`

Expected before the Task 1/2 commits: contract failure or missing audit row. Expected after them: PASS with the real Agent fetching a document by `result_meta.token`.

- [ ] **Step 3: Lock the no-migration and release-verification contract in the design**

Confirm `git diff --name-only 295979c -- drizzle` is empty. Update the design Production Verification section with these exact pass conditions:

```text
- exact released image remains healthy with restart count 0;
- the bounded DEVX query completes without knowledge_search_contract_error;
- one or more normalized results are returned;
- one searchKnowledge tool_runs row contains counts only;
- no result title, URL, token, body, identity, OAuth value, or environment value is printed or stored.
```

Do not put the real query text or returned document metadata into an acceptance record.

- [ ] **Step 4: Run all local release gates**

Run:

```bash
npm run verify
npm run test:integration
git diff --check
```

Expected: typechecks, all Vitest suites, build, and integration pass. Container-backed tests must execute rather than skip.

- [ ] **Step 5: Review both standards and spec axes**

Review the complete diff from commit `295979c` against:

- `CONTEXT.md` terms `Knowledge Search Audit`, `Knowledge Search Result Set`, `Persistent Agent Write`, and `Write Replay Boundary`;
- `docs/superpowers/specs/2026-08-12-tolerant-knowledge-search-design.md`;
- repository security rules forbidding secret or content-bearing audit output.

Reject the implementation if any successful read can be failed by audit persistence, any search path calls `beginWrite`, any raw row reaches the model/database/log, or any write contract becomes tolerant.

- [ ] **Step 6: Commit the acceptance slice**

```bash
git add test/contract/team-agent.acceptance.test.ts docs/superpowers/specs/2026-08-12-tolerant-knowledge-search-design.md
git commit -m "test: cover tolerant knowledge search flow"
```

- [ ] **Step 7: Stop at the production authorization gate**

Prepare the exact immutable candidate SHA and sanitized probe, but do not merge, tag, approve Production, deploy, query production Wiki, or read production audit rows without the user's explicit authorization for those actions. Local and packaged evidence alone must not be described as live Feishu acceptance.
