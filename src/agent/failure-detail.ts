export const AGENT_FAILURE_DETAIL_CODE_POINT_LIMIT = 2_000;

export function agentFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'non_error_rejection';
  return [...error.message]
    .slice(0, AGENT_FAILURE_DETAIL_CODE_POINT_LIMIT)
    .join('');
}
