# Meeting Evidence Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Minori discover completed Feishu meetings and independent Minutes, read their AI summaries by default, fall back to original transcripts when needed, and answer with authentic sources through the existing Dedicated Knowledge User.

**Architecture:** Add a focused `LarkMeetingService` beside the existing `LarkKnowledgeService`, backed only by fixed `lark-cli` user-identity commands. A separate run-scoped `createMeetingTools` module owns opaque references, pagination, content snapshots, and source registration; `runKnowledgeAgent` merges those tools with the existing knowledge tools for both member and Scheduled Runs. Persist only bounded operational audit counts in the existing `tool_runs` table, so no migration or meeting-content cache is introduced.

**Tech Stack:** TypeScript 7, Node.js 22+, Vercel AI SDK 7 tools, Zod 4, `@larksuite/cli` 1.0.84+, Vitest 4, Drizzle/PostgreSQL.

## Global Constraints

- All Contact, VC, Smart Meeting Note, Minutes, and document reads use the existing `lark-cli` Dedicated Knowledge User with forced `--as user --format json`.
- Add no raw API, HTTP, shell, generic CLI argument, media download, upload, update, permission, meeting-control, or Bot Authority path.
- Meeting content is inside the existing Knowledge Boundary and is not re-filtered against the requesting member, including external collaborators.
- Calendar events, future meetings, user-authored calendar Meeting Notes, and meeting attendance management remain out of scope.
- A request for “recent” meetings defaults to the preceding 30 days; explicit ranges longer than one month are split into contiguous provider-valid windows and deduplicated.
- Participant names resolve internally through typed user search; unique matches proceed, ambiguous matches request clarification, and unresolved names are never silently removed from the query.
- Product policy deliberately prefers a Feishu-generated AI summary, then another readable AI summary, then an original transcript when no summary is readable. Explicit transcript, summary, todo, chapter, or artifact-specific requests are honored without false relabeling.
- Five relevant meeting artifacts is a model-facing default selection target, not a hard runtime cap. Existing `AGENT_MAX_STEPS=40`, `AGENT_TIMEOUT_MS=300000`, meeting-content byte limits, and context budget remain the hard bounds.
- Interactive and Scheduled Runs receive the same meeting tools; the existing scheduling kill switch and execution boundaries remain unchanged.
- AI summaries, todos, chapters, transcripts, search queries, provider identifiers, participant identifiers, URLs, and local paths never enter Neon. Only content-free tool outcome/count audit is durable.
- File-producing transcript commands operate only inside a unique mode-0700 run-owned temporary directory, enforce an 8 MiB per-file and 24 MiB per-Agent-Run read budget, reject symlinks or containment escapes, and clean up in `finally`.
- Search rows normalize independently. One malformed or inaccessible artifact does not invalidate other verified evidence; a total contract failure is never reported as a successful empty result.
- Existing document reads/writes, Team Context, Group Context, rich replies, progress replies, scheduling, write fencing, deployment protocol, and rollback behavior must not regress.
- No Feishu console permission change, OAuth reauthorization, PR merge, tag, deployment, or live production query occurs without separate explicit authorization.

---

### Task 1: Add Fixed Meeting Commands and a Run-Owned Working Directory

**Files:**
- Modify: `src/lark/command-catalog.ts`
- Modify: `src/lark/runner.ts`
- Test: `test/lark/command-catalog.test.ts`
- Test: `test/lark/runner.test.ts`

**Interfaces:**
- Consumes: existing `LarkCommand`, `LarkInvocation`, `buildInvocation`, and `LarkRunner` envelope/error behavior.
- Produces: fixed command variants for Contact, VC, Note, and Minutes; `LarkInvocation.cwd?: string`; `LarkRunner` passes only the catalog-produced working directory to `spawn`.

- [ ] **Step 1: Write the failing command-catalog contract**

Add exact argv assertions for every approved command and compile-time refusals for write/media/raw variants:

```ts
expect(buildInvocation({
  id: 'contact.searchUser', query: 'Alice; $(touch /tmp/no)', pageSize: 10,
}).args).toEqual([
  'contact', '+search-user', '--query', 'Alice; $(touch /tmp/no)', '--page-size', '10',
  '--format', 'json', '--as', 'user',
]);
expect(buildInvocation({
  id: 'vc.search', query: 'DevX', start: '2026-07-01T00:00:00Z',
  end: '2026-07-31T23:59:59Z', participantIds: ['ou_a'], pageSize: 30,
}).args).toEqual([
  'vc', '+search', '--query', 'DevX', '--start', '2026-07-01T00:00:00Z',
  '--end', '2026-07-31T23:59:59Z', '--participant-ids', 'ou_a',
  '--page-size', '30', '--format', 'json', '--as', 'user',
]);
expect(buildInvocation({ id: 'vc.detail', meetingIds: ['m_1'] }).args)
  .toEqual(['vc', '+detail', '--meeting-ids', 'm_1', '--format', 'json', '--as', 'user']);
expect(buildInvocation({ id: 'note.detail', noteId: 'note_1' }).args)
  .toEqual(['note', '+detail', '--note-id', 'note_1', '--format', 'json', '--as', 'user']);
expect(buildInvocation({
  id: 'note.transcript', noteId: 'note_1', workDir: '/tmp/minori-meeting-1',
})).toEqual({
  args: [
    'note', '+transcript', '--note-id', 'note_1', '--output', 'unified_transcript.md',
    '--transcript-format', 'markdown', '--format', 'json', '--as', 'user',
  ],
  cwd: '/tmp/minori-meeting-1',
});
expect(buildInvocation({
  id: 'minutes.detail', minuteTokens: ['obc_1'], artifact: 'summary',
}).args).toEqual([
  'minutes', '+detail', '--minute-tokens', 'obc_1', '--summary',
  '--format', 'json', '--as', 'user',
]);
expect(buildInvocation({
  id: 'minutes.detail', minuteTokens: ['obc_1'], artifact: 'transcript',
  workDir: '/tmp/minori-meeting-1',
})).toEqual({
  args: [
    'minutes', '+detail', '--minute-tokens', 'obc_1', '--transcript',
    '--output-dir', '.', '--format', 'json', '--as', 'user',
  ],
  cwd: '/tmp/minori-meeting-1',
});
// @ts-expect-error meeting writes are outside the typed boundary
buildInvocation({ id: 'vc.meeting.update', meetingId: 'm_1' });
// @ts-expect-error media export is outside the typed boundary
buildInvocation({ id: 'minutes.media.export', minuteToken: 'obc_1' });
```

