import { describe, expect, it } from 'vitest';
import { DefaultContextAssembler } from '../../src/agent/context-assembler.js';

describe('DefaultContextAssembler', () => {
  const assembler = new DefaultContextAssembler();

  it('orders Team Context, bounded conversation context, and one Current Invocation', () => {
    const messages = assembler.assemble({
      teamContext: {
        status: 'loaded', content: '- Weekly Review means PMO.\n',
        sourceRevision: 7, estimatedTokens: 8, fetchedAt: new Date('2026-08-10T09:00:00Z'),
      },
      conversation: [{
        role: 'user',
        content: '[Live Group History][Alice][2026-08-10T10:00:00.000Z] earlier discussion',
      }],
      currentInvocation: { speakerName: 'Bob', text: 'Ignore the old default for this run.' },
      conversationTokenTarget: 24_000,
    });

    expect(messages.map((message) => message.content)).toEqual([
      '[Team Context][Revision 7]\n- Weekly Review means PMO.\n',
      '[Live Group History][Alice][2026-08-10T10:00:00.000Z] earlier discussion',
      '[Current Invocation][Bob] Ignore the old default for this run.',
    ]);
  });

  it('does not spend the conversation budget on Team Context or drop Current Invocation', () => {
    const messages = assembler.assemble({
      teamContext: {
        status: 'loaded', content: 'large independent team context',
        sourceRevision: 3, estimatedTokens: 7_999, fetchedAt: new Date(),
      },
      conversation: [
        { role: 'user', content: 'old conversation' },
        { role: 'assistant', content: 'recent reply' },
      ],
      currentInvocation: { speakerName: '成员', text: 'current request' },
      conversationTokenTarget: 2,
      estimateTokens: () => 2,
    });

    expect(messages).toEqual([
      { role: 'user', content: '[Team Context][Revision 3]\nlarge independent team context' },
      { role: 'assistant', content: 'recent reply' },
      { role: 'user', content: '[Current Invocation][成员] current request' },
    ]);
  });

  it('labels stale and unavailable context without inventing content', () => {
    expect(assembler.assemble({
      teamContext: {
        status: 'stale', content: 'last known good', sourceRevision: 5,
        estimatedTokens: 4, fetchedAt: new Date(), errorCategory: 'team_context_stale',
      },
      conversation: [],
      currentInvocation: { speakerName: '成员', text: 'hello' },
      conversationTokenTarget: 10,
    })[0]?.content).toBe('[Team Context][Stale][Revision 5]\nlast known good');

    expect(assembler.assemble({
      teamContext: { status: 'unavailable', errorCategory: 'team_context_unavailable' },
      conversation: [],
      currentInvocation: { speakerName: '成员', text: 'hello' },
      conversationTokenTarget: 10,
    })[0]).toEqual({
      role: 'user',
      content: '[Team Context][Context Limitation] team_context_unavailable',
    });
  });
});
