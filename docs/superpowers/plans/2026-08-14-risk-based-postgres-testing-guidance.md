# Risk-Based PostgreSQL Testing Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concise root guidance that prefers fast local mocks and fixtures while preserving real-dependency verification in required pull-request CI.

**Architecture:** Create one repository-root `AGENTS.md` section governing coding-agent verification behavior. This documentation-only change does not modify application code, database behavior, or CI configuration.

**Tech Stack:** Markdown, Git

## Global Constraints

- Keep root `AGENTS.md` concise.
- Do not imply that real dependencies run locally only after CI fails.
- Do not change runtime code, database schema, migrations, or CI workflows.

---

### Task 1: Add the risk-based PostgreSQL verification rule

**Files:**
- Create: `AGENTS.md`
- Reference: `docs/superpowers/specs/2026-08-14-risk-based-postgres-testing-guidance-design.md`

**Interfaces:**
- Consumes: the approved three-boundary testing rule from the design spec
- Produces: repository-root instructions automatically visible to coding agents

- [ ] **Step 1: Create the root guidance**

Create `AGENTS.md` with exactly this focused guidance:

```markdown
# Repository Agent Guidance

## Verification

- Prefer fast local tests with mocks and sanitized fixtures.
- Leave real PostgreSQL, container, external-service, and production-data verification to required GitHub CI by default.
- Run those dependencies locally only when their boundary changes or when reproducing and fixing a related CI failure.
- Pull-request CI must always run the PostgreSQL integration suite as a required merge check.
```

- [ ] **Step 2: Verify the documented boundary**

Run:

```bash
rg -n "mocks and sanitized fixtures|real PostgreSQL|only when their boundary changes|must always run" AGENTS.md
git diff --check
```

Expected: all four rules are present and `git diff --check` reports no errors.

- [ ] **Step 3: Confirm the change is documentation-only**

Run:

```bash
git status --short
git diff --stat
```

Expected: only `AGENTS.md` is modified by implementation; no application, test, database, migration, or workflow file changes.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: define risk-based postgres verification"
```