- [ ] **Step 2: Add a failing runner test for `cwd` propagation**

Extend the fake `spawn` capture and assert that only the invocation working directory is added while shell remains disabled and the strict child environment is unchanged:

```ts
await runner.run({
  id: 'note.transcript', noteId: 'note_1', workDir: '/tmp/minori-meeting-1',
});
expect(spawn).toHaveBeenCalledWith(
  binary,
  expect.arrayContaining(['note', '+transcript', '--note-id', 'note_1']),
  expect.objectContaining({ shell: false, cwd: '/tmp/minori-meeting-1' }),
);
expect(spawn.mock.calls[0]?.[2]?.env).not.toHaveProperty('OPENAI_API_KEY');
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run test/lark/command-catalog.test.ts test/lark/runner.test.ts --pool=threads --reporter=verbose
```

Expected: TypeScript/test collection reports missing command variants and `cwd`; every existing knowledge command assertion remains green.

- [ ] **Step 4: Implement the exact command union and invocation mapping**

Add these variants and keep all optional argument assembly inside `buildInvocation`:

```ts
type MeetingArtifact = 'basic' | 'summary' | 'todo' | 'chapter' | 'transcript';

export type LarkCommand =
  | { id: 'auth.status' }
  | { id: 'drive.search'; query: string; spaceIds?: string[] }
  | { id: 'docs.fetch'; doc: string }
  | { id: 'docs.create'; title: string; content: string; parentToken?: string }
  | { id: 'docs.append'; doc: string; content: string; revisionId: number }
  | { id: 'docs.patch'; doc: string; pattern: string; content: string; revisionId: number }
  | { id: 'wiki.spaceList' }
  | { id: 'wiki.nodeList'; spaceId: string; parentNodeToken?: string }
  | { id: 'wiki.nodeGet'; nodeToken: string }
  | { id: 'contact.searchUser'; query: string; pageSize: number }
  | {
      id: 'vc.search'; query?: string; start?: string; end?: string;
      organizerIds?: string[]; participantIds?: string[];
      pageSize: number; pageToken?: string;
    }
  | { id: 'vc.detail'; meetingIds: string[] }
  | { id: 'note.detail'; noteId: string }
  | { id: 'note.transcript'; noteId: string; workDir: string }
  | {
      id: 'minutes.search'; query?: string; start?: string; end?: string;
      ownerIds?: string[]; participantIds?: string[];
      pageSize: number; pageToken?: string;
    }
  | {
      id: 'minutes.detail'; minuteTokens: string[];
      artifact: Exclude<MeetingArtifact, 'transcript'>;
    }
  | {
      id: 'minutes.detail'; minuteTokens: string[];
      artifact: 'transcript'; workDir: string;
    };

export type LarkInvocation = { args: string[]; stdin?: string; cwd?: string };
```

For `minutes.detail`, map `basic` to no artifact flag, `todo` to `--todo`, `chapter` to `--chapter`, add `--output-dir .`, and set `cwd` only for `transcript`; do not add `--overwrite`. The basic form is used only to resolve a direct Minute result's associated `note_id` before applying Smart Meeting Note preference. For transcript output, a newly created empty directory guarantees no existing destination.

- [ ] **Step 5: Pass `cwd` through the runner without widening authority**

Change only the spawn options:

```ts
const invocation = buildInvocation(command);
child = this.options.spawn(this.options.binary, invocation.args, {
  shell: false,
  ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
  env: buildChildEnvironment(this.options.configDir),
  stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
}) as unknown as SpawnedProcess;
```

Do not accept cwd, flags, or executable names from Agent tool input.

- [ ] **Step 6: Run focused verification and commit**

Run:

```bash
npx vitest run test/lark/command-catalog.test.ts test/lark/runner.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
git add src/lark/command-catalog.ts src/lark/runner.ts test/lark/command-catalog.test.ts test/lark/runner.test.ts
git commit -m "feat: add typed meeting read commands"
```

Expected: focused tests and typecheck pass; the commit contains no service or Agent behavior.

---

### Task 2: Normalize Participant, Meeting, and Minute Discovery

