import { describe, expect, it } from 'vitest';
import { buildInvocation } from '../../src/lark/command-catalog.js';

describe('buildInvocation', () => {
  it('passes untrusted search text as one literal argv value', () => {
    expect(buildInvocation({ id: 'drive.search', query: 'x; $(touch /tmp/pwned)' })).toEqual({
      args: [
        'drive', '+search', '--query', 'x; $(touch /tmp/pwned)',
        '--format', 'json', '--as', 'user',
      ],
    });
  });

  it('maps every approved knowledge read to a fixed CLI shortcut', () => {
    expect(buildInvocation({
      id: 'drive.search', query: 'roadmap', spaceIds: ['spc_1', 'spc_2'],
    }).args).toEqual([
      'drive', '+search', '--query', 'roadmap', '--space-ids', 'spc_1,spc_2',
      '--format', 'json', '--as', 'user',
    ]);
    expect(buildInvocation({ id: 'docs.fetch', doc: 'https://example.feishu.cn/docx/doc_1' }).args)
      .toEqual([
        'docs', '+fetch', '--doc', 'https://example.feishu.cn/docx/doc_1',
        '--doc-format', 'markdown', '--format', 'json', '--as', 'user',
      ]);
    expect(buildInvocation({ id: 'wiki.spaceList' }).args)
      .toEqual(['wiki', '+space-list', '--format', 'json', '--as', 'user']);
    expect(buildInvocation({ id: 'wiki.nodeList', spaceId: 'spc_1' }).args)
      .toEqual(['wiki', '+node-list', '--space-id', 'spc_1', '--format', 'json', '--as', 'user']);
    expect(buildInvocation({
      id: 'wiki.nodeList', spaceId: 'spc_1', parentNodeToken: 'wik_parent',
    }).args).toEqual([
      'wiki', '+node-list', '--space-id', 'spc_1', '--parent-node-token', 'wik_parent',
      '--format', 'json', '--as', 'user',
    ]);
    expect(buildInvocation({ id: 'wiki.nodeGet', nodeToken: 'wik_1' }).args)
      .toEqual([
        'wiki', '+node-get', '--node-token', 'wik_1', '--format', 'json', '--as', 'user',
      ]);
    expect(buildInvocation({ id: 'auth.status' }).args)
      .toEqual(['auth', 'status', '--json', '--verify']);
  });

  it('maps every approved meeting read to a fixed user-identity CLI shortcut', () => {
    expect(buildInvocation({
      id: 'contact.searchUser', query: 'Alice; $(touch /tmp/no)', pageSize: 10,
    }).args).toEqual([
      'contact', '+search-user', '--query', 'Alice; $(touch /tmp/no)',
      '--page-size', '10', '--format', 'json', '--as', 'user',
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
      .toEqual([
        'vc', '+detail', '--meeting-ids', 'm_1', '--format', 'json', '--as', 'user',
      ]);
    expect(buildInvocation({ id: 'note.detail', noteId: 'note_1' }).args)
      .toEqual([
        'note', '+detail', '--note-id', 'note_1', '--format', 'json', '--as', 'user',
      ]);
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
      id: 'minutes.search', query: 'DevX', ownerIds: ['ou_owner'],
      participantIds: ['ou_a'], pageSize: 30, pageToken: 'page_2',
    }).args).toEqual([
      'minutes', '+search', '--query', 'DevX', '--owner-ids', 'ou_owner',
      '--participant-ids', 'ou_a', '--page-size', '30', '--page-token', 'page_2',
      '--format', 'json', '--as', 'user',
    ]);
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
  });

  it('maps exactly the Initial Typed Write Set through fixed commands and stdin', () => {
    expect(buildInvocation({
      id: 'docs.create', title: 'Weekly update', content: '# Progress', parentToken: 'fld_1',
    })).toEqual({
      args: [
        'docs', '+create', '--title', 'Weekly update', '--parent-token', 'fld_1',
        '--doc-format', 'markdown', '--content', '-', '--format', 'json', '--as', 'user',
      ],
      stdin: '# Progress',
    });
    expect(buildInvocation({
      id: 'docs.create', title: 'Weekly update', content: '# Progress',
    })).toEqual({
      args: [
        'docs', '+create', '--title', 'Weekly update', '--doc-format', 'markdown',
        '--content', '-', '--format', 'json', '--as', 'user',
      ],
      stdin: '# Progress',
    });
    expect(buildInvocation({
      id: 'docs.append', doc: 'dox_1', content: '\n- shipped', revisionId: 7,
    })).toEqual({
      args: [
        'docs', '+update', '--doc', 'dox_1', '--command', 'append', '--revision-id', '7',
        '--doc-format', 'markdown', '--content', '-', '--format', 'json', '--as', 'user',
      ],
      stdin: '\n- shipped',
    });
    expect(buildInvocation({
      id: 'docs.patch', doc: 'dox_1', pattern: 'Old', content: 'New', revisionId: 7,
    })).toEqual({
      args: [
        'docs', '+update', '--doc', 'dox_1', '--command', 'str_replace', '--pattern', 'Old',
        '--revision-id', '7', '--doc-format', 'markdown', '--content', '-', '--format', 'json',
        '--as', 'user',
      ],
      stdin: 'New',
    });
  });

  it('has no generic escape hatch in its public command type', () => {
    // @ts-expect-error arbitrary command IDs are intentionally impossible
    buildInvocation({ id: 'api.raw', path: '/open-apis/wiki/v2/spaces' });
    // @ts-expect-error destructive document operations are intentionally impossible
    buildInvocation({ id: 'docs.delete', doc: 'dox_1' });
    // @ts-expect-error rename authority is intentionally impossible
    buildInvocation({ id: 'docs.rename', doc: 'dox_1', title: 'Renamed' });
    // @ts-expect-error move authority is intentionally impossible
    buildInvocation({ id: 'docs.move', doc: 'dox_1', parentToken: 'fld_2' });
    // @ts-expect-error trash authority is intentionally impossible
    buildInvocation({ id: 'docs.trash', doc: 'dox_1' });
    // @ts-expect-error permission authority is intentionally impossible
    buildInvocation({ id: 'docs.permission', doc: 'dox_1', member: 'ou_other' });
    // @ts-expect-error raw shell commands are intentionally impossible
    buildInvocation({ id: 'shell.exec', command: 'rm -rf /' });
    // @ts-expect-error arbitrary HTTP requests are intentionally impossible
    buildInvocation({ id: 'http.request', url: 'https://example.com' });
    // @ts-expect-error filesystem commands are intentionally impossible
    buildInvocation({ id: 'fs.write', path: '/tmp/document' });
    // @ts-expect-error meeting writes are intentionally impossible
    buildInvocation({ id: 'vc.meeting.update', meetingId: 'm_1' });
    // @ts-expect-error meeting media export is intentionally impossible
    buildInvocation({ id: 'minutes.media.export', minuteToken: 'obc_1' });
    // @ts-expect-error transcript file output always requires a run-owned working directory
    buildInvocation({ id: 'minutes.detail', minuteTokens: ['obc_1'], artifact: 'transcript' });
  });
});
