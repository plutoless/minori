# Lark CLI Contract Audit Design

**Status:** Approved design

## Problem

Minori currently defines Lark CLI response schemas inside its knowledge and meeting services. Several fixtures were shaped from those expectations instead of being derived from literal CLI responses. A mistaken expectation and its matching hand-written fixture can therefore pass together.

The production `note +detail` failure demonstrates the gap. After the runner removes the common `{ ok, data }` envelope, the CLI returns `{ note: { ... } }`, while `MeetingService` expects the note fields at the top level. Meeting discovery and `vc +detail` succeed, but every Smart Meeting Note fetch ends as `meeting_content_unavailable`. The dedicated user can in fact read the Note details and AI-summary documents.

Minori needs one complete audit of every Lark CLI command it uses, based on sanitized literal output, followed by a durable contract boundary that prevents business services and fixtures from independently guessing response shapes.

## Goals

1. Validate every command variant in the current `LarkCommand` catalog against Lark CLI 1.0.84.
2. Prove the existing runner and owning service parser against mechanically linked fixtures from the same live response.
3. Capture sanitized literal fixtures from live CLI output without retaining business content or credentials.
4. Verify live read, temporary-download, and typed document-write paths.
5. Make the exact failing stage visible internally without exposing provider data to members.
6. Reuse one permanent audit document for all live create, fetch, append, and patch checks.

## Non-goals

- Generating contracts from Feishu OpenAPI definitions. Lark CLI shortcut commands have their own projections and remain the authoritative boundary.
- Persisting raw CLI responses, retrieved documents, transcripts, meeting titles, people, identifiers, URLs, or OAuth material.
- Running the full live audit on every ordinary application release.
- Moving meeting-content selection policy into the contract layer.
- Adding new Lark capabilities or changing the Dedicated Knowledge User permission model.

## Architecture

### Common runner boundary

`LarkRunner` continues to own process execution, cancellation, timeout and output limits, JSON parsing, the common `{ ok, data }` envelope, and stable CLI failures. Except for `auth.status`, a successful runner invocation returns only the envelope's `data` value.

Runner tests use full sanitized CLI envelopes so they prove that the common envelope is removed exactly once.

### Existing service contract boundary

`command-catalog.ts`, `LarkRunner`, and their public interfaces remain unchanged. The owning Knowledge or Meeting service continues to define and apply the schema for the post-runner value. This work does not introduce a dynamic registry, move every schema into a new abstraction, or create a second DTO layer.

Reliability comes from making the runner test and the owning service contract test consume mechanically linked fixtures from the same live capture. A content-free manifest provides the one centralized inventory: it maps every business command variant and its small set of known structural cases to Envelope Fixtures, Data Fixtures, the owning service test, owning operation's stable contract-error category, and live-audit state. `auth.status` is the sole `envelope_only` exception because it has neither a common `data` payload nor an owning business-service parser. A completeness test fails when a catalog variant or declared structural case lacks the entries required by its fixture mode.

The intended flow is:

```text
CLI JSON
  -> LarkRunner validates and removes { ok, data }
  -> existing owning service parses the paired Data Fixture shape
  -> service returns its existing domain result
```

Service schemas accept explicitly optional provider fields but require the actual structural wrappers. For example, `note.detail` accepts optional Note tokens inside `{ note: { ... } }`; it does not accept the same fields at the top level. Structural failure reports `note_detail_contract_error`, not the later and less precise `meeting_content_unavailable`.

## Command inventory

The audit covers every current catalog variant:

- `auth.status`
- `contact.searchUser`
- `vc.search`
- `vc.detail`
- `note.detail`
- `note.transcript`
- `minutes.search`
- `minutes.detail` basic, summary, todo, chapter, and transcript variants
- `drive.search`
- `docs.fetch`
- `docs.create`
- `docs.append`
- `docs.patch`
- `wiki.spaceList`
- `wiki.nodeList`
- `wiki.nodeGet`

Adding a future catalog command or variant requires a manifest entry, the fixtures and contract test required by its declared fixture mode, and an audit classification. A command may declare a few named cases when live evidence shows materially different response wrappers, such as `note-detail.normal` and `note-detail.unified`; the audit does not generate permutations for optional fields. New `envelope_only` exceptions require an explicit design change; they are not inferred merely because a decoder is inconvenient.