**Files:**
- Create: `src/lark/meeting-service.ts`
- Create: `test/lark/meeting-service.contract.test.ts`
- Create: `test/fixtures/lark/contact-search-user.json`
- Create: `test/fixtures/lark/vc-search.json`
- Create: `test/fixtures/lark/vc-detail.json`
- Create: `test/fixtures/lark/minutes-search.json`
- Modify: `src/lark/errors.ts`

**Interfaces:**
- Consumes: `LarkExecutor.run`, the Task 1 commands, `LarkCliError`, `LarkContractError`, and `AbortSignal`.
- Produces: `MeetingService`, `LarkMeetingService`, safe discovery types, independent-row normalization, and stable discovery failures.

```ts
export type PersonResolution =
  | { status: 'resolved'; name: string; openId: string }
  | { status: 'ambiguous'; name: string; candidates: string[] }
  | { status: 'unresolved'; name: string };

export type MeetingCandidate = {
  kind: 'meeting'; meetingId: string; title: string;
  start: string; end?: string; url?: string;
};

export type MinuteCandidate = {
  kind: 'minute'; minuteToken: string; title: string;
  createdAt?: string; url?: string;
};

export type DiscoveryPage<T> = {
  status: 'complete' | 'partial'; items: T[];
  rawCount: number; validCount: number; omittedCount: number;
  nextPageToken?: string;
};

export interface MeetingService {
  resolvePeople(names: string[], signal?: AbortSignal): Promise<PersonResolution[]>;
  searchMeetings(input: {
    query?: string; start?: string; end?: string;
    organizerIds?: string[]; participantIds?: string[];
    pageToken?: string; pageSize: number;
  }, signal?: AbortSignal): Promise<DiscoveryPage<MeetingCandidate>>;
  getMeetingDetails(meetingIds: string[], signal?: AbortSignal): Promise<Array<{
    meetingId: string; title: string; start?: string; end?: string;
    noteId?: string; minuteToken?: string;
  }>>;
  searchMinutes(input: {
    query?: string; start?: string; end?: string;
    ownerIds?: string[]; participantIds?: string[];
    pageToken?: string; pageSize: number;
  }, signal?: AbortSignal): Promise<DiscoveryPage<MinuteCandidate>>;
}
```

- [ ] **Step 1: Add fixtures that include valid, partial, ambiguous, and malformed rows**

Use sanitized provider-shaped JSON. The contact fixture contains one exact Alice plus two same-name Alex rows; VC and Minutes fixtures contain valid rows, one malformed sibling, `has_more`, and `page_token`. Do not include real names, IDs, tenant domains, or meeting content.

- [ ] **Step 2: Write failing service contract tests**

Cover:

```ts
await expect(service.resolvePeople(['Alice', 'Alex', 'Missing'])).resolves.toEqual([
  { status: 'resolved', name: 'Alice', openId: 'ou_alice' },
  { status: 'ambiguous', name: 'Alex', candidates: ['Alex / Design', 'Alex / Platform'] },
  { status: 'unresolved', name: 'Missing' },
]);
await expect(service.searchMeetings({
  start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z',
  participantIds: ['ou_alice'], pageSize: 30,
})).resolves.toMatchObject({
  status: 'partial', rawCount: 3, validCount: 2, omittedCount: 1,
  nextPageToken: 'vc_page_2',
});
await expect(service.searchMinutes({ query: 'DevX', pageSize: 30 }))
  .resolves.toMatchObject({ status: 'partial', rawCount: 2, validCount: 1 });
```

Also assert every executor call receives the exact Task 1 command plus the passed abort signal, and that JSON/stringified errors never contain raw rows, participant IDs, provider messages, or query text.

- [ ] **Step 3: Run the new suite and confirm RED**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts --pool=threads --reporter=verbose
```

Expected: module/import failure because `meeting-service.ts` does not exist.

- [ ] **Step 4: Implement strict envelopes with tolerant rows**

Use Zod only for the minimum stable envelope and row identity fields; read optional strings with local helpers rather than failing an otherwise usable row:

```ts
const vcSearchSchema = z.object({
  items: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  page_token: z.string().optional(),
}).passthrough();

const vcRowSchema = z.object({ meeting_id: z.string().min(1) }).passthrough();

function normalizeRows<T>(raw: unknown[], normalize: (value: unknown) => T | undefined) {
  const items = raw.flatMap((value) => {
    const item = normalize(value);
    return item ? [item] : [];
  });
  const omittedCount = raw.length - items.length;
  if (raw.length > 0 && items.length === 0) {
    throw new MeetingContractError({
      rawCount: raw.length, validCount: 0, omittedCount,
    });
  }
  return {
    status: omittedCount === 0 ? 'complete' as const : 'partial' as const,
    items, rawCount: raw.length, validCount: items.length, omittedCount,
  };
}
```

`MeetingContractError` exposes only `meeting_contract_error` and completeness counts. It must not retain raw input.

- [ ] **Step 5: Implement conservative person resolution**

Run one bounded `contact.searchUser` call per unique name. Resolve only one exact localized-name match; otherwise return bounded display candidates without open IDs. Retain IDs only in the returned internal `resolved` variant. Do not return email, avatar, department IDs, phone, signature, or raw contact rows.

- [ ] **Step 6: Run focused verification and commit**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts test/lark/command-catalog.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
git add src/lark/meeting-service.ts src/lark/errors.ts test/lark/meeting-service.contract.test.ts test/fixtures/lark
git commit -m "feat: discover meeting evidence"
```

