import { describe, expect, it } from 'vitest';
import { agentFailureDetail } from '../../src/agent/failure-detail.js';

describe('agentFailureDetail', () => {
  it('keeps an Error message and truncates by Unicode code point', () => {
    const message = `${'🧪'.repeat(2_000)}tail`;
    const detail = agentFailureDetail(new Error(message));

    expect([...detail]).toHaveLength(2_000);
    expect(detail).toBe('🧪'.repeat(2_000));
  });

  it.each([undefined, null, 'Bearer secret', 42, { token: 'secret' }])(
    'maps a non-Error rejection to a stable value without serialization',
    (rejection) => {
      const detail = agentFailureDetail(rejection);

      expect(detail).toBe('non_error_rejection');
      expect(detail).not.toMatch(/Bearer|secret|token/iu);
    },
  );

  it('retains an empty Error message as an empty bounded diagnostic', () => {
    expect(agentFailureDetail(new Error(''))).toBe('');
  });
});
