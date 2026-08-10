import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWriteConflict, LarkCliError } from '../../src/lark/errors.js';
import type { KnowledgeDocument, KnowledgeService } from '../../src/lark/knowledge-service.js';
import type { TeamContextStore } from '../../src/storage/team-context-store.js';
import { DefaultTeamContextSource } from '../../src/team-context/source.js';
import type { TeamContextSnapshot } from '../../src/team-context/types.js';

function document(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    token: 'dox_team', title: 'Team Context', url: 'https://acme.feishu.cn/docx/dox_team',
    markdown: '# Team Context\r\n\r\n- Conclusions first.   \r\n', revisionId: 7,
    ...overrides,
  };
}

function fixture(options: {
  fetched?: KnowledgeDocument;
  fetchError?: unknown;
  snapshot?: TeamContextSnapshot;
  now?: Date;
  estimatedTokens?: number;
  patchError?: unknown;
} = {}) {
  let snapshot = options.snapshot;
  const store: TeamContextStore = {
    load: vi.fn(async () => snapshot),
    accept: vi.fn(async (next) => { snapshot = next; }),
    invalidate: vi.fn(async () => { snapshot = undefined; }),
  };
  const fetchDocument = options.fetchError === undefined
    ? vi.fn(async () => options.fetched ?? document())
    : vi.fn(async () => { throw options.fetchError; });
  const patchDocument = options.patchError === undefined
    ? vi.fn(async () => ({
      operation: 'patch' as const,
      token: 'dox_team', title: 'Team Context',
      url: 'https://acme.feishu.cn/docx/dox_team', revisionId: 8,
    }))
    : vi.fn(async () => { throw options.patchError; });
  const knowledge = { fetchDocument, patchDocument } as unknown as KnowledgeService;
  const source = new DefaultTeamContextSource({
    documentToken: 'dox_team',
    tokenBudget: 8_000,
    staleMaxMs: 86_400_000,
    knowledge,
    store,
    now: () => options.now ?? new Date('2026-08-10T12:00:00Z'),
    estimateTokens: () => options.estimatedTokens ?? 12,
  });
  return { source, store, fetchDocument, patchDocument };
}