## Fixture capture and privacy

The initial audit runs on Vultr using the exact production image and locked Lark CLI 1.0.84. It captures complete CLI output into a newly created mode-`0700` temporary directory. Raw output never leaves that directory.

Before an artifact can leave the server, a sanitizer replaces or removes:

- names and text bodies;
- Open IDs and all provider-owned IDs or tokens;
- URLs;
- OAuth and application material;
- meeting titles, participant information, document titles, and transcript content.

The sanitizer preserves envelope shape, nested field names, JSON types, optional-field presence, empty values, collection shape, and deterministic representative values. Only explicitly safe structural enums retain literal strings. Known identifier, URL, and body fields receive typed placeholders; every other string defaults to `<redacted-string>`, so an unfamiliar field can never reach the repository with its raw value. The manifest lists every such unclassified string-field path and the command remains `needs_review` until a person classifies them. A residue scan runs before generated files replace existing fixtures and again before commit.

Each command case is invoked once and produces one sanitized Envelope Fixture containing the complete CLI JSON. For every business-command case, the corresponding Data Fixture is then mechanically extracted from `envelope.data`; it is never separately captured or hand-edited. The manifest records both SHA-256 digests, and repository validation requires the Data Fixture to equal the Envelope Fixture's `data` value exactly. `auth.status` declares `fixtureMode: envelope_only`, stores only the Envelope Fixture and its digest, and is verified at the Runner identity/availability seam without an invented Data Fixture or owning service test.

Sanitized fixture pairs are versioned by CLI version:

```text
test/fixtures/lark/cli-1.0.84/
  auth-status.envelope.json
  contact-search-user.envelope.json
  contact-search-user.data.json
  vc-search.envelope.json
  vc-search.data.json
  vc-detail.envelope.json
  vc-detail.data.json
  note-detail.envelope.json
  note-detail.data.json
  ...
  ...
```

The repository also stores a content-free manifest containing the CLI version, capture time, command variant, fixture mode, the applicable fixture paths and digests, the applicable owning service test, stable contract-error category, and one of the audit states below. It contains no query, target ID, result ID, title, URL, or body.

Version consistency is fail-closed at the contract and audit boundaries. Ordinary CI compares the Lark CLI version actually resolved in `package-lock.json` with the manifest version and versioned fixture directory; a mismatch reports that Contract Audit evidence must be refreshed. At live-audit startup, the launcher also reads the CLI's actual version from the explicitly selected exact image digest and requires the same value before any command capture. This version check is not part of production application startup or message processing.

## Live audit states

Every command variant, or each of its declared structural cases, receives exactly one state:

- `verified`: the live command succeeded and its post-runner value passed its decoder;
- `needs_review`: live capture and safe default redaction succeeded, but one or more new string-field paths lack an approved semantic classification;
- `unavailable`: the Dedicated Knowledge User currently has no suitable sample, so the contract was not claimed as live-verified;
- `not_exercised_by_policy`: the side effect was deliberately omitted to preserve the one-document audit boundary, so this CLI version is not claimed as live-verified for that command;
- `failed`: execution, permission, cleanup, or decoding failed, with a stable stage/category.

Independent chains continue after a `needs_review`, `unavailable`, `not_exercised_by_policy`, or `failed` result. Dependent operations may use identifiers only inside the protected live audit process after successful command execution; `needs_review` permits safe dependent probing but not fixture verification. A failed `vc.detail` does not allow the audit to invent a Note ID, while an unavailable Minute sample does not prevent Docs or Wiki validation.

Before classifying a sample-dependent command as `unavailable`, the audit performs a bounded discovery search. Meeting and Minute discovery may widen its window up to 12 months, stopping as soon as one accessible sample supports the dependency chain. This search does not fetch content merely to rank samples. Other collections follow their normal bounded pagination and stop at the first suitable item.

