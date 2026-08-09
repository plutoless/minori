import { describe, expect, it } from 'vitest';
import { selectRecentHistory } from '../../src/agent/context-window.js';

describe('selectRecentHistory', () => {
  it('keeps the newest complete messages within the soft token target', () => {
    const history = [
      { role: 'user' as const, content: 'old detail' },
      { role: 'assistant' as const, content: 'middle answer' },
      { role: 'user' as const, content: 'current question' },
    ];

    expect(selectRecentHistory(history, 8, () => 4)).toEqual(history.slice(1));
  });

  it('keeps at least the newest message when it alone exceeds the target', () => {
    const newest = { role: 'user' as const, content: 'a very large current prompt' };
    expect(selectRecentHistory([newest], 1, () => 100)).toEqual([newest]);
  });

  it('always retains Current Invocation and prefers the newest large prior messages', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: 'user' as const,
      content: `[Live Group History][Member ${index}] ${'x'.repeat(5_000)}`,
    }));
    const currentInvocation = {
      role: 'user' as const,
      content: '[Current Invocation][Carol] summarize above',
    };

    expect(selectRecentHistory([...history, currentInvocation], 2_600)).toEqual([
      history[18],
      history[19],
      currentInvocation,
    ]);
  });
});
