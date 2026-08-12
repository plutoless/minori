# Meeting Search Contract Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production Meeting Record search parse the official Lark CLI projection, avoid eager detail fan-out, and request only the meeting permissions the current Minori app can actually grant by default.

**Architecture:** `LarkMeetingService` normalizes the official lightweight search projection into run-local Meeting candidates, requiring only the Meeting Record ID. `searchMeetings` remains discovery-only and `fetchMeetingContent` keeps ownership of on-demand detail and content loading. OAuth and release contracts add `vc:record:readonly`, remove the unavailable advanced transcript scope from the default login set, and leave existing runtime transcript fallbacks intact.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK tools, Vitest, Lark CLI 1.0.84, GitHub Actions release contracts.

## Global Constraints

- Keep `@larksuite/cli` locked at 1.0.84; upgrading to 1.0.86 or later is out of scope.
- Parse only the official `id / display_info / meta_data` VC search projection; do not preserve the incorrect `meeting_id / topic / start_time` fixture contract.
- A non-empty `id` is the only required row field; use the fixed title `未命名会议` when `display_info` is empty.
- Do not infer structured time from `meta_data.description`; the server-side search range establishes inclusion and on-demand detail supplies exact times.
- Do not eagerly load details for every search result.
- Keep raw rows, display descriptions, provider cursors, and provider errors out of model context and Neon.
- Add `vc:record:readonly`; remove `vc:meeting.artifact.verbatim:read` from the default required OAuth set without deleting runtime transcript support.
- Do not add Calendar, recording-media, meeting-control, permission, sharing, or write scopes.

---

## File map

- `src/lark/meeting-service.ts`: official search projection schema and independent row normalization.
- `src/agent/meeting-tools.ts`: lightweight discovery output; selected content remains lazy.
- `test/fixtures/lark/vc-search.json`: literal sanitized official CLI response fixture.
- `test/lark/meeting-service.contract.test.ts`: public MeetingService contract regression.
- `test/agent/meeting-tools.test.ts`: public Agent tool regression proving no eager detail call.
- `scripts/lark-auth.ts`: default meeting OAuth scope list.
- `test/scripts/lark-auth.test.ts`: exact OAuth command contract.
- `test/scripts/release-contract.test.ts`: source-controlled release/documentation permission contract.
- `README.md`: operator permission and behavior guidance.
- `docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md`: active meeting design scope correction.

### Task 1: Parse the official search projection and keep discovery lightweight

**Files:**
- Modify: `src/lark/meeting-service.ts`
- Modify: `src/agent/meeting-tools.ts`
- Modify: `test/fixtures/lark/vc-search.json`
- Modify: `test/lark/meeting-service.contract.test.ts`
- Modify: `test/agent/meeting-tools.test.ts`

**Interfaces:**
- Consumes: `LarkExecutor.run({ id: 'vc.search', ... })` returning `{ items, has_more, page_token }`.
- Produces: `MeetingService.searchMeetings(input, signal): Promise<DiscoveryPage<MeetingCandidate>>`, where `MeetingCandidate.start` is optional and rows require only `meetingId`.
- Preserves: `fetchMeetingContent` resolves the stored `MeetingArtifactReference` and obtains authoritative detail through the existing `MeetingService.fetchContent` path.

- [ ] **Step 1: Replace the fixture with a literal sanitized official response and write the failing service test**

Use rows shaped like:

```json
{
  "items": [
    {
      "id": "m_1",
      "display_info": "DevX weekly",
      "meta_data": {
        "description": "provider-formatted display text",
        "app_link": "https://example.feishu.cn/video/m_1"
      }
    },
    { "id": "m_2", "display_info": "", "meta_data": {} },
    { "display_info": "missing id" }
  ],
  "has_more": true,
  "page_token": "vc_page_2"
}
```

Assert the public result exactly:

