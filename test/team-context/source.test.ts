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
  const patchDocument = vi.fn(async () => ({
    operation: 'patch' as const,
    token: 'dox_team', title: 'Team Context',
    url: 'https://acme.feishu.cn/docx/dox_team', revisionId: 8,
  }));
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

  it('propagates cancellation instead of converting it into stale context', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const { source } = fixture({ fetchError: new LarkCliError('aborted') });

    await expect(source.load(controller.signal)).rejects.toThrow('cancelled');
  });

  it('requires the expected configured revision before a narrow patch', async () => {
    const { source, patchDocument } = fixture();

    await expect(source.update({
      expectedRevision: 6, pattern: 'Conclusions first.', replacement: 'Sources first.',
      semanticChangeApproved: true,
    })).rejects.toBeInstanceOf(KnowledgeWriteConflict);
    expect(patchDocument).not.toHaveBeenCalled();

    await expect(source.update({
      expectedRevision: 7, pattern: 'Conclusions first.', replacement: 'Sources first.',
      semanticChangeApproved: true,
    })).resolves.toMatchObject({ token: 'dox_team', revisionId: 8 });
    expect(patchDocument).toHaveBeenCalledWith({
      doc: 'dox_team', pattern: 'Conclusions first.', replacement: 'Sources first.',
      expectedRevision: 7,
    }, undefined);
  });

  it('rejects an update whose complete proposed document exceeds the budget', async () => {
    const { source, patchDocument } = fixture({ estimatedTokens: 8_001 });

    await expect(source.update({
      expectedRevision: 7,
      pattern: 'Conclusions first.',
      replacement: 'A much larger durable rule.',
      semanticChangeApproved: true,
    })).rejects.toMatchObject({ code: 'team_context_over_budget' });
    expect(patchDocument).not.toHaveBeenCalled();
  });
});