An `unavailable` case does not block an unrelated contract fix, but it remains visibly unverified in the final report. A command is fully `verified` only when all known structural cases for which suitable samples exist are verified; missing cases remain separately visible as `unavailable`. Every command whose invocation or parser changes in the release must verify every affected known structural case; the release fails closed if an affected case is `needs_review`, `unavailable`, or `failed`. This release therefore requires live verification of the affected `note.detail` structural cases and the Smart Note AI-summary document chain.

## Live audit data flow

The repository retains a narrow operator tool at `scripts/lark-contract-audit.ts`. It owns dependency sequencing, safe capture, sanitization, fixture-pair and manifest generation, and audit-state classification. A host-side launcher owns filesystem trust checks, reads Contract Audit State, mounts the existing Lark Credential Store and a new temporary directory, and invokes the exact release image.

For the initial fixture capture, the command executor is the currently trusted, deployed exact `v0.3.1` image rather than an unmerged candidate application image. The new launcher and sanitizer are reviewed and tested as standalone host-side orchestration: they may start that exact image, retain raw output only in a root-owned temporary directory, sanitize it, and return only generated fixture artifacts. The audit container receives the Lark Credential Store plus explicit non-secret path settings required by the CLI (`HOME`, configuration directory, data directory, and CLI binary path); it never receives or mounts `/opt/minori/minori.env`.

The launcher and the resulting sanitized fixtures enter the same pull request only after that capture. Future audits use an explicitly selected, already merged exact image digest whose CLI version matches the capture target. Floating tags and unmerged application images are never allowed to receive the production Lark Credential Store. A CLI upgrade may therefore require two controlled steps: first merge the minimal dependency/image change, then run the audit against that merged exact digest before merging decoder or fixture changes that depend on the new contract.

After all classifications and residue checks pass, the local audit command writes the sanitized fixtures and manifest directly into the current Git worktree. Generation is atomic: a failed run, `needs_review` result, or residue finding leaves the existing tracked fixtures unchanged. The operator reviews `git diff` before committing. The audit command never commits, pushes, opens a pull request, or otherwise changes Git history.

The tool is never invoked by application startup, the production service, ordinary CI, or the normal release workflow. It is manually started by an operator and defaults to read-only. `--include-write-audit` is required for append/patch verification. The first document creation additionally requires `--bootstrap-audit-document`; absence of Contract Audit State never enables bootstrap implicitly.

The audit discovers dependent identifiers only from earlier successful commands:

```text
contact search

vc search
  -> vc detail
    -> note detail
      -> note summary document fetch
      -> note transcript temporary download

minutes search
  -> minutes detail: basic / summary / todo / chapter
  -> minutes transcript temporary download

wiki space list
  -> node list
    -> node get

drive search
  -> docs fetch

fixed audit document
  -> fetch
  -> append
  -> fetch
  -> patch
  -> fetch
```

Note and Minute transcript checks validate only that the command succeeds, returns a safe file reference, creates a non-empty file inside the audit directory, stays within the byte budget, and cleans the directory. Transcript bodies are never fixture data.

## Fixed write-audit document

The live write contract uses one Feishu document named `Minori Lark CLI Contract Audit`.

On the first audit, an explicit bootstrap invocation of `docs.create` creates this document with its audit-owned marker section. The host-side audit launcher then atomically stores its token in `/opt/minori/contract-audit/state.json`, inside a root-owned mode-`0700` directory with a mode-`0600` state file. This Contract Audit State is recoverable operational metadata, not part of the Lark Credential Store. The value is not printed, committed, placed in an environment variable or GitHub variable, or stored in Neon.

Only the host-side live-audit launcher reads Contract Audit State and supplies the token as a single-run input to the audit container. The production Minori service neither mounts nor reads it. Later audits require and reuse the binding rather than creating another page. A missing or unsafe state file fails closed: the operator must explicitly bind the existing audit document or select bootstrap mode. The audit never auto-creates a replacement.

The initial CLI 1.0.84 bootstrap live-verifies `docs.create`. Later CLI versions classify `docs.create` as `not_exercised_by_policy` and continue to verify fetch, append, and patch against the bound document. If the `docs.create` invocation or parser changes, the operator must explicitly rotate the audit document: bootstrap the replacement, atomically switch Contract Audit State, and manually archive the old document. Normal CLI upgrades do not create pages.

