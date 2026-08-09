import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FeishuGroupContextSource } from '../../src/feishu/group-context.js';

const cutoff = new Date('2026-08-08T10:00:00.500Z');

type MockMessage = {
  message_id: string;
  msg_type: string;
  create_time: string;
  sender?: {
    id: string;
    id_type: string;
    sender_type: string;
    open_bot_id?: string;
  };
  body: { content: string };
  mentions?: Array<{ key: string; id: string; id_type: string; name: string }>;
};

function userMessage(
  messageId: string,
  senderId: string,
  occurredAt: string,
  text: string,
  messageType = 'text',
): MockMessage {
  return {
    message_id: messageId,
    msg_type: messageType,
    create_time: String(new Date(occurredAt).getTime()),
    sender: { id: senderId, id_type: 'open_id', sender_type: 'user' },
    body: { content: messageType === 'text' ? JSON.stringify({ text }) : text },
  };
}

function minoriMessage(messageId: string, occurredAt: string, text: string): MockMessage {
  return {
    message_id: messageId,
    msg_type: 'text',
    create_time: String(new Date(occurredAt).getTime()),
    sender: {
      id: 'cli_minori', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_minori',
    },
    body: { content: JSON.stringify({ text }) },
  };
}

function sdk() {
  return {
    im: { v1: {
      message: { reply: vi.fn(), get: vi.fn(), list: vi.fn() },
      messageReaction: { create: vi.fn(), delete: vi.fn() },
      chatMembers: { get: vi.fn() },
    } },
  };
}

function openReader(client: ReturnType<typeof sdk>, logger = pino({ level: 'silent' })) {
  return new FeishuGroupContextSource(client, logger).open({
    chatId: 'oc_team',
    cutoff,
    triggerMessageId: 'om_trigger',
    currentSenderOpenId: 'ou_current',
    botOpenId: 'ou_minori',
    botAppId: 'cli_minori',
  });
}

