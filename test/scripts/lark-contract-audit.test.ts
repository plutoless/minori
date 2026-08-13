import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import {
  applyFixedDocumentAudit,
  bootstrapFixedDocument,
  LARK_CONTRACT_CASE_IDS,
  runContractAudit,
  runFixedDocumentAudit,
} from '../../scripts/lark-contract-audit.js';
import { verifyFixtureSet } from '../../scripts/lark-contract-manifest.js';
import { validateTranscriptArtifact } from '../../scripts/lark-contract-sanitizer.js';

async function runOperator(args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`operator_exit_${code}:${Buffer.concat(stderr)}`));
      else resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}

describe('Lark Contract Audit', () => {
  it('enumerates every current command structural case', () => {
    expect(LARK_CONTRACT_CASE_IDS).toEqual([
      'auth.status.default', 'contact.searchUser.default',
      'vc.search.default', 'vc.detail.default',
      'note.detail.normal', 'note.detail.unified', 'note.transcript.unified',
      'minutes.search.default', 'minutes.detail.basic', 'minutes.detail.summary',
      'minutes.detail.todo', 'minutes.detail.chapter', 'minutes.detail.transcript',
      'drive.search.default', 'docs.fetch.default', 'docs.create.bootstrap',
      'docs.append.default', 'docs.patch.default',
      'wiki.spaceList.default', 'wiki.nodeList.default', 'wiki.nodeGet.default',
    ]);
  });

  it('rejects an unexpected CLI version before executing any command', async () => {
    const run = vi.fn();
    await expect(runContractAudit({
      executor: { version: async () => '1.0.85', run },
    }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
      expectedCliVersion: '1.0.84',
    })).rejects.toThrow('lark_contract_version_mismatch');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the fixed audit document constant-size across append and patch', async () => {
    const responses = [
      { document: { document_id: 'audit_doc', revision_id: 7, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-old' } },
      { document: { document_id: 'audit_doc', revision_id: 8 } },
      { document: { document_id: 'audit_doc', revision_id: 8, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-old\nCandidate marker: nonce-new' } },
      { document: { document_id: 'audit_doc', revision_id: 9 } },
      { document: { document_id: 'audit_doc', revision_id: 9, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-new' } },
    ];
    const run = vi.fn(async (_command: LarkCommand) => responses.shift());

    await expect(runFixedDocumentAudit({ run }, {
      documentToken: 'audit_doc', nonce: 'nonce-new',
    })).resolves.toEqual({ finalRevisionId: 9 });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'audit_doc' },
      { id: 'docs.append', doc: 'audit_doc', content: '\nCandidate marker: nonce-new', revisionId: 7 },
      { id: 'docs.fetch', doc: 'audit_doc' },
      { id: 'docs.patch', doc: 'audit_doc', pattern: 'Current marker: nonce-old\nCandidate marker: nonce-new', content: 'Current marker: nonce-new', revisionId: 8 },
      { id: 'docs.fetch', doc: 'audit_doc' },
    ]);
  });

  it('bootstraps the one audit document only through the typed create command', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      data: { document: { document_id: 'audit_doc', revision_id: 1 } },
    }));
    await expect(bootstrapFixedDocument({ run }, 'nonce-new')).resolves.toMatchObject({
      documentToken: 'audit_doc',
      initialRevisionId: 1,
    });
    expect(run).toHaveBeenCalledWith({
      id: 'docs.create',
      title: 'Minori Lark CLI Contract Audit',
      content: 'Current marker: bootstrap_nonce-new',
    });
  });

  it('marks fixed-document fetch/append/patch verified from their sanitized responses', async () => {
    const responses = [
      { ok: true, data: { document: { document_id: 'audit_doc', revision_id: 7, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-old' } } },
      { ok: true, data: { document: { document_id: 'audit_doc', revision_id: 8 } } },
      { ok: true, data: { document: { document_id: 'audit_doc', revision_id: 8, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-old\nCandidate marker: nonce-new' } } },
      { ok: true, data: { document: { document_id: 'audit_doc', revision_id: 9 } } },
      { ok: true, data: { document: { document_id: 'audit_doc', revision_id: 9, title: 'Minori Lark CLI Contract Audit', content: 'Current marker: nonce-new' } } },
    ];
    const run = vi.fn(async () => responses.shift());
    const report = await runContractAudit({ executor: { version: async () => '1.0.84', run: vi.fn(async () => { throw new Error('unavailable'); }) } }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
    });

    await applyFixedDocumentAudit(report, { run }, 'audit_doc', 'nonce-new');

    for (const caseId of ['docs.fetch.default', 'docs.append.default', 'docs.patch.default'] as const) {
      expect(report.cases.find((entry) => entry.caseId === caseId)?.state).toBe('verified');
      expect(report.sanitizedCaptures[caseId]).toBeDefined();
    }
    expect(JSON.stringify(report)).not.toContain('nonce-old');
    expect(JSON.stringify(report)).not.toContain('nonce-new');
  });

  it.each([
    { title: 'Wrong', content: 'Current marker: nonce-old' },
    { title: 'Minori Lark CLI Contract Audit', content: 'extra\nCurrent marker: nonce-old' },
    { title: 'Minori Lark CLI Contract Audit', content: 'Current marker: one\nCurrent marker: two' },
  ])('refuses an unsafe fixed audit document: $content', async ({ title, content }) => {
    const run = vi.fn(async () => ({
      document: { document_id: 'audit_doc', revision_id: 7, title, content },
    }));
    await expect(runFixedDocumentAudit({ run }, {
      documentToken: 'audit_doc', nonce: 'nonce-new',
    })).rejects.toThrow('lark_contract_audit_document_unsafe');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('widens Meeting discovery to twelve months and stops at the first sample', async () => {
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'auth.status') return { identity: 'user' };
      if (command.id === 'vc.search') {
        const attempts = run.mock.calls.filter(([value]) => value.id === 'vc.search').length;
        return { ok: true, data: { items: attempts < 3 ? [] : [{ id: 'meeting_1' }] } };
      }
      if (command.id === 'vc.detail') {
        return { ok: true, data: { meetings: [{ meeting_id: 'meeting_1' }] } };
      }
      throw new Error('sample_unavailable');
    });

    const report = await runContractAudit({ executor: { version: async () => '1.0.84', run } }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
    });

    const meetingSearches = run.mock.calls.map(([command]) => command)
      .filter((command): command is Extract<LarkCommand, { id: 'vc.search' }> => command.id === 'vc.search');
    expect(meetingSearches).toHaveLength(3);
    expect(meetingSearches.map((command) => command.start)).toEqual([
      '2026-05-14T12:00:00.000Z',
      '2026-02-13T12:00:00.000Z',
      '2025-08-12T12:00:00.000Z',
    ]);
    expect(report.cases.find((entry) => entry.caseId === 'vc.search.default')?.state)
      .toBe('verified');
    expect(report.cases.find((entry) => entry.caseId === 'note.detail.normal')?.state)
      .toBe('unavailable');
    expect(report.cases.find((entry) => entry.caseId === 'docs.append.default')?.state)
      .toBe('not_exercised_by_policy');
  });

  it('continues independent Wiki discovery after a Meeting failure', async () => {
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'auth.status') return { identity: 'user' };
      if (command.id === 'vc.search') throw new Error('vc_failed');
      if (command.id === 'wiki.spaceList') {
        return { ok: true, data: { spaces: [{ space_id: 'space_1', name: 'private' }] } };
      }
      if (command.id === 'wiki.nodeList') {
        return { ok: true, data: { nodes: [{ node_token: 'node_1' }] } };
      }
      if (command.id === 'wiki.nodeGet') {
        return {
          ok: true,
          data: { node_token: 'node_1', obj_token: 'doc_1', future_field: 'private' },
        };
      }
      throw new Error('sample_unavailable');
    });
    const report = await runContractAudit({ executor: { version: async () => '1.0.84', run } }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
    });

    expect(report.cases.find((entry) => entry.caseId === 'vc.search.default')?.state).toBe('failed');
    expect(report.cases.find((entry) => entry.caseId === 'wiki.nodeGet.default')?.state)
      .toBe('needs_review');
    expect(run.mock.calls.some(([command]) => command.id === 'wiki.nodeGet')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('audits every Minute artifact and validates transcript metadata from one sample', async () => {
    const validate = vi.fn(async () => ({ byteCount: 42 }));
    const withDirectory = vi.fn(async <T>(operation: (directory: string) => Promise<T>) => (
      operation('/safe/audit-artifact')
    ));
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'auth.status') return { identity: 'user' };
      if (command.id === 'minutes.search') {
        return { ok: true, data: { items: [{ minute_token: 'minute_1', title: 'private' }] } };
      }
      if (command.id === 'minutes.detail' && command.artifact === 'transcript') {
        return { ok: true, data: { minutes: [{ minute_token: 'minute_1', artifacts: { transcript_file: 'minute/transcript.md' } }] } };
      }
      if (command.id === 'minutes.detail') {
        return { ok: true, data: { minutes: [{ minute_token: 'minute_1', artifacts: {} }] } };
      }
      throw new Error('unavailable');
    });

    const report = await runContractAudit({
      executor: { version: async () => '1.0.84', run },
      artifacts: { withDirectory, validate },
    }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
    });

    expect(run.mock.calls.map(([command]) => command).filter((command) => (
      command.id === 'minutes.detail'
    ))).toEqual([
      { id: 'minutes.detail', minuteTokens: ['minute_1'], artifact: 'basic' },
      { id: 'minutes.detail', minuteTokens: ['minute_1'], artifact: 'summary' },
      { id: 'minutes.detail', minuteTokens: ['minute_1'], artifact: 'todo' },
      { id: 'minutes.detail', minuteTokens: ['minute_1'], artifact: 'chapter' },
      { id: 'minutes.detail', minuteTokens: ['minute_1'], artifact: 'transcript', workDir: '/safe/audit-artifact' },
    ]);
    expect(validate).toHaveBeenCalledWith(
      '/safe/audit-artifact', 'minute/transcript.md', expect.any(Number),
    );
    expect(report.cases.find((entry) => entry.caseId === 'minutes.detail.transcript')?.state)
      .toBe('verified');
    expect(JSON.stringify(report)).not.toContain('minute_1');
  });

  it('audits a unified Note transcript in a run-owned directory and always removes it', async () => {
    let artifactDirectory = '';
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'auth.status') return { identity: 'user' };
      if (command.id === 'vc.search') {
        return { ok: true, data: { items: [{ id: 'meeting_1' }] } };
      }
      if (command.id === 'vc.detail') {
        return { ok: true, data: { meetings: [{ meeting_id: 'meeting_1', note_id: 'note_1' }] } };
      }
      if (command.id === 'note.detail') {
        return { ok: true, data: { note: { note_display_type: 'unified' } } };
      }
      if (command.id === 'note.transcript') {
        await writeFile(join(command.workDir, 'transcript.md'), 'transient transcript');
        return { ok: true, data: { transcript_file: 'transcript.md' } };
      }
      throw new Error('unavailable');
    });
    const report = await runContractAudit({
      executor: { version: async () => '1.0.84', run },
      artifacts: {
        async withDirectory<T>(operation: (directory: string) => Promise<T>) {
          artifactDirectory = await mkdtemp(join(tmpdir(), 'minori-note-audit-'));
          try {
            return await operation(artifactDirectory);
          } finally {
            await rm(artifactDirectory, { recursive: true, force: true });
          }
        },
        validate: validateTranscriptArtifact,
      },
    }, {
      now: new Date('2026-08-12T12:00:00.000Z'),
      contactQuery: 'operator-supplied', driveQuery: 'operator-supplied',
      includeWriteAudit: false, bootstrapAuditDocument: false,
    });

    expect(report.cases.find((entry) => entry.caseId === 'note.detail.unified')?.state)
      .toBe('verified');
    expect(report.cases.find((entry) => entry.caseId === 'note.transcript.unified')?.state)
      .toBe('verified');
    await expect(access(artifactDirectory)).rejects.toThrow();
  });

  it('launches only an exact trusted image without the production env file', async () => {
    const launcher = await readFile('deploy/vultr/lark-contract-audit.sh', 'utf8');
    expect(launcher).toContain('^ghcr.io/[a-z0-9._/-]\+@sha256:[a-f0-9]\{64\}$');
    expect(launcher).toContain('org.opencontainers.image.revision');
    expect(launcher).toContain("[[ \"$image_arch\" == 'amd64' ]]");
    expect(launcher).toContain("[[ \"$image_user\" == '10001:10001' ]]");
    expect(launcher).toContain('HOME=/var/lib/minori/lark/home');
    expect(launcher).toContain('LARKSUITE_CLI_CONFIG_DIR=/var/lib/minori/lark/config');
    expect(launcher).toContain('LARKSUITE_CLI_DATA_DIR=/var/lib/minori/lark/data');
    expect(launcher).toContain('/opt/minori/lark:/var/lib/minori/lark');
    expect(launcher).not.toContain('--env-file');
    expect(launcher).not.toContain('/opt/minori/minori.env');
    expect(launcher).toContain("grep -E '^lark_contract_[a-z_]+$'");
    expect(launcher).toContain('minori_lark_contract_audit category=%s');
  });

  it('runs the native operator entry and writes only a verified sanitized fixture set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'minori-lark-audit-cli-'));
    try {
      const fake = join(root, 'fake-lark');
      const output = join(root, 'output');
      await writeFile(fake, `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == '--version' ]]; then printf '%s\\n' '1.0.84'; exit 0; fi
case "\${1:-} \${2:-}" in
  'auth status') printf '%s\\n' '{"identity":"user"}' ;;
  'contact +search-user') printf '%s\\n' '{"ok":true,"data":{"users":[]}}' ;;
  'vc +search') printf '%s\\n' '{"ok":true,"data":{"items":[]}}' ;;
  'minutes +search') printf '%s\\n' '{"ok":true,"data":{"items":[]}}' ;;
  'drive +search') printf '%s\\n' '{"ok":true,"data":{"results":[]}}' ;;
  'wiki +space-list') printf '%s\\n' '{"ok":true,"data":{"spaces":[]}}' ;;
  *) exit 1 ;;
esac
`);
      await chmod(fake, 0o700);
      const result = await runOperator([
        '--experimental-strip-types', 'scripts/lark-contract-audit.ts',
        '--capture', '--output', output,
      ], JSON.stringify({
          contactQuery: 'operator supplied',
          driveQuery: 'operator supplied',
        }), { ...process.env, LARK_CLI_BIN: fake });
      expect(result.stderr).toContain('lark_contract_audit_result=success');
      expect(result.stdout).toBe('');
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8')) as unknown;
      expect(JSON.stringify(report)).not.toContain('operator supplied');
      await expect(verifyFixtureSet({
        manifestPath: join(output, 'cli-1.0.84', 'manifest.json'),
        fixtureRoot: join(output, 'cli-1.0.84'),
        lockfilePath: 'package-lock.json',
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