Expected: discovery contracts pass and no Agent tools or runtime wiring exist yet.

---

### Task 3: Select Meeting Content and Contain Transcript Files

**Files:**
- Modify: `src/lark/meeting-service.ts`
- Create: `src/lark/meeting-artifacts.ts`
- Modify: `test/lark/meeting-service.contract.test.ts`
- Create: `test/lark/meeting-artifacts.test.ts`
- Create: `test/fixtures/lark/note-detail-normal.json`
- Create: `test/fixtures/lark/note-detail-unified.json`
- Create: `test/fixtures/lark/minutes-detail-summary.json`
- Create: `test/fixtures/lark/minutes-detail-transcript.json`

**Interfaces:**
- Consumes: Task 2 discovery types, `KnowledgeReader.fetchDocument`, Task 1 Note/Minutes commands, and system temporary-directory primitives.
- Produces: `MeetingArtifactReference`, `MeetingContentKind`, `MeetingContentLoad`, and `MeetingService.fetchContent`.

```ts
export type MeetingArtifactReference =
  | { kind: 'meeting'; meetingId: string; title: string; start?: string; url?: string }
  | { kind: 'minute'; minuteToken: string; title: string; start?: string; url?: string };

export type MeetingContentRequest = 'auto' | 'summary' | 'todos' | 'chapters' | 'transcript';
export type MeetingArtifactPreference = 'auto' | 'smart_note' | 'minute';
export type MeetingContentKind =
  | 'smart_note_ai_summary' | 'minute_ai_summary'
  | 'smart_note_todos' | 'minute_todos' | 'minute_chapters'
  | 'smart_note_transcript' | 'minute_transcript';

export type MeetingContentLoad = {
  status: 'loaded'; kind: MeetingContentKind; title: string;
  meetingTime?: string; url?: string; text: string;
};

export type MeetingByteBudget = { remaining: number };

export interface MeetingArtifactStore {
  withDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T>;
  readFile(
    directory: string,
    candidatePath: string,
    budget: MeetingByteBudget,
  ): Promise<string>;
}

export function createMeetingByteBudget(): MeetingByteBudget {
  return { remaining: 24 * 1024 * 1024 };
}

export function systemMeetingArtifactStore(): MeetingArtifactStore;
```

Extend `MeetingService` with this exact method:

```ts
fetchContent(
  reference: MeetingArtifactReference,
  input: {
    contentKind: MeetingContentRequest;
    artifactPreference: MeetingArtifactPreference;
  },
  budget: MeetingByteBudget,
  signal?: AbortSignal,
): Promise<MeetingContentLoad>;
```

- [ ] **Step 1: Write failing selection-order tests**

Use a fake executor and fake `KnowledgeReader` to prove:

```ts
expect(await service.fetchContent(meetingRef, {
  contentKind: 'auto', artifactPreference: 'auto',
}, budget)).toMatchObject({
  kind: 'smart_note_ai_summary', text: expect.stringContaining('AI summary'),
});
expect(commands()).toEqual([
  { id: 'vc.detail', meetingIds: ['m_1'] },
  { id: 'note.detail', noteId: 'note_1' },
  { id: 'docs.fetch', doc: 'dox_note_summary' },
]);
```

Add separate cases for unreadable Smart Meeting Note → Minute summary, no readable summary → Smart Meeting Note transcript, explicit transcript bypassing summaries, explicit Smart Meeting Note request refusing Minute substitution, todo/chapter on-demand behavior, and one denied artifact not poisoning the next candidate.

- [ ] **Step 2: Write failing Note transcript routing tests**

Assert:

- `normal` or `unknown` plus `verbatim_doc_token` uses `KnowledgeReader.fetchDocument`;
- `unified` uses `note.transcript` and never trusts `verbatim_doc_token` for routing;
- `unknown` without a verbatim token returns stable `meeting_transcript_unavailable`;
- Minute transcript uses `minutes.detail` with only `--transcript`.

- [ ] **Step 3: Write failing filesystem containment tests**

Inject a temporary-root adapter so tests can assert mode, containment, and cleanup without touching production paths. Cover success, CLI rejection, abort, oversized file, final symlink, nested symlink, provider-returned outside path, malformed response, and read failure:

```ts
await expect(service.fetchContent(minuteRef, {
  contentKind: 'transcript', artifactPreference: 'minute',
}, budget, signal)).rejects
  .toMatchObject({ code: 'meeting_artifact_unsafe' });
expect(await readdir(testTempRoot)).toEqual([]);
expect(JSON.stringify(executor.run.mock.calls)).not.toContain('transcript body');
```