Each audit performs:

1. fetch the current document and revision, requiring exactly one audit-owned state block and no other body content;
2. append `Candidate marker: <new nonce>` immediately after the existing `Current marker` line;
3. fetch and verify the new revision and both marker lines;
4. patch the complete two-line state block into the single line `Current marker: <new nonce>`;
5. fetch and verify the final revision, the new current marker, and absence of the previous nonce and candidate line.

The audit refuses to write if the configured document cannot be fetched, has the wrong title, contains additional body content, has a missing or duplicate state block, or does not match the canonical marker grammar. The document therefore remains constant-size across audits. The tool never modifies another document, changes sharing, moves, renames, trashes, or deletes content.

## Test strategy

### Runner envelope tests

Envelope Fixtures drive the real runner parsing seam and prove correct handling of success, provider error, malformed JSON, invalid envelope, timeout, cancellation, and output bounds. Each successful runner result must equal the paired Data Fixture.

### Service contract tests

Every existing owning service parser consumes its matching Data Fixture. A fixture-integrity test proves that it is exactly the `data` field of the paired Envelope Fixture and that both digests match the manifest. `auth.status` is instead tested only at the Runner seam against its Envelope Fixture. Mutation tests remove or move required wrappers and fields so fixture and parser cannot silently drift together. The production Smart Note regression starts red with `{ note: { ... } }` against the old parser and passes only when the real wrapper is supported.

### Business behavior tests

Separate business behavior tests continue to cover search normalization, pagination, Smart Note and Minute fallback, transient downloads, typed writes, conflict handling, and abort behavior. They need not duplicate complete CLI response fixtures.

### Live audit

The live audit runs inside an explicitly selected, already trusted exact image digest with the production Lark Credential Store mounted. It does not receive the production environment file. It emits one sanitized summary and the versioned fixtures/manifest, never raw responses. It verifies temporary cleanup and scans generated files for forbidden content classes before atomically replacing worktree fixtures.

### Release gates

- Local contract and service tests run in every CI verification gate, including exact equality among the lockfile-resolved CLI version, manifest version, and fixture-directory version.
- The full live audit runs when fixtures are first established, when the Lark CLI version changes, or when a Lark command/decoder is added or changed.
- Ordinary releases retain the existing lightweight auth/readiness verification and do not perform the live write audit.

## Error handling and observability

Agent-facing and member-facing behavior retains a small set of stable operation-level categories, such as meeting-contract and knowledge-contract failure. This audit does not add one public category or database column per CLI command. Internal content-free diagnostics locate a failure with the tuple `commandVariant`, optional `structuralCase`, and `stage`, such as `note.detail / unified / decode`. Services may translate known content absence into business outcomes, but structural, permission, cancellation, and provider failures remain distinguishable internally.

Agent-facing and member-facing output remains bounded and does not expose provider envelopes. Existing Agent Failure Detail retention and content-free tool audit rules continue to apply. The live contract audit records only command variant, optional structural case, stage, state, stable operation category, counts, CLI version, and timestamp.

## Completion criteria

The work is complete when:

1. every current command variant and declared structural case has a manifest entry and satisfies its fixture mode: `auth.status` has one versioned Envelope Fixture and Runner contract test, while every business-command case has paired versioned fixtures and an owning service contract test;
2. bounded discovery has been attempted for sample-dependent cases, all exercised cases with real samples are `verified`, no case remains `needs_review`, missing samples are explicitly `unavailable`, and deliberate create omissions are explicitly `not_exercised_by_policy`;
3. the fixed audit document completes the create/fetch/append/patch/fetch lifecycle without creating duplicate pages;
4. the literal `{ note: { ... } }` response loads a readable Smart Note AI-summary document;
5. no raw response, name, body, provider identifier, URL, credential, or OAuth value appears in generated audit artifacts or Git;
6. focused contract tests, the full verification suite, PostgreSQL integration tests, and the linux/amd64 image build pass;
7. a real content-free audit report is reviewed before merge;
8. the change is merged through the protected PR flow and released only after a separate Production Approval.
