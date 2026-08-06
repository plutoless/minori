import { describe, expect, it } from 'vitest';
import { normalizeMessageEvent } from '../../src/feishu/normalize-event.js';

const BOT_OPEN_ID = 'ou_minori';

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt_1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_team',
      chat_type: 'group',
      message_type: 'text',
      create_time: '1785888000000',
      content: JSON.stringify({ text: '@_user_1 show the roadmap' }),
      mentions: [{
        key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori',
      }],
    },
    ...overrides,
  };
}

describe('normalizeMessageEvent', () => {
  it('normalizes a direct group mention and removes only the activation mention', () => {
    expect(normalizeMessageEvent(event(), { botOpenId: BOT_OPEN_ID })).toEqual({
      eventId: 'evt_1',
      messageId: 'om_1',
      chatId: 'oc_team',
      conversationKey: 'oc_team:om_1',
      rootId: 'om_1',
      senderOpenId: 'ou_member',
      chatType: 'group',
      content: { kind: 'text', text: 'show the roadmap', feishuLinks: [] },
      occurredAt: new Date('2026-08-05T00:00:00.000Z'),
    });
  });

  it('normalizes visible rich text, code, and Feishu document links', () => {
    const rich = event({
      message: {
        message_id: 'om_post', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'post', create_time: '1785888000000',
        root_id: 'om_root',
        content: JSON.stringify({
          title: 'Release notes',
          content: [[
            { tag: 'at', user_id: '@_user_1', user_name: 'Minori' },
            { tag: 'at', user_id: BOT_OPEN_ID, user_name: 'Minori' },
            { tag: 'at', user_id: '@_user_2', user_name: 'Ada' },
            { tag: 'text', text: ' review ' },
            { tag: 'a', text: 'the plan', href: 'https://acme.feishu.cn/docx/doxcnPlan' },
            { tag: 'a', text: 'external', href: 'https://evil.example/docx/not-feishu' },
            { tag: 'code_block', language: 'ts', text: 'const ready = true;' },
          ]],
        }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      },
    });

    expect(normalizeMessageEvent(rich, { botOpenId: BOT_OPEN_ID })).toMatchObject({
      messageId: 'om_post',
      rootId: 'om_root',
      conversationKey: 'oc_team:om_root',
      content: {
        kind: 'text',
        text: 'Release notes\n@Ada review the planexternal\n```ts\nconst ready = true;\n```',
        feishuLinks: ['https://acme.feishu.cn/docx/doxcnPlan'],
      },
    });
  });

  it('accepts every valid private message and keys the conversation by chat', () => {
    const privateEvent = event({
      message: {
        message_id: 'om_private', chat_id: 'oc_private', chat_type: 'p2p',
        message_type: 'text', create_time: '1785888000000',
        content: JSON.stringify({ text: 'hello' }),
      },
    });

    expect(normalizeMessageEvent(privateEvent, { botOpenId: BOT_OPEN_ID })).toMatchObject({
      chatType: 'p2p', conversationKey: 'oc_private',
      content: { kind: 'text', text: 'hello', feishuLinks: [] },
    });
  });

  it('accepts replies to Minori and continuations in an already activated thread', () => {
    const reply = event({
      message: {
        message_id: 'om_reply', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888000000',
        root_id: 'om_root', parent_id: 'om_bot', content: JSON.stringify({ text: 'continue' }),
      },
    });
    const continuation = event({
      message: {
        message_id: 'om_next', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888000000',
        root_id: 'om_root', parent_id: 'om_reply', content: JSON.stringify({ text: 'and this' }),
      },
    });

    expect(normalizeMessageEvent(reply, {
      botOpenId: BOT_OPEN_ID, repliedToBot: true,
    })?.conversationKey).toBe('oc_team:om_root');
    expect(normalizeMessageEvent(continuation, {
      botOpenId: BOT_OPEN_ID, knownAgentThread: true,
    })?.conversationKey).toBe('oc_team:om_root');
  });

  it('ignores unrelated group timeline traffic', () => {
    const unrelated = event({
      message: {
        message_id: 'om_noise', chat_id: 'oc_team', chat_type: 'group',
        message_type: 'text', create_time: '1785888000000',
        content: JSON.stringify({ text: 'ordinary team chat' }),
      },
    });

    expect(normalizeMessageEvent(unrelated, { botOpenId: BOT_OPEN_ID })).toBeNull();
  });

  it.each(['image', 'audio', 'media', 'file']) (
    'keeps a triggered %s-only event as explicitly unsupported',
    (messageType) => {
      const unsupported = event({
        message: {
          message_id: `om_${messageType}`, chat_id: 'oc_team', chat_type: 'group',
          message_type: messageType, create_time: '1785888000000',
          content: '{}',
          mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
        },
      });

      expect(normalizeMessageEvent(unsupported, { botOpenId: BOT_OPEN_ID })?.content)
        .toEqual({ kind: 'unsupported', sourceMessageType: messageType });
    },
  );

  it('returns null for malformed content, missing sender, bots, and unknown types', () => {
    expect(normalizeMessageEvent(event({
      message: { ...(event().message as object), content: '{broken' },
    }), { botOpenId: BOT_OPEN_ID })).toBeNull();
    expect(normalizeMessageEvent(event({ sender: { sender_type: 'user' } }), {
      botOpenId: BOT_OPEN_ID,
    })).toBeNull();
    expect(normalizeMessageEvent(event({
      sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
    }), { botOpenId: BOT_OPEN_ID })).toBeNull();
    expect(normalizeMessageEvent(event({
      message: { ...(event().message as object), message_type: 'sticker' },
    }), { botOpenId: BOT_OPEN_ID })).toBeNull();
  });
});
