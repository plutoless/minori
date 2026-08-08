import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import { LarkCliError, LarkContractError } from '../../src/lark/errors.js';
import { LarkKnowledgeService } from '../../src/lark/knowledge-service.js';
import type { LarkExecutor } from '../../src/lark/runner.js';

async function fixtureData(name: string): Promise<unknown> {
  const raw = await readFile(resolve('test/fixtures/lark', `${name}.json`), 'utf8');
  return (JSON.parse(raw) as { data: unknown }).data;
}

function executorReturning(data: unknown) {
  const run = vi.fn(async (_command: LarkCommand) => data);
  return { executor: { run } as unknown as LarkExecutor, run };
}

describe('LarkKnowledgeService contract', () => {
  it('maps Drive search output into source metadata', async () => {
    const { executor, run } = executorReturning(await fixtureData('drive-search'));
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.search({ query: 'roadmap', spaceIds: ['734000001'] })).resolves
      .toEqual([{
        title: 'Team Roadmap',
        url: 'https://acme.feishu.cn/docx/doxcnRoadmap',
        token: 'doxcnRoadmap',
        type: 'DOCX',
      }]);
    expect(run).toHaveBeenCalledWith({
      id: 'drive.search', query: 'roadmap', spaceIds: ['734000001'],
    });
  });

  it('maps fetched markdown and preserves its canonical input URL', async () => {
    const { executor, run } = executorReturning(await fixtureData('docs-fetch'));
    const reader = new LarkKnowledgeService(executor);
    const doc = 'https://acme.feishu.cn/docx/doxcnRoadmap';

    await expect(reader.fetchDocument({ doc })).resolves.toEqual({
      token: 'doxcnRoadmap',
      title: 'Team Roadmap',
      url: doc,
      markdown: '# Team Roadmap\n\nLaunch the read-only agent first.',
      revisionId: 7,
    });
    expect(run).toHaveBeenCalledWith({ id: 'docs.fetch', doc });
  });

  it('builds the official Feishu document URL when fetch starts from a token', async () => {
    const { executor } = executorReturning(await fixtureData('docs-fetch'));
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.fetchDocument({ doc: 'doxcnRoadmap' })).resolves.toMatchObject({
      url: 'https://www.feishu.cn/docx/doxcnRoadmap',
    });
  });

  it('passes an Agent abort signal through to the Lark executor', async () => {
    const { executor, run } = executorReturning(await fixtureData('docs-fetch'));
    const reader = new LarkKnowledgeService(executor);
    const controller = new AbortController();

    await reader.fetchDocument({ doc: 'doxcnRoadmap' }, controller.signal);

    expect(run).toHaveBeenCalledWith(
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      controller.signal,
    );
  });

  it('maps wiki spaces, node lists, and node detail output', async () => {
    const spaceFixture = await fixtureData('wiki-space-list');
    const listFixture = await fixtureData('wiki-node-list');
    const nodeFixture = await fixtureData('wiki-node-get');
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'wiki.spaceList') return spaceFixture;
      if (command.id === 'wiki.nodeList') return listFixture;
      return nodeFixture;
    });
    const reader = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(reader.listSpaces()).resolves.toEqual([
      { spaceId: '734000001', name: 'Engineering' },
    ]);
    await expect(reader.listNodes({
      spaceId: '734000001', parentNodeToken: 'wikcnParent',
    })).resolves.toEqual([{
      nodeToken: 'wikcnRoadmap', title: 'Team Roadmap', objType: 'docx',
    }]);
    await expect(reader.getNode({ nodeToken: 'wikcnRoadmap' })).resolves.toEqual({
      nodeToken: 'wikcnRoadmap', objToken: 'doxcnRoadmap',
      objType: 'docx', title: 'Team Roadmap',
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'wiki.spaceList' },
      { id: 'wiki.nodeList', spaceId: '734000001', parentNodeToken: 'wikcnParent' },
      { id: 'wiki.nodeGet', nodeToken: 'wikcnRoadmap' },
    ]);
  });

  it('rejects upstream shape drift as a stable contract error', async () => {
    const { executor } = executorReturning({ results: [{ title: 'missing metadata' }] });
    const reader = new LarkKnowledgeService(executor);

    const error = await reader.search({ query: 'roadmap' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LarkContractError);
    expect(error).toMatchObject({ code: 'contract_error' });
    expect(JSON.stringify(error)).not.toContain('missing metadata');
  });

  it('creates a document then re-fetches its canonical write receipt', async () => {
    const created = await fixtureData('docs-create');
    const refreshed = {
      document: {
        document_id: 'doxcnWeekly',
        revision_id: 2,
        title: 'Weekly update',
        url: 'https://acme.feishu.cn/docx/doxcnWeekly',
        content: '# Weekly update\n\n# Progress',
      },
    };
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.create') return created;
      if (command.id === 'docs.fetch') return refreshed;
      throw new Error('unexpected_command');
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.createDocument({
      title: 'Weekly update', content: '# Progress', parentToken: 'fld_1',
    })).resolves.toEqual({
      operation: 'create', token: 'doxcnWeekly', title: 'Weekly update',
      url: 'https://acme.feishu.cn/docx/doxcnWeekly', revisionId: 2,
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.create', title: 'Weekly update', content: '# Progress', parentToken: 'fld_1' },
      { id: 'docs.fetch', doc: 'doxcnWeekly' },
    ]);
  });

  it('appends against the current revision then returns the refreshed receipt', async () => {
    const before = await fixtureData('docs-fetch');
    const appended = await fixtureData('docs-append');
    const after = {
      document: {
        document_id: 'doxcnRoadmap', revision_id: 8, title: 'Team Roadmap',
        url: 'https://acme.feishu.cn/docx/doxcnRoadmap',
        content: '# Team Roadmap\n\nLaunch the read-only agent first.\n\n- shipped',
      },
    };
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return run.mock.calls.length === 1 ? before : after;
      if (command.id === 'docs.append') return appended;
      throw new Error('unexpected_command');
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .resolves.toMatchObject({ operation: 'append', token: 'doxcnRoadmap', revisionId: 8 });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
    ]);
  });

  it('patches exactly one matching range against the current revision', async () => {
    const before = await fixtureData('docs-fetch');
    const patched = await fixtureData('docs-patch');
    const after = {
      document: {
        document_id: 'doxcnRoadmap', revision_id: 8, title: 'Team Roadmap',
        url: 'https://acme.feishu.cn/docx/doxcnRoadmap',
        content: '# Team Roadmap\n\nLaunch the team agent first.',
      },
    };
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return run.mock.calls.length === 1 ? before : after;
      if (command.id === 'docs.patch') return patched;
      throw new Error('unexpected_command');
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.patchDocument({
      doc: 'doxcnRoadmap', pattern: 'read-only', replacement: 'team',
    })).resolves.toMatchObject({ operation: 'patch', token: 'doxcnRoadmap', revisionId: 8 });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      {
        id: 'docs.patch', doc: 'doxcnRoadmap', pattern: 'read-only', content: 'team', revisionId: 7,
      },
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
    ]);
  });

  it.each(['missing phrase', 'e'])(
    'returns a stable conflict when patch content has %s matches',
    async (pattern) => {
      const { executor, run } = executorReturning(await fixtureData('docs-fetch'));
      const service = new LarkKnowledgeService(executor);

      const error = await service.patchDocument({
        doc: 'doxcnRoadmap', pattern, replacement: 'replacement',
      }).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ code: 'knowledge_write_conflict' });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({ id: 'docs.fetch', doc: 'doxcnRoadmap' });
    },
  );

  it('maps a Lark revision conflict without retrying', async () => {
    const before = await fixtureData('docs-fetch');
    const revisionConflict = new LarkCliError('cli_error', {
      type: 'api', subtype: 'revision_conflict', upstreamCode: 177003,
    });
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return before;
      throw revisionConflict;
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'knowledge_write_conflict' });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
    ]);
  });

  it('rejects a malformed write response without claiming a successful receipt', async () => {
    const before = await fixtureData('docs-fetch');
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return before;
      return { document: { document_id: 'doxcnRoadmap' } };
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'contract_error' });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
    ]);
  });
});