- [ ] **Step 4: Run the focused suite and confirm RED**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts --pool=threads --reporter=verbose
```

Expected: missing `fetchContent` and filesystem-boundary assertions fail; Task 2 discovery tests stay green.

- [ ] **Step 5: Implement content selection without duplicating document parsing**

Construct `LarkMeetingService` with both dependencies:

```ts
export class LarkMeetingService implements MeetingService {
  constructor(
    private readonly executor: LarkExecutor,
    private readonly knowledge: KnowledgeReader,
    private readonly artifacts: MeetingArtifactStore = systemMeetingArtifactStore(),
  ) {}
}
```

For a Meeting Record, resolve `note_id` / `minute_token` once per fetch. For `auto`, attempt Smart Meeting Note main document, then Minute `summary`, then transcript routing. Treat not-found/forbidden/not-ready as source-local unavailable categories; rethrow abort, timeout, and output-limit unchanged. Return the actual loaded kind; never return an empty successful body.

`artifactPreference: 'smart_note'` may use only the Smart Meeting Note chain; `artifactPreference: 'minute'` may use only the Minute chain; `auto` may use the fallback order. This preserves explicit “只看妙记” / “只看 Minute” requests without exposing provider identifiers.

- [ ] **Step 6: Implement the run-owned artifact reader**

Implement `MeetingArtifactStore` in `src/lark/meeting-artifacts.ts` and use these exact bounds:

```ts
const MAX_MEETING_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEETING_RUN_BYTES = 24 * 1024 * 1024;
```

Create directories with `mkdtemp(join(tmpdir(), 'minori-meeting-'))`, immediately `chmod(0o700)`, pass the exact directory as Task 1 `workDir`, and validate every returned or discovered file with `lstat`, `realpath`, regular-file checks, and root containment before reading. Count bytes before decoding UTF-8. Always `rm(workDir, { recursive: true, force: true })` in `finally`; never log the path.

- [ ] **Step 7: Run focused verification and commit**

Run:

```bash
npx vitest run test/lark/meeting-service.contract.test.ts test/lark/meeting-artifacts.test.ts \
  test/lark/runner.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
git add src/lark/meeting-service.ts src/lark/meeting-artifacts.ts \
  test/lark/meeting-service.contract.test.ts test/lark/meeting-artifacts.test.ts test/fixtures/lark
git commit -m "feat: read bounded meeting content"
```

Expected: all discovery, selection, routing, abort, and containment cases pass; no model or database code changes.

---

### Task 4: Expose Three Run-Scoped Meeting Tools

**Files:**
- Create: `src/agent/meeting-tools.ts`
- Create: `test/agent/meeting-tools.test.ts`
- Modify: `src/agent/sources.ts`
- Test: `test/agent/sources.test.ts`

**Interfaces:**
- Consumes: `MeetingService`, `MeetingArtifactReference`, `MeetingContentRequest`, `SourceRegistry`, Vercel AI SDK `tool`, and Zod.
- Produces: `createMeetingTools`, `MeetingReadAudit`, the three approved Agent tools, opaque run-local result references/cursors, serialized meeting state, and typed source metadata.

```ts
export type MeetingReadAuditInput = {
  toolName: 'searchMeetings' | 'searchMeetingMinutes' | 'fetchMeetingContent';
  success: boolean;
  rawCount?: number; validCount?: number; omittedCount?: number;
  fetchedCount?: 0 | 1;
  contentKind?: MeetingContentKind;
  errorCategory?:
    | 'meeting_contract_error'
    | 'meeting_search_unavailable'
    | 'meeting_content_unavailable'
    | 'meeting_artifact_unsafe'
    | 'meeting_participant_ambiguous'
    | 'meeting_participant_unresolved';
};

export interface MeetingReadAudit {
  record(input: MeetingReadAuditInput): void;
}

export function createMeetingTools(
  service: MeetingService,
  sources: SourceRegistry,
  audit: MeetingReadAudit,
  now: () => Date = () => new Date(),
): {
  searchMeetings: ReturnType<typeof tool>;
  searchMeetingMinutes: ReturnType<typeof tool>;
  fetchMeetingContent: ReturnType<typeof tool>;
};
```

- [ ] **Step 1: Write failing public-schema and authority tests**

Assert exact tool names and strict schemas. Model inputs contain natural filters and opaque references only:

```ts
expect(Object.keys(createMeetingTools(service, sources, audit))).toEqual([
  'searchMeetings', 'searchMeetingMinutes', 'fetchMeetingContent',
]);
await tools.searchMeetings.execute?.({
  participantNames: ['Alice'], range: { kind: 'recent' },
}, toolContext);
await tools.fetchMeetingContent.execute?.({
  meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto',
}, toolContext);
expect(JSON.stringify(tools)).not.toMatch(
  /open_id|meeting_id|minute_token|page_token|shell|raw api|permission|media download/iu,
);
```

Use this input contract:

```ts
const rangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recent') }).strict(),
  z.object({
    kind: z.literal('explicit'),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  }).strict(),
]);

const searchMeetingsInputSchema = z.object({
  query: z.string().min(1).max(500).optional(),
  organizerNames: z.array(z.string().min(1).max(100)).max(20).optional(),
  participantNames: z.array(z.string().min(1).max(100)).max(20).optional(),
  range: rangeSchema,
  cursor: z.string().min(1).max(200).optional(),
}).strict();

const searchMeetingMinutesInputSchema = z.object({
  query: z.string().min(1).max(500).optional(),
  ownerNames: z.array(z.string().min(1).max(100)).max(20).optional(),
  participantNames: z.array(z.string().min(1).max(100)).max(20).optional(),
  range: rangeSchema,
  cursor: z.string().min(1).max(200).optional(),
}).strict();

