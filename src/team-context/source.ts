import { KnowledgeWriteConflict, LarkCliError } from '../lark/errors.js';
import type { KnowledgeService, KnowledgeWriteResult } from '../lark/knowledge-service.js';
import { estimateConversationTokens } from '../storage/conversation-store.js';
import type { TeamContextStore } from '../storage/team-context-store.js';
import type {
  TeamContextInvalidationCategory,
  TeamContextLoad,
  TeamContextSnapshot,
} from './types.js';

export interface TeamContextSource {
  readonly documentToken: string;
  load(signal?: AbortSignal): Promise<TeamContextLoad>;
  update(input: {
    expectedRevision: number;
    pattern: string;
    replacement: string;
    semanticChangeApproved: boolean;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult>;
}

export type TeamContextSourceOptions = {
  documentToken: string;
  tokenBudget: number;
  staleMaxMs: number;
  knowledge: KnowledgeService;
  store: TeamContextStore;
  now?: () => Date;
  estimateTokens?: (text: string) => number;
};

export class TeamContextUpdateError extends Error {
  constructor(
    public readonly code: 'team_context_over_budget' | 'team_context_conflict',
  ) {
    super(code);
    this.name = 'TeamContextUpdateError';
  }
}

class TeamContextInvalid extends Error {
  constructor(public readonly category: TeamContextInvalidationCategory) {
    super(category);
    this.name = 'TeamContextInvalid';
  }
}

export function normalizeTeamContext(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .trim();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

function invalidationFor(error: unknown): TeamContextInvalidationCategory | undefined {
  if (error instanceof TeamContextInvalid) return error.category;
  if (!(error instanceof LarkCliError) || error.code !== 'cli_error') return undefined;
  const details = `${error.details.type ?? ''} ${error.details.subtype ?? ''}`;
  if (/forbidden|permission|access[_ -]?denied/iu.test(details)) return 'team_context_forbidden';
  if (/not[_ -]?found|missing/iu.test(details)) return 'team_context_missing';
  return undefined;
}

function isTemporary(error: unknown): boolean {
  if (!(error instanceof LarkCliError)) return false;
  if (error.code === 'timeout' || error.code === 'spawn_failed') return true;
  if (error.code !== 'cli_error') return false;
  return /rate|temporary|unavailable|timeout|busy/iu.test(
    `${error.details.type ?? ''} ${error.details.subtype ?? ''}`,
  );
}

function replaceExactlyOnce(content: string, pattern: string, replacement: string): string {
  const first = content.indexOf(pattern);
  if (first === -1 || content.indexOf(pattern, first + pattern.length) !== -1) {
    throw new KnowledgeWriteConflict();
  }
  return content.slice(0, first) + replacement + content.slice(first + pattern.length);
}

export class DefaultTeamContextSource implements TeamContextSource {
  private readonly now: () => Date;
  private readonly estimateTokens: (text: string) => number;

  constructor(private readonly options: TeamContextSourceOptions) {
    this.now = options.now ?? (() => new Date());
    this.estimateTokens = options.estimateTokens ?? estimateConversationTokens;
  }

  get documentToken(): string {
    return this.options.documentToken;
  }

  private async fallback(
    status: 'stale' | 'over_budget' | 'unavailable',
  ): Promise<TeamContextLoad> {
    const snapshot = await this.options.store.load(this.options.documentToken);
    if (snapshot && this.now().getTime() - snapshot.fetchedAt.getTime() <= this.options.staleMaxMs) {
      return {
        status,
        content: snapshot.normalizedContent,
        sourceRevision: snapshot.sourceRevision,
        estimatedTokens: snapshot.estimatedTokens,
        fetchedAt: snapshot.fetchedAt,
        errorCategory: status === 'over_budget'
          ? 'team_context_over_budget'
          : 'team_context_stale',
      };
    }
    return {
      status: status === 'over_budget' ? 'over_budget' : 'unavailable',
      errorCategory: status === 'over_budget'
        ? 'team_context_over_budget'
        : 'team_context_unavailable',
    };
  }

  async load(signal?: AbortSignal): Promise<TeamContextLoad> {
    try {
      signal?.throwIfAborted();
      const document = await this.options.knowledge.fetchDocument({
        doc: this.options.documentToken,
      }, signal);
      if (document.token !== this.options.documentToken) {
        throw new TeamContextInvalid('team_context_missing');
      }
      const content = normalizeTeamContext(document.markdown);
      const estimatedTokens = this.estimateTokens(content);
      if (estimatedTokens > this.options.tokenBudget) return this.fallback('over_budget');
      const snapshot: TeamContextSnapshot = {
        documentToken: document.token,
        sourceRevision: document.revisionId,
        normalizedContent: content,
        estimatedTokens,
        fetchedAt: this.now(),
      };
      await this.options.store.accept(snapshot);
      return {
        status: 'loaded',
        content,
        sourceRevision: snapshot.sourceRevision,
        estimatedTokens,
        fetchedAt: snapshot.fetchedAt,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const invalidation = invalidationFor(error);
      if (invalidation) {
        await this.options.store.invalidate(this.options.documentToken, invalidation);
        return { status: 'unavailable', errorCategory: 'team_context_unavailable' };
      }
      if (isTemporary(error)) return this.fallback('stale');
      return { status: 'unavailable', errorCategory: 'team_context_unavailable' };
    }
  }

  async update(input: {
    expectedRevision: number;
    pattern: string;
    replacement: string;
    semanticChangeApproved: boolean;
  }, signal?: AbortSignal): Promise<KnowledgeWriteResult> {
    signal?.throwIfAborted();
    const current = await this.options.knowledge.fetchDocument({
      doc: this.options.documentToken,
    }, signal);
    if (current.token !== this.options.documentToken) {
      throw new TeamContextUpdateError('team_context_conflict');
    }
    if (current.revisionId !== input.expectedRevision) throw new KnowledgeWriteConflict();
    const proposed = normalizeTeamContext(replaceExactlyOnce(
      current.markdown,
      input.pattern,
      input.replacement,
    ));
    if (this.estimateTokens(proposed) > this.options.tokenBudget) {
      throw new TeamContextUpdateError('team_context_over_budget');
    }
    try {
      return await this.options.knowledge.patchDocument({
        doc: this.options.documentToken,
        pattern: input.pattern,
        replacement: input.replacement,
        expectedRevision: input.expectedRevision,
      }, signal);
    } catch (error) {
      if (error instanceof KnowledgeWriteConflict) throw error;
      throw error;
    }
  }
}
