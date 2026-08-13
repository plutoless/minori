import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import {
  KnowledgeWriteConflict, LarkCliError, LarkContractError,
} from '../../src/lark/errors.js';
import { LarkKnowledgeService } from '../../src/lark/knowledge-service.js';
import type { LarkExecutor } from '../../src/lark/runner.js';
import { loadFixtureData } from '../helpers/lark-contract-fixture.js';

async function fixtureData(name: string): Promise<unknown> {
  const raw = await readFile(resolve('test/fixtures/lark', `${name}.json`), 'utf8');
  return (JSON.parse(raw) as { data: unknown }).data;
}

function executorReturning(data: unknown) {
  const run = vi.fn(async (_command: LarkCommand) => data);
  return { executor: { run } as unknown as LarkExecutor, run };
}

describe('LarkKnowledgeService contract', () => {
  it('accepts all verified live CLI 1.0.84 knowledge data fixtures', async () => {
    const fixtures = {
      search: await loadFixtureData('drive.search.default'),
      fetch: await loadFixtureData('docs.fetch.default'),
      spaces: await loadFixtureData('wiki.spaceList.default'),
      nodes: await loadFixtureData('wiki.nodeList.default'),
      node: await loadFixtureData('wiki.nodeGet.default'),
    };
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'drive.search') return fixtures.search;
      if (command.id === 'docs.fetch') return fixtures.fetch;
      if (command.id === 'wiki.spaceList') return fixtures.spaces;
      if (command.id === 'wiki.nodeList') return fixtures.nodes;
      if (command.id === 'wiki.nodeGet') return fixtures.node;
      throw new Error('unexpected_command');
    });
    const reader = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(reader.search({ query: 'sanitized' })).resolves.toMatchObject({
      status: 'complete', rawCount: 15, validCount: 15, omittedCount: 0,
    });
    await expect(reader.fetchDocument({ doc: '<redacted-id>' })).resolves.toMatchObject({
      token: '<redacted-id>', revisionId: expect.any(Number),
    });
    await expect(reader.listSpaces()).resolves.toHaveLength(3);
    await expect(reader.listNodes({ spaceId: '<redacted-id>' })).resolves.toHaveLength(6);
    await expect(reader.getNode({ nodeToken: '<redacted-id>' })).resolves.toMatchObject({
      nodeToken: '<redacted-id>', objToken: '<redacted-id>',
    });
  });

  it('accepts verified live append and patch responses without a repeated document ID', async () => {
    const append = await loadFixtureData('docs.append.default');
    const patch = await loadFixtureData('docs.patch.default');
    const before = {
      document: {
        document_id: '<redacted-id>', revision_id: 9, content: '# Audit\n\nOld',
        title: 'Audit', url: 'https://www.feishu.cn/docx/redacted',
      },
    };
    const afterAppend = {
      document: { ...before.document, revision_id: 10, content: '# Audit\n\nOld\n\nNew' },
    };
    const afterPatch = {
      document: { ...before.document, revision_id: 10, content: '# Audit\n\nCurrent' },
    };

    const appendRun = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.append') return append;
      if (command.id === 'docs.fetch') return appendRun.mock.calls.length === 1
        ? before : afterAppend;
      throw new Error('unexpected_command');
    });
    const appendService = new LarkKnowledgeService({ run: appendRun } as unknown as LarkExecutor);
    await expect(appendService.appendDocument({ doc: '<redacted-id>', content: '\nNew' }))
      .resolves.toMatchObject({ operation: 'append', revisionId: 10 });

    const patchBefore = {
      document: { ...before.document, revision_id: 10, content: '# Audit\n\nOld' },
    };
    const patchAfter = {
      document: { ...before.document, revision_id: 11, content: '# Audit\n\nCurrent' },
    };
    const patchRun = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.patch') return patch;
      if (command.id === 'docs.fetch') return patchRun.mock.calls.length === 1
        ? patchBefore : patchAfter;
      throw new Error('unexpected_command');
    });
    const patchService = new LarkKnowledgeService({ run: patchRun } as unknown as LarkExecutor);
    await expect(patchService.patchDocument({
      doc: '<redacted-id>', pattern: 'Old', replacement: 'Current',
    })).resolves.toMatchObject({ operation: 'patch', revisionId: 11 });
  });

  it('preserves current Wiki search rows independently of malformed siblings', async () => {
    const { executor } = executorReturning(await fixtureData('drive-search-current-wiki'));
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.search({ query: 'wiki' })).resolves.toEqual({
      status: 'partial',
      results: [
        {
          title: 'Current Wiki',
          url: 'https://acme.feishu.cn/wiki/wikcnCurrent',
          token: 'wikcnCurrent',
          type: 'WIKI',
        },
        {
          title: 'Legacy document',
          url: 'https://acme.feishu.cn/docx/doxcnLegacy',
          token: 'doxcnLegacy',
          type: 'DOCX',
        },
        {
          title: 'Fetchable without URL',
          token: 'wikcnNoUrl',
          type: 'WIKI',
        },
      ],
      rawCount: 4,
      validCount: 3,
      omittedCount: 1,
    });
  });

  it('ignores malformed optional metadata on otherwise fetchable legacy rows', async () => {
    const { executor } = executorReturning({
      results: [
        {
          entity_type: 'WIKI', entity_id: 'legacyNumericUrl',
          result_meta: { url: 123 }, title: 'Numeric URL',
        },
        {
          entity_type: 'WIKI', entity_id: 'legacyNumericTitle',
          result_meta: { url: 'https://acme.feishu.cn/wiki/legacyNumericTitle' }, title: 456,
        },
        {
          entity_type: 'WIKI', entity_id: 'legacyEmptyCurrent',
          result_meta: { token: '', url: 'https://acme.feishu.cn/wiki/legacyEmptyCurrent' },
          title: 'Legacy fallback',
        },
      ],
    });
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.search({ query: 'legacy' })).resolves.toEqual({
      status: 'complete',
      results: [
        { title: 'Numeric URL', token: 'legacyNumericUrl', type: 'WIKI' },
        {
          title: 'legacyNumericTitle', token: 'legacyNumericTitle', type: 'WIKI',
          url: 'https://acme.feishu.cn/wiki/legacyNumericTitle',
        },
        {
          title: 'Legacy fallback', token: 'legacyEmptyCurrent', type: 'WIKI',
          url: 'https://acme.feishu.cn/wiki/legacyEmptyCurrent',
        },
      ],
      rawCount: 3,
      validCount: 3,
      omittedCount: 0,
    });
  });

  it('maps Drive search output into source metadata', async () => {
    const { executor, run } = executorReturning(await fixtureData('drive-search'));
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.search({ query: 'roadmap', spaceIds: ['734000001'] })).resolves
      .toEqual({
        status: 'complete',
        results: [{
          title: 'Team Roadmap',
          url: 'https://acme.feishu.cn/docx/doxcnRoadmap',
          token: 'doxcnRoadmap',
          type: 'DOCX',
        }, {
          title: 'Legacy result without URL',
          token: 'doccnLegacy',
          type: 'DOC',
        }],
        rawCount: 2,
        validCount: 2,
        omittedCount: 0,
      });
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
    const { executor } = executorReturning({
      results: [{ title: 'missing metadata' }, { entity_type: 'WIKI' }],
    });
    const reader = new LarkKnowledgeService(executor);

    const error = await reader.search({ query: 'roadmap' }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'knowledge_search_contract_error',
      completeness: { rawCount: 2, validCount: 0, omittedCount: 2 },
    });
    expect(JSON.stringify(error)).not.toContain('missing metadata');
  });

  it('returns a complete empty result set for an empty provider array', async () => {
    const { executor } = executorReturning({ results: [] });
    const reader = new LarkKnowledgeService(executor);

    await expect(reader.search({ query: 'none' })).resolves.toEqual({
      status: 'complete', results: [], rawCount: 0, validCount: 0, omittedCount: 0,
    });
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

  it('rejects an exact patch when its caller-bound revision changed before write', async () => {
    const { executor, run } = executorReturning(await fixtureData('docs-fetch'));
    const service = new LarkKnowledgeService(executor);

    await expect(service.patchDocument({
      doc: 'doxcnRoadmap', pattern: 'read-only', replacement: 'team', expectedRevision: 6,
    })).rejects.toBeInstanceOf(KnowledgeWriteConflict);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ id: 'docs.fetch', doc: 'doxcnRoadmap' });
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

  it('maps a numeric-only Lark revision conflict without retrying', async () => {
    const before = await fixtureData('docs-fetch');
    const revisionConflict = new LarkCliError('cli_error', { upstreamCode: 177003 });
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

  it('rejects a write response for a different document without a receipt', async () => {
    const before = await fixtureData('docs-fetch');
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return before;
      return { document: { document_id: 'doxcnOther', revision_id: 8 } };
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'contract_error' });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
    ]);
  });

  it('rejects when the canonical re-fetch does not advance after an accepted write', async () => {
    const before = await fixtureData('docs-fetch');
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return before;
      return { document: { document_id: 'doxcnRoadmap', revision_id: 7 } };
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'contract_error' });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
    ]);
  });

  it('rejects a canonical re-fetch that regresses behind the accepted revision', async () => {
    const before = await fixtureData('docs-fetch');
    const appended = await fixtureData('docs-append');
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return before;
      if (command.id === 'docs.append') return appended;
      throw new Error('unexpected_command');
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'contract_error' });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
      { id: 'docs.append', doc: 'doxcnRoadmap', content: '\n- shipped', revisionId: 7 },
      { id: 'docs.fetch', doc: 'doxcnRoadmap' },
    ]);
  });

  it('rejects a canonical re-fetch for a different document', async () => {
    const before = await fixtureData('docs-fetch');
    const appended = await fixtureData('docs-append');
    const wrongDocument = {
      document: {
        document_id: 'doxcnOther', revision_id: 8, content: '# Other document',
      },
    };
    const run = vi.fn(async (command: LarkCommand) => {
      if (command.id === 'docs.fetch') return run.mock.calls.length === 1 ? before : wrongDocument;
      if (command.id === 'docs.append') return appended;
      throw new Error('unexpected_command');
    });
    const service = new LarkKnowledgeService({ run } as unknown as LarkExecutor);

    await expect(service.appendDocument({ doc: 'doxcnRoadmap', content: '\n- shipped' }))
      .rejects.toMatchObject({ code: 'contract_error' });
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