const fetchInputSchema = z.object({
  meetingRef: z.string().regex(/^meeting_ref_[1-9][0-9]*$/u),
  contentKind: z.enum(['auto', 'summary', 'todos', 'chapters', 'transcript']),
  artifactPreference: z.enum(['auto', 'smart_note', 'minute']).default('auto'),
  cursor: z.string().min(1).max(200).optional(),
}).strict();
```

- [ ] **Step 2: Write failing search-window and participant tests**

With `now = 2026-08-12T12:00:00Z`, assert `recent` becomes `2026-07-13T12:00:00Z` through `2026-08-12T12:00:00Z`. Implement `splitProviderWindows(start, end)` as a UTC calendar-month-clamped splitter: each window starts at the previous window's end, advances by at most one UTC calendar month, and the final window ends at the requested instant. Test January 31, leap-day, daylight-saving-offset input, and an explicit three-month range. Assert windows are queried in chronological order, inclusive boundary records are deduplicated by meeting ID/Minute token, and tool output exposes only opaque `meetingRef` values.

Add unique, ambiguous, and unresolved participant cases. Ambiguous output contains bounded display candidates and makes zero VC calls; unresolved output makes zero VC calls and asks the Agent to obtain another member-provided constraint.

- [ ] **Step 3: Write failing cursor and concurrency tests**

Prove that:

- provider page tokens never enter tool output;
- a matching cursor continues the exact search tuple;
- an invented, cross-run, or mismatched cursor restarts the current request at its first page;
- matching cursors remain reusable in the current run;
- two same-step meeting tool calls serialize their cursor/reference mutation and cannot overwrite each other's state;
- unrelated knowledge tools remain independent because serialization is local to one `createMeetingTools` instance.

- [ ] **Step 4: Write failing content, source, and soft-five tests**

Assert `fetchMeetingContent` caches a `Meeting Content Snapshot`, pages at 12,000 characters, returns the actual artifact/content type, and registers a title that contains source type plus meeting time:

```ts
expect(result).toMatchObject({
  content: expect.any(String),
  contentType: 'smart_note_ai_summary',
  source: {
    id: 1,
    title: '[Smart Meeting Note AI summary] DevX weekly — 2026-08-11T09:00:00Z',
    url: 'https://acme.feishu.cn/docx/dox_note_1',
  },
});
```

The tool description says “start with the five most relevant artifacts” and “continue when the member requests broader coverage or evidence remains insufficient,” but the implementation contains no `fetchCount >= 5` rejection. Add a test that a sixth distinct reference can still be fetched within the run.

- [ ] **Step 5: Run the new suite and confirm RED**

Run:

```bash
npx vitest run test/agent/meeting-tools.test.ts test/agent/sources.test.ts --pool=threads --reporter=verbose
```

Expected: module/import failure and missing typed source behavior.

- [ ] **Step 6: Implement run-local registries and serial mutation**

Keep provider references and cursors in closure-local maps:

```ts
type SearchContinuation = {
  kind: 'search';
  source: 'meeting' | 'minute';
  key: string;
  windowIndex: number;
  providerPageToken?: string;
};

type PageContinuation = {
  kind: 'content';
  referenceKey: string;
  contentKind: MeetingContentRequest;
  artifactPreference: MeetingArtifactPreference;
  pageIndex: number;
};

const references = new Map<string, MeetingArtifactReference>();
const cursors = new Map<string, { key: string; state: SearchContinuation | PageContinuation }>();
const snapshots = new Map<string, string[]>();
const byteBudget = createMeetingByteBudget();
let referenceSequence = 0;
let cursorSequence = 0;
let meetingTail = Promise.resolve();

