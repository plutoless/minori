# Lark CLI Contract Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-shaped Lark CLI assumptions with sanitized literal fixtures for every live-verifiable command case, explicitly record unavailable cases, fix Smart Note detail parsing, and detect future drift before release.

**Architecture:** Keep `LarkRunner`, `command-catalog.ts`, and existing service parsers as the production boundary. Add script-only manifest, sanitizer, and audit modules; runner tests consume Envelope Fixtures and service tests consume mechanically extracted Data Fixtures. A reviewed host launcher uses an exact trusted image and only the Lark store, then installs verified sanitized artifacts atomically into the worktree.

**Tech Stack:** TypeScript 7, Node.js 22, Zod 4, Vitest 4, Lark CLI 1.0.84, Docker, GitHub Actions.

## Global Constraints

- Keep `@larksuite/cli` resolved exactly to `1.0.84`.
- No dynamic contract registry, production DTO layer, raw CLI tool, or startup check.
- `auth.status` is the only `envelope_only` case.
- Verified business cases require mechanically linked Envelope/Data Fixtures; unavailable cases get no invented fixture.
- Structural Cases represent only materially different live wrappers.
- Raw output, names, bodies, IDs/tokens, URLs, OAuth values, titles, and transcripts never enter Git.
- Unknown strings become `<redacted-string>` and produce `needs_review`.
- Raw capture remains in a root-protected temporary directory and is deleted.
- The audit gets non-secret Lark paths and the Lark store, never `/opt/minori/minori.env`.
- Floating tags and unmerged application images never receive production OAuth.
- Worktree replacement is atomic; the tool never commits, pushes, or opens a PR.
- Public errors remain operation-level; internal diagnostics use command/case/stage.
- Reuse the single document `Minori Lark CLI Contract Audit`.

---

## File map

- `scripts/lark-contract-manifest.ts`: manifest schema, canonical JSON, digests, version equality, fixture verification, atomic installation.
- `scripts/lark-contract-sanitizer.ts`: redaction, string classification, residue and transcript-file checks.
- `scripts/lark-contract-audit.ts`: bounded discovery, capture, audit states, fixed-document lifecycle, sanitized report.
- `deploy/vultr/lark-contract-audit.sh`: exact-image and trusted-path checks plus isolated Docker execution.
- `test/fixtures/lark/cli-1.0.84/`: manifest and sanitized fixture evidence.
- `test/helpers/lark-contract-fixture.ts`: manifest-backed test loader.
- `test/scripts/lark-contract-*.test.ts`: operator subsystem contracts.
- `test/lark/runner.test.ts`: Envelope Fixture contracts.
- `test/lark/knowledge-service.contract.test.ts`: Knowledge Data Fixture contracts.
- `test/lark/meeting-service.contract.test.ts`: Meeting fixtures and Smart Note regression.
- `src/lark/meeting-service.ts`: minimal `{ note: ... }` parser correction.
- `README.md`, `package.json`, `package-lock.json`: runbook and release contract.

### Task 1: Manifest, fixture integrity, and version boundary

**Files:**
- Create: `scripts/lark-contract-manifest.ts`
- Create: `test/scripts/lark-contract-manifest.test.ts`
- Create: `test/helpers/lark-contract-fixture.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `FixtureMode`, `AuditState`, `LarkContractManifest`.
- Produces `loadContractManifest(path)`, `verifyFixtureSet(input)`, `installFixtureSetAtomically(input)`.
- Produces `loadFixtureEnvelope(caseId)` and `loadFixtureData(caseId)`.

- [ ] **Step 1: Write RED manifest tests**

Use a temporary verified entry containing `caseId`, `commandVariant`, `fixtureMode`, paths/digests, owning test, operation category, state, and `unclassifiedStringFields`. Assert verified Data equals `envelope.data`; only auth may be envelope-only; unavailable/not-exercised cases have no fixture paths; duplicate IDs, traversal, symlinks, digest drift, and malformed states fail.

- [ ] **Step 2: Add version RED cases**

Read only `package-lock.json.packages['node_modules/@larksuite/cli'].version`. Assert lockfile, manifest, and fixture directory must all equal `1.0.84`; mismatch returns `lark_contract_version_mismatch`.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/scripts/lark-contract-manifest.test.ts
```

