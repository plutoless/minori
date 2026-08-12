# Lark CLI Contract Audit Design

**Status:** Approved design

## Problem

Minori currently defines Lark CLI response schemas inside its knowledge and meeting services. Several fixtures were shaped from those expectations instead of being derived from literal CLI responses. A mistaken expectation and its matching hand-written fixture can therefore pass together.

The production `note +detail` failure demonstrates the gap. After the runner removes the common `{ ok, data }` envelope, the CLI returns `{ note: { ... } }`, while `MeetingService` expects the note fields at the top level. Meeting discovery and `vc +detail` succeed, but every Smart Meeting Note fetch ends as `meeting_content_unavailable`. The dedicated user can in fact read the Note details and AI-summary documents.

Minori needs one complete audit of every Lark CLI command it uses, based on sanitized literal output, followed by a durable contract boundary that prevents business services and fixtures from independently guessing response shapes.

## Goals

1. Validate every command variant in the current `LarkCommand` catalog against Lark CLI 1.0.84.
2. Bind each command to one centralized post-runner response decoder and stable DTO.
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

### Command Contract Registry

A centralized Command Contract Registry owns the response contract for every `LarkCommand` variant. Each entry binds:

- the command ID and variant;
- the schema for the literal post-runner value;
- a decoder that returns a stable, typed DTO;
- a stable contract-error category;
- the matching sanitized fixture and audit-manifest entry.

Knowledge and meeting services consume the stable DTOs. They no longer define or duplicate schemas for raw CLI responses. Business policy stays in the services: the registry does not decide Smart Note versus Minute priority, pagination, write behavior, or source selection.

The intended flow is:

```text
CLI JSON
  -> LarkRunner validates and removes { ok, data }
  -> command-specific contract decodes the remaining value
  -> service receives a stable DTO
```

Contracts accept explicitly optional provider fields but require the actual structural wrappers. For example, `note.detail` accepts optional Note tokens inside `{ note: { ... } }`; it does not accept the same fields at the top level. Structural failure reports `note_detail_contract_error`, not the later and less precise `meeting_content_unavailable`.

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

Adding a future catalog command or variant requires a registry entry, fixture, decoder test, and audit-manifest classification.

## Fixture capture and privacy

The initial audit runs on Vultr using the exact production image and locked Lark CLI 1.0.84. It captures complete CLI output into a newly created mode-`0700` temporary directory. Raw output never leaves that directory.

Before an artifact can leave the server, a sanitizer replaces or removes:

- names and text bodies;
- Open IDs and all provider-owned IDs or tokens;
- URLs;
- OAuth and application material;
- meeting titles, participant information, document titles, and transcript content.

The sanitizer preserves envelope shape, nested field names, JSON types, optional-field presence, empty values, collection shape, and deterministic representative values. It fails closed when an unrecognized string-bearing field is present. A residue scan runs before transfer and again before commit.

Sanitized fixtures are versioned by CLI version:

```text
test/fixtures/lark/cli-1.0.84/
  auth-status.json
  contact-search-user.json
  vc-search.json
  vc-detail.json
  note-detail.json
  note-transcript.json
  minutes-search.json
  minutes-detail-summary.json
  ...
```

The repository also stores a content-free manifest containing the CLI version, capture time, command variant, fixture path, decoder name, and one of the audit states below. It contains no query, target ID, result ID, title, URL, or body.

## Live audit states

Every command variant receives exactly one state:

- `verified`: the live command succeeded and its post-runner value passed its decoder;
- `unavailable`: the Dedicated Knowledge User currently has no suitable sample, so the contract was not claimed as live-verified;
- `failed`: execution, permission, cleanup, or decoding failed, with a stable stage/category.

Independent chains continue after an `unavailable` or `failed` result. Dependent operations fail closed: a failed `vc.detail` does not allow the audit to invent a Note ID, while an unavailable Minute sample does not prevent Docs or Wiki validation.

## Live audit data flow

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

On the first audit, an explicit bootstrap invocation of `docs.create` creates this document with its audit-owned marker section. The audit then atomically stores its token in `/var/lib/minori/lark/contract-audit.json`, mode `0600`, owned by the runtime user and inside the existing operator-protected Lark store. The value is not printed, committed, placed in an environment variable or GitHub variable, or stored in Neon. Later audits require and reuse that token rather than creating another page. A missing or unsafe state file fails closed unless the operator explicitly selects bootstrap mode.

Each audit performs:

1. fetch the current document and revision;
2. append a deterministic marker containing a non-sensitive audit nonce;
3. fetch and verify the new revision and marker;
4. patch that same marker to its final form;
5. fetch and verify the final revision and replacement.

The audit refuses to write if the configured document cannot be fetched, has the wrong title, or does not contain the audit-owned marker section. It never modifies another document, changes sharing, moves, renames, trashes, or deletes content.

## Test strategy

### Runner envelope tests

Full sanitized envelopes drive the real runner parsing seam and prove correct handling of success, provider error, malformed JSON, invalid envelope, timeout, cancellation, and output bounds.

### Decoder contract tests

Every registry entry decodes its matching post-runner fixture. Mutation tests remove or move required wrappers and fields so fixture and decoder cannot silently drift together. The production Smart Note regression starts red with `{ note: { ... } }` against the old decoder and passes only when the real wrapper is supported.

### Service behavior tests

Knowledge and meeting services are tested against stable DTOs rather than hand-shaped CLI structures. These tests continue to cover search normalization, pagination, Smart Note and Minute fallback, transient downloads, typed writes, conflict handling, and abort behavior.

### Live audit

The live audit runs inside the exact release image with the production Lark Credential Store mounted. It emits one sanitized summary and the versioned fixtures/manifest, never raw responses. It verifies temporary cleanup and scans the sanitized output for forbidden content classes before permitting export.

### Release gates

- Local contract and service tests run in every CI verification gate.
- The full live audit runs when fixtures are first established, when the Lark CLI version changes, or when a Lark command/decoder is added or changed.
- Ordinary releases retain the existing lightweight auth/readiness verification and do not perform the live write audit.

## Error handling and observability

The registry emits stage-specific categories such as `note_detail_contract_error`. Services may translate known content absence into business outcomes, but structural, permission, cancellation, and provider failures remain distinguishable internally.

Agent-facing and member-facing output remains bounded and does not expose provider envelopes. Existing Agent Failure Detail retention and content-free tool audit rules continue to apply. The live contract audit records only command variant, state, stable category, counts, CLI version, and timestamp.

## Completion criteria

The work is complete when:

1. every current command variant has one registry decoder and one versioned fixture;
2. all commands with real samples are `verified`, and missing samples are explicitly `unavailable`;
3. the fixed audit document completes the create/fetch/append/patch/fetch lifecycle without creating duplicate pages;
4. the literal `{ note: { ... } }` response loads a readable Smart Note AI-summary document;
5. no raw response, name, body, provider identifier, URL, credential, or OAuth value appears in exported audit artifacts or Git;
6. focused contract tests, the full verification suite, PostgreSQL integration tests, and the linux/amd64 image build pass;
7. a real content-free audit report is reviewed before merge;
8. the change is merged through the protected PR flow and released only after a separate Production Approval.