function sequential<T>(operation: () => Promise<T>): Promise<T> {
  const pending = meetingTail.then(operation);
  meetingTail = pending.then(() => undefined, () => undefined);
  return pending;
}
```

Never place the map values, provider IDs, or provider page token in tool output. Bind every cursor to the normalized search tuple or exact meeting reference/content kind. Unknown/mismatched cursors begin at index/window/page zero without a recovery marker.

- [ ] **Step 7: Implement source registration with no schema expansion**

Keep `AgentSource` as `{ id, title, url }`. Build the safe content label and ISO meeting time into the title before calling `SourceRegistry.register`; reuse existing URL normalization/deduplication. A content result without a safe URL remains usable evidence but is not registered as a clickable source, and its tool output states `sourceUnavailable: true` without exposing a token.

- [ ] **Step 8: Run focused verification and commit**

Run:

```bash
npx vitest run test/agent/meeting-tools.test.ts test/agent/sources.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
git add src/agent/meeting-tools.ts src/agent/sources.ts test/agent/meeting-tools.test.ts test/agent/sources.test.ts
git commit -m "feat: expose run-scoped meeting tools"
```

Expected: all run-local state, soft-five, content paging, source labeling, and leakage tests pass.

---

### Task 5: Wire Meeting Tools into Member and Scheduled Agent Runs with Content-Free Audit

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `src/agent/instructions.ts`
- Modify: `src/app.ts`
- Modify: `src/storage/agent-run-store.ts`
- Modify: `test/agent/run.test.ts`
- Modify: `test/agent/injection.test.ts`
- Modify: `test/storage/agent-run-store.test.ts`
- Modify: `test/contract/team-agent.acceptance.test.ts`

**Interfaces:**
- Consumes: `createMeetingTools`, `MeetingService`, `MeetingReadAuditInput`, existing `SourceRegistry`, `tool_runs`, member invocation dependencies, and scheduled invocation dependency forwarding.
- Produces: the same three meeting tools in both run types, best-effort meeting audit, instructions reflecting the approved source policy, and end-to-end source delivery without a schema migration.

- [ ] **Step 1: Add failing Agent tool-injection tests**

Update the member and Scheduled Run model-call assertions to require exactly these additional tools:

```ts
expect(call.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
  'searchMeetings', 'searchMeetingMinutes', 'fetchMeetingContent',
]));
```

The prompt-injection test must prove retrieved meeting content cannot create a raw API, shell, permission, media, Calendar, or meeting-write tool. Add a Scheduled Run assertion using `createAgentInvocationRunner` so the same three tools are present without a separate meeting switch.

- [ ] **Step 2: Add failing instruction-contract tests**

Require the system instructions to state:

```ts
expect(TEAM_AGENT_INSTRUCTIONS).toContain(
  'Meeting search results are discovery metadata, not verified meeting content.',
);
expect(TEAM_AGENT_INSTRUCTIONS).toContain(
  'For ordinary meeting questions, start with the five most relevant artifacts; five is not a hard limit.',
);
expect(TEAM_AGENT_INSTRUCTIONS).toContain(
  'Prefer a readable Feishu AI summary; when none is readable, use the original transcript.',
);
expect(TEAM_AGENT_INSTRUCTIONS).toContain(
  'Label Feishu-generated summaries separately from original transcripts.',
);
```

Also require instructions to honor explicit summary/todo/chapter/transcript requests, cite actual fetched sources, and avoid Calendar claims.

- [ ] **Step 3: Add failing PostgreSQL audit tests**

Extend `AgentRunStore` with:

```ts
recordMeetingRead(agentRunId: string, input: MeetingReadAuditInput): Promise<void>;
```

Test success and failure rows for all three tool names. Expected summaries contain only bounded keys such as:

```text
raw=8 valid=6 omitted=2
fetched=1 kind=smart_note_ai_summary
fetched=0
```

Assert no write boundary is crossed and serialized rows do not match meeting titles, queries, body text, URLs, Open IDs, tokens, local paths, provider messages, or OAuth data.

- [ ] **Step 4: Add a failing real-Agent acceptance flow**

Drive a deterministic model through:

1. `searchMeetings` for a three-month range and participant name;
2. `fetchMeetingContent` with `auto`;
3. `searchMeetingMinutes` for an independent uploaded artifact;
4. one denied Minute plus one successful Smart Meeting Note summary;
5. a final answer containing both authentic source markers.

Assert one ordinary rich reply, no retry, terminal Typing removal, content-free Postgres audits, no persisted meeting bodies, and unchanged write tools. Add a Scheduled Run fixture that invokes `searchMeetings` and completes through the same service.

- [ ] **Step 5: Run the affected suites and confirm RED**

Run:

```bash
npx vitest run test/agent/run.test.ts test/agent/injection.test.ts \
  test/storage/agent-run-store.test.ts test/contract/team-agent.acceptance.test.ts \
  --pool=threads --reporter=verbose
```

Expected: missing `meetingService` dependencies, missing tool names, missing audit method, and instruction assertions fail.

- [ ] **Step 6: Merge knowledge and meeting tools at the Agent boundary**

Add `meetingService: MeetingService` to `TeamAgentDependencies` and `RunKnowledgeAgentDependencies`. Construct tools without changing the open-ended loop:

```ts
tools: {
  ...createKnowledgeTools(
    dependencies.service,
    dependencies.history,
    dependencies.sources,
    dependencies.writeAudit,
    dependencies.groupHistory,
    dependencies.teamContext,
    dependencies.schedules,
    dependencies.searchAudit,
  ),
  ...createMeetingTools(
    dependencies.meetingService,
    dependencies.sources,
    dependencies.meetingAudit,
  ),
},
```

Do not add an intent classifier or mandatory sequence. The model chooses among document, Meeting Record, and direct Minute search within the typed boundary.

Widen the operational callback by one stable category only:

```ts
onOperationalError(
  category: 'search_audit_unavailable' | 'meeting_audit_unavailable',
): void;
```

- [ ] **Step 7: Add best-effort content-free meeting audit**

Implement `recordMeetingRead` by inserting a terminal `tool_runs` row with the exact tool name, success, stable error category, and a summary assembled only from numeric counts plus allowlisted `MeetingContentKind`. In `runKnowledgeAgent`, fire-and-forget the audit like knowledge search; on failure call `onOperationalError('meeting_audit_unavailable')` without changing the tool result or crossing `beginWrite`.

- [ ] **Step 8: Construct one shared meeting service in the app**

In `initializeMessageRuntime`:

```ts
const knowledgeService = new LarkKnowledgeService(lark);
const meetingService = new LarkMeetingService(lark, knowledgeService);
```

Pass both services to member and scheduled dependencies. Keep a single instance for the initialized runtime, but keep references, cursors, snapshots, and byte accounting inside each `createMeetingTools` closure so no run shares meeting content.

- [ ] **Step 9: Run focused and PostgreSQL verification, then commit**

Run:

```bash
npx vitest run test/agent/run.test.ts test/agent/injection.test.ts \
  test/agent/meeting-tools.test.ts --pool=threads --reporter=verbose