Expected: missing-module failure.

- [ ] **Step 4: Implement schemas and integrity**

```ts
export function canonicalJson(value: unknown): string;
export async function sha256File(path: string): Promise<string>;
export async function loadContractManifest(path: string): Promise<LarkContractManifest>;
export async function verifyFixtureSet(input: {
  manifestPath: string; fixtureRoot: string; lockfilePath: string;
}): Promise<void>;
```

Require canonical JSON bytes, exact digests, regular contained files, and exact Data/Envelope linkage.

- [ ] **Step 5: Implement atomic install and loader**

Verify staging before rename; restore the old directory on injected rename failure. `loadFixtureData` rejects envelope-only and non-verified cases. Add:

```json
"lark:contract-audit": "node --experimental-strip-types scripts/lark-contract-audit.ts"
```

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run test/scripts/lark-contract-manifest.test.ts
npm run typecheck:scripts
git add package.json scripts/lark-contract-manifest.ts test/helpers/lark-contract-fixture.ts test/scripts/lark-contract-manifest.test.ts
git commit -m "feat: define lark contract fixture boundary"
```

### Task 2: Sanitization and residue protection

**Files:**
- Create: `scripts/lark-contract-sanitizer.ts`
- Create: `test/scripts/lark-contract-sanitizer.test.ts`
- Modify: `scripts/lark-contract-manifest.ts`
- Modify: `test/scripts/lark-contract-manifest.test.ts`

**Interfaces:**
- Produces `sanitizeCapture(value, classifications): SanitizationResult`.
- Produces `scanForbiddenResidue(paths)` and `validateTranscriptArtifact(root, relativePath, maxBytes)`.

- [ ] **Step 1: Write RED redaction tests**

Assert IDs, URLs, text, and unknown strings become `<redacted-id>`, `<redacted-url>`, `<redacted-text>`, and `<redacted-string>`; known enums such as `unified` remain; empty strings/types/nesting remain. Unknown fields report JSON paths only.

- [ ] **Step 2: Write RED residue/artifact tests**

Reject credential patterns, OAuth/device URLs, provider identifiers, traversal, symlinked files, empty files, and oversized transcript files. Transcript content must never be returned.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/scripts/lark-contract-sanitizer.test.ts
```

Expected: missing-module failure.

- [ ] **Step 4: Implement the small classifier**

```ts
export type StringClass = 'enum' | 'id' | 'url' | 'text' | 'unknown';
export type SanitizationResult = { value: unknown; unclassifiedStringFields: string[] };
```

Allowlist structural enum field/value pairs. Classify by semantic field name; default all unfamiliar non-empty strings to `<redacted-string>`.

- [ ] **Step 5: Gate atomic replacement**