describe('FeishuGroupContextSource', () => {
  it('loads cutoff-safe initial history with current group names and typed omissions', async () => {
    const client = sdk();
    client.im.v1.message.list.mockResolvedValue({ data: {
      has_more: true,
      page_token: 'provider_page_2',
      items: [
        userMessage('om_later', 'ou_future', '2026-08-08T10:00:00.501Z', 'future body'),
        userMessage('om_trigger', 'ou_current', '2026-08-08T10:00:00.500Z', 'trigger body'),
        userMessage(
          'om_image', 'ou_external', '2026-08-08T09:59:59.000Z',
          JSON.stringify({ image_key: 'img_secret' }), 'image',
        ),
        minoriMessage('om_bot', '2026-08-08T09:59:58.000Z', 'noted'),
        userMessage('om_proposal', 'ou_zhang', '2026-08-08T09:59:57.000Z', 'proposal A'),
        userMessage('om_system', 'ou_system', '2026-08-08T09:59:56.000Z',
          JSON.stringify({ secret_body: 'excluded system body' }), 'system'),
      ],
    } });
    client.im.v1.chatMembers.get
      .mockResolvedValueOnce({ data: {
        has_more: true,
        page_token: 'members_2',
        items: [{ member_id_type: 'open_id', member_id: 'ou_zhang', name: '张三' }],
      } })
      .mockResolvedValueOnce({ data: {
        has_more: false,
        items: [{ member_id_type: 'open_id', member_id: 'ou_current', name: '李四' }],
      } });

    const initial = await openReader(client).loadInitial();

    expect(initial).toEqual({
      messages: [
        expect.objectContaining({ speakerName: '张三', role: 'user', content: 'proposal A' }),
        expect.objectContaining({ speakerName: 'Minori', role: 'assistant', content: 'noted' }),
        expect.objectContaining({
          speakerName: '姓名不可用的成员',
          role: 'user',
          content: '[未读取：image 消息]',
        }),
      ],
      currentSenderName: '李四',
      audit: {
        status: 'loaded',
        messageCount: 3,
        pageCallCount: 1,
        cutoff,
      },
    });
    expect(client.im.v1.message.list).toHaveBeenCalledWith({ params: {
      container_id_type: 'chat',
      container_id: 'oc_team',
      end_time: String(Math.floor(cutoff.getTime() / 1_000)),
      sort_type: 'ByCreateTimeDesc',
      page_size: 20,
    } });
    expect(client.im.v1.chatMembers.get).toHaveBeenNthCalledWith(1, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 50 },
    });
    expect(client.im.v1.chatMembers.get).toHaveBeenNthCalledWith(2, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 50, page_token: 'members_2' },
    });
    const returned = JSON.stringify(initial);
    expect(returned).not.toMatch(/ou_|img_secret|future body|trigger body|excluded system body/u);
  });

  it('pages older history only through invocation-local opaque cursors', async () => {
    const client = sdk();
    client.im.v1.message.list
      .mockResolvedValueOnce({ data: {
        has_more: true,
        page_token: 'provider_page_2',
        items: [userMessage('om_recent', 'ou_zhang', '2026-08-08T09:59:59.000Z', 'recent')],
      } })
      .mockResolvedValueOnce({ data: {
        has_more: true,
        page_token: 'provider_page_3',
        items: [userMessage('om_older', 'ou_zhang', '2026-08-08T09:00:00.000Z', 'older')],
      } })
      .mockResolvedValueOnce({ data: {
        has_more: false,
        items: [userMessage('om_oldest', 'ou_zhang', '2026-08-08T08:00:00.000Z', 'oldest')],
      } });
    client.im.v1.chatMembers.get.mockResolvedValue({ data: {
      has_more: false,
      items: [
        { member_id_type: 'open_id', member_id: 'ou_zhang', name: '张三' },
        { member_id_type: 'open_id', member_id: 'ou_current', name: '李四' },
      ],
    } });
    const reader = openReader(client);

    await reader.loadInitial();
    const earlier = await reader.readEarlier({ limit: 50 });
    expect(earlier).toMatchObject({
      messages: [expect.objectContaining({ speakerName: '张三', content: 'older' })],
      nextCursor: 'group_cursor_1',
      audit: { status: 'loaded', messageCount: 2, pageCallCount: 2 },
    });
    expect(client.im.v1.message.list).toHaveBeenNthCalledWith(2, { params: {
      container_id_type: 'chat',
      container_id: 'oc_team',
      end_time: String(Math.floor(cutoff.getTime() / 1_000)),
      sort_type: 'ByCreateTimeDesc',
      page_size: 50,
      page_token: 'provider_page_2',
    } });

    await expect(reader.readEarlier({ cursor: 'group_cursor_unknown', limit: 20 }))
      .rejects.toThrow('invalid_group_history_cursor');
    await expect(reader.readEarlier({ cursor: 'provider_page_3', limit: 20 }))
      .rejects.toThrow('invalid_group_history_cursor');
    await expect(reader.readEarlier({ cursor: 'group_cursor_1', limit: 51 }))
      .rejects.toThrow('invalid_group_history_limit');
    await expect(reader.readEarlier({ cursor: 'group_cursor_1', limit: 0 }))
      .rejects.toThrow('invalid_group_history_limit');
    await expect(reader.readEarlier({
      limit: 20,
      // @ts-expect-error Group and cutoff are fixed when the reader is opened.
      chatId: 'oc_other',
    })).rejects.toThrow('invalid_group_history_input');
    await expect(reader.readEarlier({
      limit: 20,
      // @ts-expect-error Group and cutoff are fixed when the reader is opened.
      cutoff: new Date('2027-01-01T00:00:00.000Z'),
    })).rejects.toThrow('invalid_group_history_input');

    await expect(reader.readEarlier({ cursor: 'group_cursor_1', limit: 20 }))
      .resolves.toMatchObject({
        messages: [expect.objectContaining({ content: 'oldest' })],
        audit: { status: 'loaded', messageCount: 3, pageCallCount: 3 },
      });
    expect(client.im.v1.message.list).toHaveBeenLastCalledWith({ params: {
      container_id_type: 'chat',
      container_id: 'oc_team',
      end_time: String(Math.floor(cutoff.getTime() / 1_000)),
      sort_type: 'ByCreateTimeDesc',
      page_size: 20,
      page_token: 'provider_page_3',
    } });
  });

  it('advances consecutive cursorless reads through unique older pages', async () => {
    const client = sdk();
    client.im.v1.message.list.mockImplementation(async ({ params }) => {
      if (params.page_token === undefined) {
        return { data: {
          has_more: true,
          page_token: 'provider_page_2',
          items: [userMessage(
            'om_recent', 'ou_zhang', '2026-08-08T09:59:59.000Z', 'recent',
          )],
        } };
      }
      if (params.page_token === 'provider_page_2') {
        return { data: {
          has_more: true,
          page_token: 'provider_page_3',
          items: [userMessage(
            'om_older', 'ou_zhang', '2026-08-08T09:00:00.000Z', 'older',
          )],
        } };
      }
      if (params.page_token === 'provider_page_3') {
        return { data: {
          has_more: false,
          items: [userMessage(
            'om_oldest', 'ou_zhang', '2026-08-08T08:00:00.000Z', 'oldest',
          )],
        } };
      }
      throw new Error('unexpected_provider_page');
    });
    client.im.v1.chatMembers.get.mockResolvedValue({ data: {
      has_more: false,
      items: [
        { member_id_type: 'open_id', member_id: 'ou_zhang', name: '张三' },
        { member_id_type: 'open_id', member_id: 'ou_current', name: '李四' },
      ],
    } });
    const reader = openReader(client);

    await reader.loadInitial();
    const first = await reader.readEarlier({ limit: 20 });
    const second = await reader.readEarlier({ limit: 20 });

    expect(first).toMatchObject({
      messages: [expect.objectContaining({ content: 'older' })],
      audit: { messageCount: 2, pageCallCount: 2 },
    });
    expect(second).toMatchObject({
      messages: [expect.objectContaining({ content: 'oldest' })],
      audit: { messageCount: 3, pageCallCount: 3 },
    });
    expect(client.im.v1.message.list).toHaveBeenLastCalledWith({ params: {
      container_id_type: 'chat',
      container_id: 'oc_team',
      end_time: String(Math.floor(cutoff.getTime() / 1_000)),
      sort_type: 'ByCreateTimeDesc',
      page_size: 20,
      page_token: 'provider_page_3',
    } });
  });

  it('keeps other bot output as non-Minori background', async () => {
    const client = sdk();
    client.im.v1.message.list.mockResolvedValue({ data: {
      has_more: false,
      items: [{
        ...minoriMessage('om_other_bot', '2026-08-08T09:59:58.000Z', 'other output'),
        sender: {
          id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other',
        },
      }],
    } });
    client.im.v1.chatMembers.get.mockResolvedValue({ data: {
      has_more: false,
      items: [{ member_id_type: 'open_id', member_id: 'ou_current', name: '李四' }],
    } });

    await expect(openReader(client).loadInitial()).resolves.toMatchObject({
      messages: [{ speakerName: '其他机器人', role: 'user', content: 'other output' }],
    });
  });

  it('degrades message-list failures to a stable model-safe category', async () => {
    const warnings: unknown[] = [];
    const logger = pino({ level: 'silent' });
    logger.warn = vi.fn((...details: unknown[]) => { warnings.push(details); }) as typeof logger.warn;
    const client = sdk();
    client.im.v1.message.list.mockRejectedValue(new Error('provider Bearer secret ou_hidden'));
    client.im.v1.chatMembers.get.mockResolvedValue({ data: {
      has_more: false,
      items: [{ member_id_type: 'open_id', member_id: 'ou_current', name: '李四' }],
    } });

    await expect(openReader(client, logger).loadInitial()).resolves.toEqual({
      messages: [],
      currentSenderName: '李四',
      audit: {
        status: 'unavailable',
        messageCount: 0,
        pageCallCount: 1,
        cutoff,
        errorCategory: 'group_history_unavailable',
      },
    });
    expect(JSON.stringify(warnings)).toBe(
      '[[{"errorCode":"group_history_unavailable"},"group history unavailable"]]',
    );
  });

  it('keeps history when member names are unavailable and sanitizes the failure', async () => {
    const warnings: unknown[] = [];
    const logger = pino({ level: 'silent' });
    logger.warn = vi.fn((...details: unknown[]) => { warnings.push(details); }) as typeof logger.warn;
    const client = sdk();
    client.im.v1.message.list.mockResolvedValue({ data: {
      has_more: false,
      items: [userMessage('om_recent', 'ou_zhang', '2026-08-08T09:59:59.000Z', 'proposal')],
    } });
    client.im.v1.chatMembers.get.mockRejectedValue(new Error('raw API failure ou_hidden'));

    const result = await openReader(client, logger).loadInitial();
    expect(result).toEqual({
      messages: [{
        speakerName: '姓名不可用的成员',
        role: 'user',
        content: 'proposal',
        occurredAt: new Date('2026-08-08T09:59:59.000Z'),
      }],
      currentSenderName: '姓名不可用的成员',
      audit: {
        status: 'loaded',
        messageCount: 1,
        pageCallCount: 1,
        cutoff,
        errorCategory: 'group_member_names_unavailable',
      },
    });
    expect(JSON.stringify(result)).not.toContain('ou_');
    expect(JSON.stringify(warnings)).toBe(
      '[[{"errorCode":"group_member_names_unavailable"},"group member names unavailable"]]',
    );
  });

  it('honors an already-aborted invocation without making provider calls', async () => {
    const client = sdk();
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(openReader(client).loadInitial(controller.signal)).rejects.toThrow('stop');
    expect(client.im.v1.message.list).not.toHaveBeenCalled();
    expect(client.im.v1.chatMembers.get).not.toHaveBeenCalled();
  });
});
