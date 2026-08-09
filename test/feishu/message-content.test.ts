import { describe, expect, it } from 'vitest';
import { parseFeishuMessageContent } from '../../src/feishu/message-content.js';

const BOT_OPEN_ID = 'ou_minori';

describe('parseFeishuMessageContent', () => {
  it('renders text without exposing hidden resource data', () => {
    expect(parseFeishuMessageContent({
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'decision alpha' }),
      botOpenId: BOT_OPEN_ID,
      botMentionKeys: [],
    })).toEqual({ kind: 'text', text: 'decision alpha', feishuLinks: [] });

    expect(parseFeishuMessageContent({
      messageType: 'image',
      rawContent: JSON.stringify({ image_key: 'img_secret' }),
      botOpenId: BOT_OPEN_ID,
      botMentionKeys: [],
    })).toEqual({ kind: 'omitted', sourceMessageType: 'image' });
  });

  it('renders rich text, strips Minori mentions, and keeps only Feishu document links', () => {
    expect(parseFeishuMessageContent({
      messageType: 'post',
      rawContent: JSON.stringify({
        title: 'Release notes',
        content: [[
          { tag: 'at', user_id: '@_minori', user_name: 'Minori' },
          { tag: 'at', user_id: 'ou_ada', user_name: 'Ada' },
          { tag: 'text', text: ' review ' },
          { tag: 'a', text: 'the plan', href: 'https://acme.feishu.cn/docx/doxcnPlan' },
          { tag: 'a', text: 'external', href: 'https://evil.example/not-feishu' },
          { tag: 'code_block', language: 'ts', text: 'const ready = true;' },
        ]],
      }),
      botOpenId: BOT_OPEN_ID,
      botMentionKeys: ['@_minori'],
    })).toEqual({
      kind: 'text',
      text: 'Release notes\n@Ada review the planexternal\n```ts\nconst ready = true;\n```',
      feishuLinks: ['https://acme.feishu.cn/docx/doxcnPlan'],
    });
  });

  it('rejects malformed text and rich text content', () => {
    expect(parseFeishuMessageContent({
      messageType: 'text', rawContent: '{broken', botOpenId: BOT_OPEN_ID, botMentionKeys: [],
    })).toBeNull();
    expect(parseFeishuMessageContent({
      messageType: 'post', rawContent: '{}', botOpenId: BOT_OPEN_ID, botMentionKeys: [],
    })).toBeNull();
  });
});
