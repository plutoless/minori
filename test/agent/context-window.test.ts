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
});
