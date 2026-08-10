export type AgentReplyOutcome =
  | 'completed'
  | 'step_limit_reached'
  | 'timeout_reached'
  | 'interrupted_after_write';

export type AgentRunOutcome =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'step_limit_reached'
  | 'timeout_reached'
  | 'interrupted_after_write';

export type WriteAttemptReceipt = {
  toolName:
    | 'createDocument' | 'appendDocument' | 'patchDocument'
    | 'updateTeamContext'
    | 'createSchedule' | 'updateSchedule' | 'pauseSchedule' | 'resumeSchedule' | 'deleteSchedule';
  outcome: 'succeeded' | 'failed' | 'unknown';
  sanitizedSummary: string;
  targetIdentifiers: Record<string, string>;
  resultIdentifiers?: Record<string, string>;
  errorCategory?: string;
};

function singleLine(value: string, maximumLength = 240) {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
    .slice(0, maximumLength);
}

const DOCUMENT_HOST_SUFFIXES = ['feishu.cn', 'larksuite.com', 'larkoffice.com'] as const;
const DOCUMENT_PATH = /^\/(?:docx|docs|wiki)\/[A-Za-z0-9_-]+\/?$/u;

function supportedDocumentHost(hostname: string) {
  return DOCUMENT_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function safeUrl(value: string | undefined) {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || !supportedDocumentHost(url.hostname)
      || !DOCUMENT_PATH.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function writeAttemptLines(writeAttempts: WriteAttemptReceipt[]) {
  if (writeAttempts.length === 0) return ['本次运行没有已记录的写入尝试。'];
  return [
    '已记录的写入尝试：',
    ...writeAttempts.map((attempt) => {
      const status = {
        succeeded: '已确认成功',
        failed: '已确认失败',
        unknown: '结果未知',
      }[attempt.outcome];
      const summary = singleLine(attempt.sanitizedSummary) || '一项知识写入';
      const url = safeUrl(attempt.resultIdentifiers?.url);
      return `- ${status}：${summary}${url ? ` — ${url}` : ''}`;
    }),
  ];
}

export function budgetExhaustedText(
  reason: 'step_limit_reached' | 'timeout_reached',
  writeAttempts: WriteAttemptReceipt[],
): string {
  const limit = reason === 'step_limit_reached' ? '执行步数上限' : '执行时间上限';
  return [
    `本次执行已达到${limit}，现已停止。`,
    '为避免重复操作，我没有自动重放整个任务。',
    ...writeAttemptLines(writeAttempts),
    '如需继续，请回复“继续”；我会基于当前可见对话和这些写入记录重新检查现状后再决定下一步。',
  ].join('\n');
}

export function interruptedAfterWriteText(writeAttempts: WriteAttemptReceipt[]): string {
  return [
    '本次执行在写入开始后中断，现已停止。',
    '为避免重复操作，我没有自动重放整个任务。',
    ...writeAttemptLines(writeAttempts),
    '如需继续，请回复“继续”；我会基于当前可见对话和这些写入记录重新检查现状后再决定下一步。',
  ].join('\n');
}
