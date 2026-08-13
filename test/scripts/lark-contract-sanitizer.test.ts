import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sanitizeCapture,
  scanForbiddenResidue,
  validateTranscriptArtifact,
} from '../../scripts/lark-contract-sanitizer.js';

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'minori-lark-sanitize-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Lark Contract Sanitizer', () => {
  it('preserves structure while replacing sensitive and unknown strings', () => {
    expect(sanitizeCapture({
      ok: true,
      data: {
        note: {
          note_id: 'note_real',
          app_link: 'https://tenant.feishu.cn/minutes/real',
          display_info: 'Private weekly title',
          note_display_type: 'unified',
          future_field: 'provider-added private value',
          empty_value: '',
          count: 3,
        },
      },
    })).toEqual({
      value: {
        ok: true,
        data: {
          note: {
            note_id: '<redacted-id>',
            app_link: '<redacted-url>',
            display_info: '<redacted-text>',
            note_display_type: 'unified',
            future_field: '<redacted-string>',
            empty_value: '',
            count: 3,
          },
        },
      },
      unclassifiedStringFields: ['$.data.note.future_field'],
    });
  });

  it('classifies the content-free operational fields observed in CLI 1.0.84', () => {
    const result = sanitizeCapture({
      appId: 'provider-app-id',
      openId: 'provider-open-id',
      creator: 'provider-user-id',
      owner: 'provider-user-id',
      meeting_no: '123456789',
      command: 'npm install something',
      current: '1.0.84',
      latest: '1.0.85',
      hint: 'provider hint',
      scope: 'provider scopes',
      tokenStatus: 'valid',
      create_time: '2026-08-12T00:00:00Z',
      title_highlighted: '<em>private</em>',
      match_segments: ['private'],
      node_type: 'origin',
      obj_type: 'docx',
      visibility: 'private',
    });
    expect(result.unclassifiedStringFields).toEqual([]);
    expect(result.value).toEqual({
      appId: '<redacted-id>',
      openId: '<redacted-id>',
      creator: '<redacted-id>',
      owner: '<redacted-id>',
      meeting_no: '<redacted-id>',
      command: '<redacted-text>',
      current: '<redacted-text>',
      latest: '<redacted-text>',
      hint: '<redacted-text>',
      scope: '<redacted-text>',
      tokenStatus: '<redacted-text>',
      create_time: '<redacted-text>',
      title_highlighted: '<redacted-text>',
      match_segments: ['<redacted-text>'],
      node_type: '<redacted-text>',
      obj_type: '<redacted-text>',
      visibility: '<redacted-text>',
    });
  });

  it('rejects forbidden residue in generated JSON', async () => {
    const base = await root();
    const safe = join(base, 'safe.json');
    await writeFile(safe, JSON.stringify({ id: '<redacted-id>', type: 'unified' }));
    await expect(scanForbiddenResidue([safe])).resolves.toBeUndefined();

    const unsafe = join(base, 'unsafe.json');
    await writeFile(unsafe, JSON.stringify({ token: 'wikcnRealProviderToken' }));
    await expect(scanForbiddenResidue([unsafe])).rejects.toThrow('lark_contract_residue_detected');
  });

  it('validates only a contained non-empty transcript file and returns its byte count', async () => {
    const base = await root();
    await writeFile(join(base, 'transcript.md'), 'transient words');
    await expect(validateTranscriptArtifact(base, 'transcript.md', 100))
      .resolves.toEqual({ byteCount: 15 });

    await writeFile(join(base, 'empty.md'), '');
    await expect(validateTranscriptArtifact(base, 'empty.md', 100))
      .rejects.toThrow('lark_contract_transcript_invalid');
    await expect(validateTranscriptArtifact(base, '../outside.md', 100))
      .rejects.toThrow('lark_contract_transcript_invalid');
  });

  it('rejects symlinked and oversized transcript artifacts', async () => {
    const base = await root();
    const outside = await root();
    await mkdir(join(base, 'nested'));
    await writeFile(join(outside, 'secret.md'), 'secret');
    await symlink(join(outside, 'secret.md'), join(base, 'nested', 'linked.md'));
    await expect(validateTranscriptArtifact(base, 'nested/linked.md', 100))
      .rejects.toThrow('lark_contract_transcript_invalid');

    await writeFile(join(base, 'large.md'), '123456');
    await expect(validateTranscriptArtifact(base, 'large.md', 5))
      .rejects.toThrow('lark_contract_transcript_invalid');
  });
});