```ts
await expect(service.searchMeetings({
  start: '2026-08-10T00:00:00Z', end: '2026-08-12T00:00:00Z', pageSize: 30,
})).resolves.toEqual({
  status: 'partial',
  items: [
    {
      kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
      url: 'https://example.feishu.cn/video/m_1',
    },
    { kind: 'meeting', meetingId: 'm_2', title: '未命名会议' },
  ],
  rawCount: 3, validCount: 2, omittedCount: 1, nextPageToken: 'vc_page_2',
});
```

Also assert serialized output contains neither `provider-formatted display text` nor the provider page token outside `nextPageToken` handling.

- [ ] **Step 2: Run the service regression and verify RED**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts
```

Expected: the official rows are omitted and the test fails with `meeting_contract_error` or an old-shape mismatch.

- [ ] **Step 3: Implement the minimal official projection parser**

Change the candidate and row contracts to:

```ts
export type MeetingCandidate = {
  kind: 'meeting';
  meetingId: string;
  title: string;
  start?: string;
  end?: string;
  url?: string;
};

const meetingRowSchema = z.object({
  id: z.string().min(1),
  display_info: z.string().optional(),
  meta_data: z.object({
    app_link: z.unknown().optional(),
    description: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();
```

Normalize `id`, bounded `display_info || '未命名会议'`, and optional validated `meta_data.app_link`. Do not read `meta_data.description` into the candidate. Keep `normalizeRows` as the independent-row/fail-closed page boundary.

- [ ] **Step 4: Run the service regression and verify GREEN**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts
```

Expected: all service contract tests pass, including the existing all-invalid-page failure.

- [ ] **Step 5: Write the failing Agent-tool test for lazy detail**

At the public `searchMeetings` tool seam, configure one search candidate and make `getMeetingDetails` throw if called:

```ts
service.getMeetingDetails = vi.fn().mockRejectedValue(new Error('must_not_be_called'));

await expect(tools.searchMeetings.execute?.({
  participantNames: ['Alice'], range: { kind: 'recent' },
}, TOOL_CONTEXT)).resolves.toMatchObject({
  status: 'complete',
  results: [{ meetingRef: 'meeting_ref_1', title: 'DevX weekly' }],
});
expect(service.getMeetingDetails).not.toHaveBeenCalled();
```

The result must not contain `availableArtifacts`, `artifactAvailability`, a fabricated `start`, or provider identifiers.

- [ ] **Step 6: Run the Agent-tool regression and verify RED**

Run:

```bash
npx vitest run test/agent/meeting-tools.test.ts
```

Expected: the old implementation calls `getMeetingDetails` during search.

- [ ] **Step 7: Remove eager detail enrichment from discovery**

Delete the `getMeetingDetails([...unique.keys()])` block and availability mapping from `searchMeetings`. Return only:

```ts
results: [...unique.values()].map((item) => ({
  meetingRef: referenceFor(item),
  title: item.title,
  ...(item.start ? { start: item.start } : {}),
  ...(item.end ? { end: item.end } : {}),
  ...(item.url ? { url: item.url } : {}),
})),
```

The search status remains partial only when a provider window reports omitted rows. Do not change `fetchMeetingContent` or its detail/content resolution.

- [ ] **Step 8: Run focused Task 1 tests and typecheck**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts test/agent/meeting-tools.test.ts test/agent/run.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/lark/meeting-service.ts src/agent/meeting-tools.ts \
  test/fixtures/lark/vc-search.json test/lark/meeting-service.contract.test.ts \
  test/agent/meeting-tools.test.ts
git commit -m "fix: parse official meeting search results"
```

### Task 2: Correct the default OAuth and release contract

**Files:**
- Modify: `scripts/lark-auth.ts`
- Modify: `test/scripts/lark-auth.test.ts`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md`

**Interfaces:**
- Consumes: the existing `npm run lark:auth` operator flow.
- Produces: an exact default meeting-scope CSV containing `vc:record:readonly` and excluding `vc:meeting.artifact.verbatim:read`.
- Preserves: runtime Smart Meeting Note and Minute transcript code; only the default requested OAuth set changes.

- [ ] **Step 1: Write failing exact-scope contract tests**

Define the exact meeting scope list once in each public contract test:

```ts
const expectedMeetingScopes = [
  'contact:user:search',
  'vc:meeting.search:read',
  'vc:meeting.meetingevent:read',
  'vc:record:readonly',
  'vc:note:read',
  'minutes:minutes.search:read',
  'minutes:minutes.basic:read',
  'minutes:minutes.transcript:export',
];
```

Assert the auth runner receives `expectedMeetingScopes.join(',')`, README and the active meeting design contain every required scope, and all three exclude `vc:meeting.artifact.verbatim:read` from the default required list.

- [ ] **Step 2: Run the OAuth/release contracts and verify RED**

Run:

```bash
npx vitest run test/scripts/lark-auth.test.ts test/scripts/release-contract.test.ts
```

Expected: missing `vc:record:readonly` and the still-required advanced transcript scope fail assertions.

- [ ] **Step 3: Implement the exact default scope list**

Change `MEETING_READ_SCOPES` to the exact list above. Remove the duplicate `vc:note:read`. Do not change auth-device-flow, credential storage, strict-user mode, or runtime meeting tool code.

- [ ] **Step 4: Align operator and active design documentation**

Update README and `2026-08-12-meeting-minutes-search-design.md` to state:

- `vc:record:readonly` is required for selected Meeting Record detail;
- `vc:meeting.artifact.verbatim:read` is not part of the default required OAuth set in this tenant;
- unavailable original transcript sources degrade without blocking Meeting Record search, readable summaries, or Minute transcripts;
- Lark CLI remains 1.0.84 for this fix.

- [ ] **Step 5: Run focused Task 2 tests and typecheck**

Run:

```bash
npx vitest run test/scripts/lark-auth.test.ts test/scripts/release-contract.test.ts
npm run typecheck:scripts
```

Expected: all OAuth/release contracts and script typecheck pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/lark-auth.ts test/scripts/lark-auth.test.ts \
  test/scripts/release-contract.test.ts README.md \
  docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md
git commit -m "fix: require meeting detail oauth scope"
```

### Task 3: Verify the complete fix and prepare the operational handoff

**Files:**
- Modify only if a verification failure exposes a scoped defect.
- Review: all files changed since `github/main`.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: a clean reviewed branch ready for PR; no Feishu permission publication, OAuth, tag, approval, or production mutation occurs in this task.

- [ ] **Step 1: Run focused behavior and contract tests together**

```bash
npx vitest run \
  test/lark/meeting-service.contract.test.ts \
  test/agent/meeting-tools.test.ts \
  test/agent/run.test.ts \
  test/scripts/lark-auth.test.ts \
  test/scripts/release-contract.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full repository verification**

```bash
npm run verify
npm run test:integration
```

Expected: typechecks, unit/contract tests, build, and PostgreSQL integration tests all pass. If the local container runtime is unavailable, record the infrastructure failure and rerun once the runtime is healthy; do not treat skipped database tests as behavioral proof.

- [ ] **Step 3: Run hygiene checks**

```bash
git diff --check github/main...HEAD
rg -n 'meeting_id.*topic.*start_time|vc:meeting\.artifact\.verbatim:read' \
  src scripts test/fixtures/lark README.md docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md
```

Expected: no old VC search fixture contract remains. Any advanced transcript-scope reference that remains must explicitly describe an optional/unavailable capability rather than a default OAuth requirement.

- [ ] **Step 4: Review along Standards and Spec axes**

Use the `code-review` skill against fixed point `github/main`. Resolve every Critical or Important finding, rerun affected tests, and record any justified Minor without expanding scope.

- [ ] **Step 5: Confirm branch and handoff state**

```bash
git status --short --branch
git log --oneline github/main..HEAD
```

Expected: clean worktree with the approved design commits and implementation commits. Report the exact PR-ready SHA and these remaining external steps: publish `vc:record:readonly`, complete OAuth, run content-free search/detail probes, merge PR, create the next release tag, grant Production Approval, and verify the immutable production digest.
