import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FeishuClientAdapter } from '../../src/feishu/client.js';

function sdk() {
  return {
    im: { v1: {
      message: { create: vi.fn(), reply: vi.fn(), get: vi.fn() },
      messageReaction: { create: vi.fn(), delete: vi.fn() },
    } },
  };
}

describe('FeishuClientAdapter', () => {
  it('sends a scheduled result as a top-level chat message without reply or reaction', async () => {
    const client = sdk();
    client.im.v1.message.create.mockResolvedValue({ data: { message_id: 'om_scheduled' } });
    const adapter = new FeishuClientAdapter(client, pino({ level: 'silent' }));
    await expect(adapter.sendText('oc_target', 'result', 'sched_123:result')).resolves
      .toBe('om_scheduled');
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      data: { receive_id: 'oc_target', msg_type: 'text', content: '{"text":"result"}', uuid: 'sched_123:result' },
      params: { receive_id_type: 'chat_id' },
    });
    expect(client.im.v1.message.reply).not.toHaveBeenCalled();
    expect(client.im.v1.messageReaction.create).not.toHaveBeenCalled();
  });
  it('replies with a deterministic bounded UUID', async () => {
    const client = sdk();
    client.im.v1.message.reply.mockResolvedValue({ data: { message_id: 'om_reply' } });
    const adapter = new FeishuClientAdapter(client, pino({ level: 'silent' }));

    await expect(adapter.replyText('om_trigger', 'hello', 'evt_1:reply:v1')).resolves
      .toBe('om_reply');
    expect(client.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_trigger' },
      data: {
        content: JSON.stringify({ text: 'hello' }), msg_type: 'text',
        reply_in_thread: false, uuid: 'evt_1:reply:v1',
      },
    });
    await expect(adapter.replyText('om_trigger', 'hello', 'x'.repeat(51))).rejects
      .toThrow('invalid_reply_idempotency_key');
  });

  it('replies with one ordinary non-topic Markdown post and exact idempotency key', async () => {
    const client = sdk();
    client.im.v1.message.reply.mockResolvedValue({ data: { message_id: 'om_rich' } });
    const adapter = new FeishuClientAdapter(client, pino({ level: 'silent' }));

    await expect(adapter.replyRichContent(
      'om_trigger',
      '# Result\n\n[1] Source — https://example.com',
      'evt_1:reply:v1',
    )).resolves.toBe('om_rich');

    expect(client.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_trigger' },
      data: {
        content: expect.any(String),
        msg_type: 'post',
        reply_in_thread: false,
        uuid: 'evt_1:reply:v1',
      },
    });
    const payload = JSON.parse(client.im.v1.message.reply.mock.calls[0]![0].data.content);
    expect(payload.zh_cn.content).toEqual([[{
      tag: 'md',
      text: '# Result\n\n[1] Source — https://example.com',
    }]]);
  });

  it('sends a Scheduled result as a top-level Markdown post', async () => {
    const client = sdk();
    client.im.v1.message.create.mockResolvedValue({ data: { message_id: 'om_scheduled' } });
    const adapter = new FeishuClientAdapter(client, pino({ level: 'silent' }));

    await expect(adapter.sendRichContent('oc_target', '**Done**', 'sched_1:result'))
      .resolves.toBe('om_scheduled');
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_target',
        msg_type: 'post',
        content: expect.any(String),
        uuid: 'sched_1:result',
      },
    });
    expect(JSON.parse(client.im.v1.message.create.mock.calls[0]![0].data.content))
      .toEqual({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**Done**' }]] } });
  });

  it('identifies whether a replied-to message was sent by the bot', async () => {
    const client = sdk();
    client.im.v1.message.get
      .mockResolvedValueOnce({ data: { items: [{ sender: {
        sender_type: 'app', id_type: 'app_id', id: 'cli_minori', open_bot_id: 'ou_minori',
      } }] } })
      .mockResolvedValueOnce({ data: { items: [{ sender: {
        sender_type: 'app', id_type: 'app_id', id: 'cli_minori',
      } }] } })
      .mockResolvedValueOnce({ data: { items: [{ sender: {
        sender_type: 'app', id_type: 'app_id', id: 'cli_other', open_bot_id: 'ou_other_bot',
      } }] } });
    const adapter = new FeishuClientAdapter(client, pino({ level: 'silent' }));

    const minori = { openId: 'ou_minori', appId: 'cli_minori' };
    await expect(adapter.isBotMessage('om_bot', minori)).resolves.toBe(true);
    await expect(adapter.isBotMessage('om_bot_legacy', minori)).resolves.toBe(true);
    await expect(adapter.isBotMessage('om_other_bot', minori)).resolves.toBe(false);
    expect(client.im.v1.message.get).toHaveBeenCalledWith({
      path: { message_id: 'om_bot' },
      params: { user_id_type: 'open_id' },
    });
  });

  it('adds and removes Typing reactions while containing reaction failures', async () => {
    const warnings: unknown[] = [];
    const logger = pino({ level: 'silent' });
    logger.warn = vi.fn((details: unknown) => { warnings.push(details); }) as typeof logger.warn;
    const client = sdk();
    client.im.v1.messageReaction.create
      .mockResolvedValueOnce({ data: { reaction_id: 'react_1' } })
      .mockRejectedValueOnce(new Error('Bearer secret'));
    client.im.v1.messageReaction.delete
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Bearer secret'));
    const adapter = new FeishuClientAdapter(client, logger);

    await expect(adapter.addReaction('om_1', 'Typing')).resolves.toBe('react_1');
    await expect(adapter.addReaction('om_1', 'Typing')).resolves.toBeNull();
    await expect(adapter.removeReaction('om_1', 'react_1')).resolves.toBeUndefined();
    await expect(adapter.removeReaction('om_1', 'react_1')).resolves.toBeUndefined();
    expect(client.im.v1.messageReaction.create).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
    expect(JSON.stringify(warnings)).toBe(
      '[{"errorCode":"reaction_add_failed"},{"errorCode":"reaction_remove_failed"}]',
    );
  });
});
