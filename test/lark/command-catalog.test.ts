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

  it('has no generic escape hatch in its public command type', () => {
    // @ts-expect-error arbitrary command IDs are intentionally impossible
    buildInvocation({ id: 'api.raw', path: '/open-apis/wiki/v2/spaces' });
  });
});
