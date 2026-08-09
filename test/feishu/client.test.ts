import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FeishuClientAdapter } from '../../src/feishu/client.js';

function sdk() {
  return {
    im: { v1: {
      message: { reply: vi.fn(), get: vi.fn() },
      messageReaction: { create: vi.fn(), delete: vi.fn() },
    } },
  };
}

describe('FeishuClientAdapter', () => {
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
        reply_in_thread: true, uuid: 'evt_1:reply:v1',
      },
    });
    await expect(adapter.replyText('om_trigger', 'hello', 'x'.repeat(51))).rejects
      .toThrow('invalid_reply_idempotency_key');
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
