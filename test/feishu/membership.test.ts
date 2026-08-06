import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '../../src/contracts/messages.js';
import { MembershipPolicy } from '../../src/feishu/membership.js';

function message(chatType: 'group' | 'p2p', senderOpenId = 'ou_member'): NormalizedMessage {
  return {
    eventId: 'evt_1', messageId: 'om_1', chatId: chatType === 'group' ? 'oc_team' : 'oc_dm',
    conversationKey: chatType === 'group' ? 'oc_team:om_1' : 'oc_dm',
    ...(chatType === 'group' ? { rootId: 'om_1' } : {}),
    senderOpenId, chatType,
    content: { kind: 'text', text: 'hello', feishuLinks: [] },
    occurredAt: new Date('2026-08-05T00:00:00Z'),
  };
}

describe('MembershipPolicy', () => {
  it('allows only current members of configured groups', async () => {
    const listOpenIds = vi.fn(async () => new Set(['ou_member']));
    const policy = new MembershipPolicy({
      allowedChats: {
        isAllowed: vi.fn(async (chatId) => chatId === 'oc_team'),
        listAllowedChatIds: vi.fn(async () => ['oc_team']),
      },
      members: { listOpenIds },
    });

    await expect(policy.authorize(message('group'))).resolves.toEqual({ allowed: true });
    await expect(policy.authorize(message('group', 'ou_outsider'))).resolves
      .toEqual({ allowed: false, reason: 'not_team_member' });
    await expect(policy.authorize({ ...message('group'), chatId: 'oc_other' })).resolves
      .toEqual({ allowed: false, reason: 'chat_not_allowed' });
    expect(listOpenIds).toHaveBeenCalledTimes(1);
  });

  it('allows private chat only for a current member of an allowed group', async () => {
    const policy = new MembershipPolicy({
      allowedChats: {
        isAllowed: vi.fn(),
        listAllowedChatIds: vi.fn(async () => ['oc_team', 'oc_other']),
      },
      members: {
        listOpenIds: vi.fn(async (chatId) => new Set(
          chatId === 'oc_other' ? ['ou_member'] : ['ou_someone_else'],
        )),
      },
    });

    await expect(policy.authorize(message('p2p'))).resolves.toEqual({ allowed: true });
    await expect(policy.authorize(message('p2p', 'ou_outsider'))).resolves.toEqual({
      allowed: false, reason: 'not_team_member',
    });
  });

  it('refreshes cached membership after five minutes', async () => {
    let now = new Date('2026-08-05T00:00:00Z');
    const listOpenIds = vi.fn()
      .mockResolvedValueOnce(new Set(['ou_member']))
      .mockResolvedValueOnce(new Set<string>());
    const policy = new MembershipPolicy({
      allowedChats: {
        isAllowed: vi.fn(async () => true), listAllowedChatIds: vi.fn(async () => ['oc_team']),
      },
      members: { listOpenIds },
      now: () => now,
    });

    await expect(policy.authorize(message('p2p'))).resolves.toEqual({ allowed: true });
    now = new Date('2026-08-05T00:04:59.999Z');
    await expect(policy.authorize(message('p2p'))).resolves.toEqual({ allowed: true });
    expect(listOpenIds).toHaveBeenCalledTimes(1);

    now = new Date('2026-08-05T00:05:00.000Z');
    await expect(policy.authorize(message('p2p'))).resolves.toEqual({
      allowed: false, reason: 'not_team_member',
    });
    expect(listOpenIds).toHaveBeenCalledTimes(2);
  });

  it('fails closed when membership cannot be verified', async () => {
    const policy = new MembershipPolicy({
      allowedChats: {
        isAllowed: vi.fn(async () => true), listAllowedChatIds: vi.fn(async () => ['oc_team']),
      },
      members: { listOpenIds: vi.fn().mockRejectedValue(new Error('Bearer secret')) },
    });

    await expect(policy.authorize(message('p2p'))).resolves.toEqual({
      allowed: false, reason: 'membership_unavailable',
    });
    await expect(policy.authorize(message('group'))).resolves.toEqual({
      allowed: false, reason: 'membership_unavailable',
    });
  });
});