Require no unclassified fields or residue. `needs_review`/`failed` do not replace the existing directory; `unavailable` and `not_exercised_by_policy` may appear without fixtures.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run test/scripts/lark-contract-sanitizer.test.ts test/scripts/lark-contract-manifest.test.ts
npm run typecheck:scripts
git add scripts/lark-contract-sanitizer.ts scripts/lark-contract-manifest.ts test/scripts/lark-contract-sanitizer.test.ts test/scripts/lark-contract-manifest.test.ts
git commit -m "feat: sanitize lark contract captures"
```

### Task 3: Live Audit orchestration and fixed write document

**Files:**
- Create: `scripts/lark-contract-audit.ts`
- Create: `test/scripts/lark-contract-audit.test.ts`
- Create: `deploy/vultr/lark-contract-audit.sh`
- Modify: `test/scripts/release-contract.test.ts`

**Interfaces:**
- Produces `runContractAudit(dependencies, options): Promise<ContractAuditReport>`.
- CLI modes: `--capture`, `--install <directory>`, `--include-write-audit`, `--bootstrap-audit-document`.
- Report fields: case, command, optional structural case, stage, state, operation category, counts, CLI version, timestamp.

- [ ] **Step 1: Write RED completeness/dependency tests**

Require 21 entries: auth; contact; VC search/detail; Note normal/unified detail and unified transcript; Minutes search plus basic/summary/todo/chapter/transcript; Drive; Docs fetch/create/append/patch; Wiki space/list/get. Prove IDs flow only from successful parents, chains fail independently, and Meeting/Minute discovery expands at most 12 months.

- [ ] **Step 2: Write RED state and cleanup tests**

No sample becomes `unavailable`; unknown fields become `needs_review`; transcript files are bounded and always removed. Writes require explicit flags; missing/unsafe state never creates a page.

- [ ] **Step 3: Write RED fixed-document tests**

Require fetch → append candidate → fetch → patch exact two-line block → fetch. Start with `Current marker: nonce-old`; end only with `Current marker: nonce-new`. Reject wrong title, extra body, duplicate/malformed marker, stale revision, and any unrelated mutation.

- [ ] **Step 4: Implement injected audit boundaries**

```ts
export type RawLarkExecutor = {
  version(): Promise<string>;
  run(command: LarkCommand, signal?: AbortSignal): Promise<unknown>;
};
export type ContractAuditDependencies = {
  executor: RawLarkExecutor;
  now(): Date;
  nonce(): string;
  readAuditDocumentToken(): Promise<string | undefined>;
  bindAuditDocumentToken(token: string): Promise<void>;
};
```

Sanitize before staging and always emit one content-free report.

- [ ] **Step 5: Implement host launcher contract**

Require immutable digest, matching OCI revision, `amd64`, `10001:10001`, and trusted `/opt/minori/lark` plus `/opt/minori/contract-audit`. Pass only HOME/config/data/bin variables and the Lark mount. Never use `--env-file`; supply the audit token via protected stdin/file, not argv/env.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run test/scripts/lark-contract-audit.test.ts test/scripts/release-contract.test.ts
bash -n deploy/vultr/lark-contract-audit.sh
npm run typecheck:scripts
git add scripts/lark-contract-audit.ts deploy/vultr/lark-contract-audit.sh test/scripts/lark-contract-audit.test.ts test/scripts/release-contract.test.ts
git commit -m "feat: audit live lark cli contracts"
```

### Task 4: Capture literal fixtures and fix Smart Note parsing

**Files:**
- Create: `test/fixtures/lark/cli-1.0.84/manifest.json`
- Create: verified `*.envelope.json` and business `*.data.json` files.
- Modify: `test/lark/runner.test.ts`
- Modify: `test/lark/knowledge-service.contract.test.ts`
- Modify: `test/lark/meeting-service.contract.test.ts`
- Modify: `src/lark/meeting-service.ts`
- Delete: old flat fixtures after all consumers migrate.

**Interfaces:**
- Consumes Tasks 1–3.
- Preserves `LarkExecutor` and public service APIs.
- Changes Note detail parsing to `{ note: NoteDetail }`.

- [ ] **Step 1: Obtain explicit authorization and capture reads**

Use the exact trusted image digest. Run without write flags. Require accessible cases `verified`, missing samples `unavailable`, no `needs_review`, and no raw output outside the protected directory.

- [ ] **Step 2: Classify fields without copying values**

Review field names/paths only; rerun affected cases until classifications are empty. Never paste raw values into chat, code, manifest, or Git.

- [ ] **Step 3: Run the separately authorized write audit**

If state is absent, use bootstrap plus write flags once; otherwise use only the write flag. Verify constant-size final marker and no duplicate page.

- [ ] **Step 4: Atomically install and review fixtures**

Verify digests/version/residue, install into the worktree, and inspect `git diff`. Verified business Data must equal Envelope `data`; unavailable cases must have no invented file.

- [ ] **Step 5: Migrate tests**

Use `loadFixtureEnvelope('auth.status.default')` and `loadFixtureData('note.detail.normal')`. Runner consumes envelopes; service tests consume data. Remove old fixtures only after `rg 'test/fixtures/lark/' test` shows no flat consumer.

