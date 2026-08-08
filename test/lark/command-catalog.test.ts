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

  it('maps every allowed read command to a fixed CLI shortcut', () => {
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
      .toEqual(['auth', 'status', '--json']);
  });

  it('passes document content only through stdin for allowed reversible writes', () => {
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
    // @ts-expect-error raw shell commands are intentionally impossible
    buildInvocation({ id: 'shell.exec', command: 'rm -rf /' });
    // @ts-expect-error arbitrary HTTP requests are intentionally impossible
    buildInvocation({ id: 'http.request', url: 'https://example.com' });
    // @ts-expect-error filesystem commands are intentionally impossible
    buildInvocation({ id: 'fs.write', path: '/tmp/document' });
  });
});
