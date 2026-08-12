export type LarkCliErrorCode =
  | 'aborted'
  | 'cli_error'
  | 'invalid_envelope'
  | 'malformed_json'
  | 'output_limit'
  | 'spawn_failed'
  | 'timeout';

export type LarkCliErrorDetails = {
  exitCode?: number | null;
  type?: string;
  subtype?: string;
  upstreamCode?: string | number;
};

export class LarkCliError extends Error {
  constructor(
    public readonly code: LarkCliErrorCode,
    public readonly details: LarkCliErrorDetails = {},
  ) {
    super(code);
    this.name = 'LarkCliError';
  }

  static fromEnvelope(
    error: {
      type?: string | undefined;
      subtype?: string | undefined;
      code?: string | number | undefined;
    },
    exitCode: number | null,
  ) {
    return new LarkCliError('cli_error', {
      exitCode,
      ...(error.type ? { type: error.type } : {}),
      ...(error.subtype ? { subtype: error.subtype } : {}),
      ...(error.code !== undefined ? { upstreamCode: error.code } : {}),
    });
  }
}

export class LarkContractError extends Error {
  readonly code = 'contract_error' as const;

  constructor() {
    super('contract_error');
    this.name = 'LarkContractError';
  }
}

export class KnowledgeSearchContractError extends Error {
  readonly code = 'knowledge_search_contract_error' as const;

  constructor(readonly completeness: {
    rawCount: number;
    validCount: 0;
    omittedCount: number;
  }) {
    super('knowledge_search_contract_error');
    this.name = 'KnowledgeSearchContractError';
  }
}

export class MeetingContractError extends Error {
  readonly code = 'meeting_contract_error' as const;

  constructor(readonly completeness: {
    rawCount: number;
    validCount: number;
    omittedCount: number;
  }) {
    super('meeting_contract_error');
    this.name = 'MeetingContractError';
  }
}

export class MeetingArtifactError extends Error {
  readonly code = 'meeting_artifact_unsafe' as const;

  constructor() {
    super('meeting_artifact_unsafe');
    this.name = 'MeetingArtifactError';
  }
}

export class MeetingContentError extends Error {
  constructor(
    readonly code: 'meeting_content_unavailable' | 'meeting_transcript_unavailable',
  ) {
    super(code);
    this.name = 'MeetingContentError';
  }
}

export class KnowledgeWriteConflict extends Error {
  readonly code = 'knowledge_write_conflict' as const;

  constructor() {
    super('knowledge_write_conflict');
    this.name = 'KnowledgeWriteConflict';
  }
}
