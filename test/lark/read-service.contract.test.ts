import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import { LarkContractError } from '../../src/lark/errors.js';
import { LarkKnowledgeReader } from '../../src/lark/read-service.js';
import type { LarkExecutor } from '../../src/lark/runner.js';

async function fixtureData(name: string): Promise<unknown> {
  const raw = await readFile(resolve('test/fixtures/lark', `${name}.json`), 'utf8');
  return (JSON.parse(raw) as { data: unknown }).data;
}

function executorReturning(data: unknown) {
  const run = vi.fn(async (_command: LarkCommand) => data);
  return { executor: { run } as unknown as LarkExecutor, run };
}

describe('LarkKnowledgeReader contract', () => {
  it('maps Drive search output into source metadata', async () => {
    const { executor, run } = executorReturning(await fixtureData('drive-search'));
    const reader = new LarkKnowledgeReader(executor);

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
    const reader = new LarkKnowledgeReader(executor);
    const doc = 'https://acme.feishu.cn/docx/doxcnRoadmap';

    await expect(reader.fetchDocument({ doc })).resolves.toEqual({
      title: 'Team Roadmap',
      url: doc,
      markdown: '# Team Roadmap\n\nLaunch the read-only agent first.',
    });
    expect(run).toHaveBeenCalledWith({ id: 'docs.fetch', doc });
  });

  it('builds the official Feishu document URL when fetch starts from a token', async () => {
    const { executor } = executorReturning(await fixtureData('docs-fetch'));
    const reader = new LarkKnowledgeReader(executor);

    await expect(reader.fetchDocument({ doc: 'doxcnRoadmap' })).resolves.toMatchObject({
      url: 'https://www.feishu.cn/docx/doxcnRoadmap',
    });
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
    const reader = new LarkKnowledgeReader({ run } as unknown as LarkExecutor);

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
    const reader = new LarkKnowledgeReader(executor);

    const error = await reader.search({ query: 'roadmap' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LarkContractError);
    expect(error).toMatchObject({ code: 'contract_error' });
    expect(JSON.stringify(error)).not.toContain('missing metadata');
  });
});
