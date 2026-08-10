export type TeamContextStatus = 'loaded' | 'stale' | 'unavailable' | 'over_budget';

export type TeamContextSnapshot = {
  documentToken: string;
  sourceRevision: number;
  normalizedContent: string;
  estimatedTokens: number;
  fetchedAt: Date;
};

export type TeamContextInvalidationCategory =
  | 'team_context_missing'
  | 'team_context_forbidden';

export type TeamContextErrorCategory =
  | 'team_context_stale'
  | 'team_context_unavailable'
  | 'team_context_over_budget'
  | 'team_context_conflict';

export type TeamContextLoad = {
  status: TeamContextStatus;
  content?: string;
  sourceRevision?: number;
  estimatedTokens?: number;
  fetchedAt?: Date;
  errorCategory?: TeamContextErrorCategory;
};

