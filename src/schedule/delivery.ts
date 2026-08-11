import type { ScheduledResultMessenger } from '../feishu/client.js';
import type { ScheduledRun, ScheduledTask } from './types.js';

function singleLine(value: string, max = 120) {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function scheduledFailureNotice(
  task: ScheduledTask,
  run: ScheduledRun,
  category: string,
): string {
  return [
    `定时任务“${singleLine(task.name)}”未能送达。`,
    `目标：${singleLine(run.resultTarget.displayName)}`,
    `计划时间：${run.scheduledFor.toISOString()}`,
    `状态：${singleLine(category, 80)}`,
  ].join('\n');
}

export async function deliverScheduledText(
  messenger: ScheduledResultMessenger,
  chatId: string,
  text: string,
  idempotencyKey: string,
) {
  return messenger.sendText(chatId, text, idempotencyKey);
}