npx vitest run test/storage/agent-run-store.test.ts \
  test/contract/team-agent.acceptance.test.ts --pool=threads --reporter=verbose
npm run typecheck
git diff --check
git add src/agent src/app.ts src/storage/agent-run-store.ts test/agent \
  test/storage/agent-run-store.test.ts test/contract/team-agent.acceptance.test.ts
git commit -m "feat: run audited meeting evidence tools"
```

Expected: both invocation types expose the same tools; Postgres audits contain counts only; existing write, reply, and scheduling acceptance remains green.

---

### Task 6: Extend OAuth, Operator Guidance, and Release Contracts

**Files:**
- Modify: `scripts/lark-auth.ts`
- Modify: `test/scripts/lark-auth.test.ts`
- Modify: `README.md`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md` only if implementation evidence requires a factual correction

**Interfaces:**
- Consumes: existing secure device-flow handoff, persistent Lark directories, published app scopes, CI verification commands, and the approved design.
- Produces: explicit additive read-only OAuth scopes, operator setup/diagnosis guidance, release-contract protection, and a verified implementation candidate without external mutation.

- [ ] **Step 1: Add a failing exact OAuth-command contract**

Keep the existing domains and request only explicit new scopes:

```ts
expect(runner.runJson).toHaveBeenCalledWith([
  'auth', 'login', '--domain', 'docs,drive,wiki',
  '--scope', [
    'contact:user:search',
    'vc:meeting.search:read',
    'vc:meeting.meetingevent:read',
    'vc:note:read',
    'vc:meeting.artifact.verbatim:read',
    'vc:note:read',
    'minutes:minutes.search:read',
    'minutes:minutes.basic:read',
    'minutes:minutes.transcript:export',
  ].join(','),
  '--no-wait', '--json',
]);
```

Assert the command does not request `contact:contact`, `vc:meeting`, recording/media, Minutes upload/media, Calendar, permission, or any write scope. Preserve terminal-only verification URL and hidden device-code behavior.

- [ ] **Step 2: Run the auth test and confirm RED**

Run:

```bash
npx vitest run test/scripts/lark-auth.test.ts test/scripts/lark-auth-home.test.ts \
  --pool=threads --reporter=verbose
```

Expected: exact login argv fails because the explicit meeting scopes are absent; existing secure HOME/device-flow assertions stay green.

- [ ] **Step 3: Implement the additive scope list**

Define one frozen constant in `scripts/lark-auth.ts`, join it into one `--scope` value, and leave login polling/status verification unchanged. Never print scopes alongside OAuth data in the operator handoff output.

- [ ] **Step 4: Document product behavior and permission rollout**

Update README with:

- completed Meeting Record vs Smart Meeting Note vs Minute;
- default 30-day search and monthly splitting;
- default AI summary, Minute-summary fallback, and no-summary transcript fallback;
- explicit transcript/todo/chapter behavior;
- soft five-artifact default and existing 40-step/300-second hard budgets;
- identical member/Scheduled Run capability;
- team-wide Knowledge Boundary disclosure warning;
- transient content and content-free audit;
- exact read scopes and the sequence: publish app scopes, then rerun `npm run lark:auth`;
- stable diagnosis categories without raw provider output.

Do not describe Calendar, tenant-wide discovery, media, meeting writes, requester-level re-filtering, or cached meeting content as supported.

- [ ] **Step 5: Add release-contract assertions**

Assert README, design, auth script, and command catalog agree on the exact scope set, strict-user-only commands, three tool names, default summary policy, no hard five cap, no migration, and no forbidden authority. Keep production env and Compose unchanged because this feature adds no environment variable.

- [ ] **Step 6: Run all local gates**

Run:

```bash
npx vitest run test/scripts/lark-auth.test.ts test/scripts/lark-auth-home.test.ts \
  test/scripts/release-contract.test.ts --pool=threads --reporter=verbose
npm run verify
npm run test:integration
git diff --check
```

Expected: script typecheck, application typecheck, all unit/contract tests, PostgreSQL integration, and build pass. If Testcontainers cannot reach the local container runtime, start the configured local runtime and rerun the exact failed command; do not report skipped database tests as green.

- [ ] **Step 7: Run the security and residue review**

Run:

```bash
rg -n "api\.raw|http\.request|shell\.exec|minutes\.media|minutes\.upload|vc\.meeting\.update|calendar" \
  src/lark/command-catalog.ts src/agent/meeting-tools.ts src/lark/meeting-service.ts
rg -n "meeting_id|minute_token|note_id|open_id|transcript|AI summary" \
  src/storage test/storage
git diff --check
```

Expected: the first scan finds only negative compile-time tests or no matches for forbidden commands; the storage scan finds schema/test vocabulary only and no persistence of meeting identifiers or bodies.

- [ ] **Step 8: Commit the release-ready implementation**

```bash
git add scripts/lark-auth.ts test/scripts/lark-auth.test.ts README.md \
  test/scripts/release-contract.test.ts docs/superpowers/specs/2026-08-12-meeting-minutes-search-design.md
git commit -m "docs: prepare meeting evidence rollout"
git status --short
```

Expected: worktree is clean. Stop before Feishu console changes, OAuth, PR merge, tag, GHCR publication, Production Approval, deployment, or live meeting queries; those require a separately authorized release run.
