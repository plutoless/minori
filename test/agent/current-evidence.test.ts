import { describe, expect, it } from 'vitest';
import { TEAM_AGENT_INSTRUCTIONS } from '../../src/agent/instructions.js';

describe('current evidence instructions', () => {
  it('keeps historical and member-provided facts from becoming unverified live claims', () => {
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'Do not present historical content as a live result from the current run.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'For claims about the current or latest state, permissions, versions, or read failures, use evidence actually obtained in this run or clearly say the claim was not verified live.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'Preserve cache, timestamp, and as-of qualifiers; never make evidence sound fresher than it is.',
    );
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      'You may use a member statement as input, but unless a tool verifies it, attribute it to the member rather than claiming independent confirmation.',
    );
  });

  it('does not turn the evidence rule into a routed conversation flow', () => {
    expect(TEAM_AGENT_INSTRUCTIONS).toContain(
      "Use tools when they help complete the member's request; there is no required workflow.",
    );
    expect(TEAM_AGENT_INSTRUCTIONS).not.toMatch(
      /intent classifier|always call a tool|mandatory search sequence|response validator/iu,
    );
  });
});