- [ ] **Step 6: Capture RED and fix the Note wrapper**

RED: live normal/unified fixtures fail the old top-level schema. Implement:

```ts
const noteDetailSchema = z.object({
  note: z.object({
    note_display_type: z.enum(['normal', 'unified', 'unknown']),
    note_doc_token: z.string().optional(),
    verbatim_doc_token: z.string().optional(),
  }).passthrough(),
}).passthrough();
```

Return `parseEnvelope(noteDetailSchema, data).note`. Do not add top-level compatibility without a live case.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run test/scripts/lark-contract-manifest.test.ts test/lark/runner.test.ts test/lark/knowledge-service.contract.test.ts test/lark/meeting-service.contract.test.ts
npm run typecheck
npm run typecheck:scripts
git add src/lark/meeting-service.ts test/helpers/lark-contract-fixture.ts test/fixtures/lark test/lark/runner.test.ts test/lark/knowledge-service.contract.test.ts test/lark/meeting-service.contract.test.ts
git commit -m "fix: bind lark parsers to live contracts"
```

### Task 5: Documentation, verification, review, and release

**Files:**
- Modify: `README.md`
- Modify: `test/scripts/release-contract.test.ts`
- Modify: `docs/superpowers/specs/2026-08-12-lark-cli-contract-audit-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.superpowers/sdd/2026-08-12-lark-cli-contract-audit/task-5-report.md` (gitignored).

**Interfaces:**
- Produces operator runbook, patch release `0.3.2`, protected PR, immutable image, and production acceptance.
- Preserves Production Approval and Deployment Protocol v1.

- [ ] **Step 1: Write RED runbook/release tests**

Assert exact-image execution, no env file, fixture modes, Structural Cases, audit states, atomic worktree update/manual diff, fixed-document bootstrap/rotation, and two-stage CLI upgrade. Assert lockfile/manifest versions match.

- [ ] **Step 2: Update docs and version**

Run `npm version 0.3.2 --no-git-tag-version`; do not change Lark CLI 1.0.84. Mark the design implemented only after the content-free live report is reviewed.

- [ ] **Step 3: Run all gates**

```bash
npm run verify
npm run test:integration
bash -n deploy/vultr/lark-contract-audit.sh
git diff --check
docker buildx build --platform linux/amd64 --load -t minori:lark-contract-audit .
docker inspect minori:lark-contract-audit --format '{{.Architecture}} {{.Config.User}}'
```

Expected: all green and `amd64 10001:10001`.

- [ ] **Step 4: Perform two-axis review**

Use `code-review` against the design fixed point. Require zero Critical/Important Standards and Spec findings; rerun affected tests and full verify after fixes.

- [ ] **Step 5: Commit candidate**

```bash
git add README.md package.json package-lock.json test/scripts/release-contract.test.ts docs/superpowers/specs/2026-08-12-lark-cli-contract-audit-design.md
git commit -m "docs: prepare v0.3.2 lark contract release"
```

- [ ] **Step 6: Protected PR, tag, and deployment**

Push/open PR; require `CI / verify`, `CI / integration`, `CI / image-amd64`; merge cleanly. After separate user authorization, create annotated `v0.3.2`, verify immutable GHCR metadata, and obtain separate Production Approval.

- [ ] **Step 7: Production acceptance**

Verify readiness 200, all categories `ok`, health, restart 0, exact digest/revision, persisted OAuth, and clean worktree. Ask a recent Meeting question whose selected record has a Smart Meeting Note; confirm an AI-summary source rather than `meeting_content_unavailable`. Persist only allowed IDs/timestamps/status categories.

---

## Plan self-review

- Spec coverage: command cases, fixture modes, privacy, bounded discovery, transcript cleanup, fixed document, image trust, version equality, atomic install, Note fix, CI, review, and release all map to tasks.
- Placeholder scan: no deferred implementation or generic error-handling step remains.
- Type consistency: fixture modes, states, manifest fields, loader names, audit dependencies, and report fields match across tasks.
- Scope: one contract-evidence subsystem plus the parser fix it proves; no production command-architecture refactor.
