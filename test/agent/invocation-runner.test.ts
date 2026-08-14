import { describe, expect, it } from 'vitest';

import { buildScheduledInvocationPrompt } from '../../src/agent/invocation-runner.js';
import { TEAM_AGENT_INSTRUCTIONS } from '../../src/agent/instructions.js';

describe('Scheduled invocation envelope', () => {
  it('frames a due occurrence without turning recurrence wording into schedule authority', () => {
    const instruction = [
      '每天在下午 3:30（Asia/Shanghai）检索当天约下午 2:00 召开的日会会议记录。',
      '优先读取 AI 摘要。',
    ].join('\n');

    const prompt = buildScheduledInvocationPrompt({
      scheduledFor: new Date('2026-08-14T07:30:00.000Z'),
      instruction,
    });

    expect(prompt).toContain('2026-08-14T07:30:00.000Z');
    expect(prompt).toContain('execute this already-created Scheduled Task occurrence');
    expect(prompt).toContain('must not create or change Scheduled Tasks');
    expect(prompt).toContain('[Frozen Scheduled Task Instruction]');
    expect(prompt.match(/每天在下午 3:30/g)).toHaveLength(1);
    expect(prompt).toContain(instruction);
  });

  it('keeps the non-overridable schedule boundary in system instructions', () => {
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'A Current Invocation labeled Scheduled Task is an already-created occurrence to execute now.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'creating, updating, pausing, resuming, or deleting them always requires a new member-triggered Current Invocation',
    );
  });
});