describe('DefaultTeamContextSource', () => {
  it('loads, normalizes, budgets, and stores one complete revision', async () => {
    const { source, store } = fixture();

    await expect(source.load()).resolves.toEqual({
      status: 'loaded',
      content: '# Team Context\n\n- Conclusions first.\n',
      sourceRevision: 7,
      estimatedTokens: 12,
      fetchedAt: new Date('2026-08-10T12:00:00Z'),
    });
    expect(store.accept).toHaveBeenCalledWith({
      documentToken: 'dox_team', sourceRevision: 7,
      normalizedContent: '# Team Context\n\n- Conclusions first.\n',
      estimatedTokens: 12, fetchedAt: new Date('2026-08-10T12:00:00Z'),
    });
  });

  it.each([
    { ageMs: 86_399_999, expected: 'stale' },
    { ageMs: 86_400_000, expected: 'stale' },
    { ageMs: 86_400_001, expected: 'unavailable' },
  ] as const)('bounds temporary fallback at 24 hours: $ageMs', async ({ ageMs, expected }) => {
    const now = new Date('2026-08-10T12:00:00Z');
    const snapshot = {
      documentToken: 'dox_team', sourceRevision: 6, normalizedContent: '# Previous\n',
      estimatedTokens: 3, fetchedAt: new Date(now.getTime() - ageMs),
    };
    const { source } = fixture({
      now, snapshot, fetchError: new LarkCliError('timeout'),
    });

    const result = await source.load();

    expect(result.status).toBe(expected);
    if (expected === 'stale') {
      expect(result).toMatchObject({
        content: '# Previous\n', sourceRevision: 6, errorCategory: 'team_context_stale',
      });
    } else {
      expect(result.content).toBeUndefined();
      expect(result.errorCategory).toBe('team_context_unavailable');
    }
  });

  it.each(['forbidden', 'not_found'] as const)(
    'invalidates immediately for explicit %s without stale fallback',
    async (subtype) => {
      const { source, store } = fixture({
        snapshot: {
          documentToken: 'dox_team', sourceRevision: 6, normalizedContent: '# Previous\n',
          estimatedTokens: 3, fetchedAt: new Date('2026-08-10T11:59:00Z'),
        },
        fetchError: new LarkCliError('cli_error', { type: 'api', subtype }),
      });

      await expect(source.load()).resolves.toEqual({
        status: 'unavailable', errorCategory: 'team_context_unavailable',
      });
      expect(store.invalidate).toHaveBeenCalledWith(
        'dox_team',
        subtype === 'forbidden' ? 'team_context_forbidden' : 'team_context_missing',
      );
    },
  );

  it('rejects a mismatched document token as missing and invalidates the snapshot', async () => {
    const { source, store } = fixture({ fetched: document({ token: 'dox_other' }) });

    await expect(source.load()).resolves.toEqual({
      status: 'unavailable', errorCategory: 'team_context_unavailable',
    });
    expect(store.invalidate).toHaveBeenCalledWith('dox_team', 'team_context_missing');
  });

  it.each([8_000, 8_001])('enforces the independent complete-document budget at %s', async (count) => {
    const { source, store } = fixture({ estimatedTokens: count });
    const result = await source.load();

    if (count === 8_000) {
      expect(result.status).toBe('loaded');
      expect(store.accept).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({
        status: 'over_budget', errorCategory: 'team_context_over_budget',
      });
      expect(store.accept).not.toHaveBeenCalled();
    }
  });

  it('keeps a fresh last-known-good snapshot when the new revision is over budget', async () => {
    const { source } = fixture({
      estimatedTokens: 8_001,
      snapshot: {
        documentToken: 'dox_team', sourceRevision: 6, normalizedContent: '# Previous\n',
        estimatedTokens: 3, fetchedAt: new Date('2026-08-10T11:59:00Z'),
      },
    });

    await expect(source.load()).resolves.toMatchObject({
      status: 'over_budget', content: '# Previous\n', sourceRevision: 6,
      errorCategory: 'team_context_over_budget',
    });
  });

  it('keeps an older last-known-good snapshot for over-budget consolidation guidance', async () => {
    const { source } = fixture({
      estimatedTokens: 8_001,
      snapshot: {
        documentToken: 'dox_team', sourceRevision: 2, normalizedContent: '# Old accepted\n',
        estimatedTokens: 4, fetchedAt: new Date('2026-08-08T11:00:00Z'),
      },
    });

    await expect(source.load()).resolves.toMatchObject({
      status: 'over_budget', content: '# Old accepted\n', sourceRevision: 2,
      errorCategory: 'team_context_over_budget',
    });
  });

  it('prefers a newer concurrently accepted snapshot over an older fetched revision', async () => {
    const newer: TeamContextSnapshot = {
      documentToken: 'dox_team', sourceRevision: 8, normalizedContent: '# Newer\n',
      estimatedTokens: 3, fetchedAt: new Date('2026-08-10T12:00:01Z'),
    };
    const store: TeamContextStore = {
      load: vi.fn().mockResolvedValue(newer),
      accept: vi.fn().mockRejectedValue(new Error('team_context_snapshot_stale')),
      invalidate: vi.fn(),
    };
    const source = new DefaultTeamContextSource({
      documentToken: 'dox_team', tokenBudget: 8_000, staleMaxMs: 86_400_000,
      knowledge: {
        fetchDocument: vi.fn().mockResolvedValue(document()),
      } as unknown as KnowledgeService,
      store,
      now: () => new Date('2026-08-10T12:00:00Z'),
      estimateTokens: () => 12,
    });

    await expect(source.load()).resolves.toEqual({
      status: 'loaded', content: '# Newer\n', sourceRevision: 8,
      estimatedTokens: 3, fetchedAt: newer.fetchedAt,
    });
  });

  it('propagates cancellation instead of converting it into stale context', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const { source } = fixture({ fetchError: new LarkCliError('aborted') });

    await expect(source.load(controller.signal)).rejects.toThrow('cancelled');
  });

  it('re-reads and safely reapplies once when only the revision changed', async () => {
    const { source, patchDocument } = fixture();

    await expect(source.update({
      expectedRevision: 6, pattern: 'Conclusions first.', replacement: 'Sources first.',
      reason: 'correction', semanticChangeApproved: true,
    })).resolves.toMatchObject({ token: 'dox_team', revisionId: 8 });
    expect(patchDocument).toHaveBeenCalledWith({
      doc: 'dox_team', pattern: 'Conclusions first.', replacement: 'Sources first.',
      expectedRevision: 7,
    }, undefined);
  });

  it('reports a conflict when concurrent meaning changed the exact target', async () => {
    const { source, patchDocument } = fixture({
      fetched: document({ markdown: '# Team Context\n\n- A different decision.\n', revisionId: 8 }),
    });

    await expect(source.update({
      expectedRevision: 7, pattern: 'Conclusions first.', replacement: 'Sources first.',
      reason: 'correction', semanticChangeApproved: true,
    })).rejects.toBeInstanceOf(KnowledgeWriteConflict);
    expect(patchDocument).not.toHaveBeenCalled();
  });

  it.each([
    { stage: 'read', fetchError: new LarkCliError('cli_error', { subtype: 'forbidden' }) },
    { stage: 'write', patchError: new LarkCliError('cli_error', { subtype: 'not_found' }) },
  ])('invalidates immediately when update-time $stage loses authority', async (options) => {
    const { source, store } = fixture(options);

    await expect(source.update({
      expectedRevision: 7, pattern: 'Conclusions first.', replacement: 'Sources first.',
      reason: 'correction', semanticChangeApproved: true,
    })).rejects.toMatchObject({ code: 'team_context_unavailable' });
    expect(store.invalidate).toHaveBeenCalledWith(
      'dox_team',
      options.stage === 'read' ? 'team_context_forbidden' : 'team_context_missing',
    );
  });

  it('rejects an update whose complete proposed document exceeds the budget', async () => {
    const { source, patchDocument } = fixture({ estimatedTokens: 8_001 });

    await expect(source.update({
      expectedRevision: 7,
      pattern: 'Conclusions first.',
      replacement: 'A much larger durable rule.',
      reason: 'correction', semanticChangeApproved: true,
    })).rejects.toMatchObject({ code: 'team_context_over_budget' });
    expect(patchDocument).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'same bullet under a different heading',
      markdown: '# Team\n## A\n- Same\n## B\n- Same\n',
      pattern: '## B\n- Same',
      replacement: '## B',
    },
    {
      name: 'nested list changed into a top-level list',
      markdown: '# Team\n- Parent\n  - Child\n',
      pattern: '  - Child',
      replacement: '- Child',
    },
  ])('rejects mechanical cleanup when $name changes Markdown meaning', async ({
    markdown, pattern, replacement,
  }) => {
    const { source, patchDocument } = fixture({ fetched: document({ markdown }) });

    await expect(source.update({
      expectedRevision: 7,
      pattern,
      replacement,
      reason: 'mechanical_cleanup',
      semanticChangeApproved: false,
    })).rejects.toMatchObject({ code: 'team_context_semantic_approval_required' });
    expect(patchDocument).not.toHaveBeenCalled();
  });

  it('allows removing an exact duplicate in the same Markdown structure', async () => {
    const { source, patchDocument } = fixture({
      fetched: document({ markdown: '# Team\n## A\n- Same\n- Same\n' }),
    });

    await expect(source.update({
      expectedRevision: 7,
      pattern: '- Same\n- Same',
      replacement: '- Same',
      reason: 'mechanical_cleanup',
      semanticChangeApproved: false,
    })).resolves.toMatchObject({ revisionId: 8 });
    expect(patchDocument).toHaveBeenCalledOnce();
  });
});
