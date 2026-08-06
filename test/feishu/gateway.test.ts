import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FeishuGateway, registerLongConnection } from '../../src/feishu/gateway.js';

const BOT_OPEN_ID = 'ou_minori';

function rawMessage(input: {
  messageId?: string;
  text?: string;
  mention?: boolean;
  chatType?: 'group' | 'p2p';
  rootId?: string;
  parentId?: string;
} = {}) {
  const messageId = input.messageId ?? 'om_1';
  return {
    event_id: `evt_${messageId}`,
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
    message: {
      message_id: messageId,
      chat_id: input.chatType === 'p2p' ? 'oc_dm' : 'oc_team',
      chat_type: input.chatType ?? 'group',
      message_type: 'text',
      create_time: '1785888000000',
      content: JSON.stringify({ text: input.mention ? `@_user_1 ${input.text ?? 'hello'}` : input.text ?? 'hello' }),
      ...(input.rootId ? { root_id: input.rootId } : {}),
      ...(input.parentId ? { parent_id: input.parentId } : {}),
      ...(input.mention ? {
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      } : {}),
    },
  };
}

function gateway(overrides: Partial<ConstructorParameters<typeof FeishuGateway>[0]> = {}) {
  const enqueue = vi.fn().mockResolvedValue('queued');
  const signalWorker = vi.fn(() => new Promise<void>(() => undefined));
  const dependencies: ConstructorParameters<typeof FeishuGateway>[0] = {
    botOpenId: BOT_OPEN_ID,
    botAppId: 'cli_minori',
    eventStore: { enqueue },
    membership: { authorize: vi.fn().mockResolvedValue({ allowed: true }) },
    messageContext: { isBotMessage: vi.fn().mockResolvedValue(false) },
    threads: { exists: vi.fn().mockResolvedValue(false) },
    signalWorker,
    logger: pino({ level: 'silent' }),
    ...overrides,
  };
  return { gateway: new FeishuGateway(dependencies), dependencies, enqueue, signalWorker };
}

describe('FeishuGateway', () => {
  it('persists a direct mention and returns without awaiting downstream work', async () => {
    const { gateway: instance, enqueue, signalWorker } = gateway();

    const completedQuickly = await Promise.race([
      instance.handle(rawMessage({ mention: true })).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);

    expect(completedQuickly).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'evt_om_1', conversationKey: 'oc_team:om_1',
    }));
    expect(signalWorker).toHaveBeenCalledTimes(1);
  });

  it('does not signal work for a duplicate event', async () => {
    const enqueue = vi.fn().mockResolvedValue('duplicate');
    const { gateway: instance, signalWorker } = gateway({ eventStore: { enqueue } });

    await instance.handle(rawMessage({ mention: true }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(signalWorker).not.toHaveBeenCalled();
  });

  it('accepts replies to Minori and continuation messages in a known Agent Thread', async () => {
    const messageContext = { isBotMessage: vi.fn(async (id: string) => id === 'om_bot') };
    const threads = { exists: vi.fn(async (key: string) => key === 'oc_team:om_root') };
    const { gateway: instance, enqueue } = gateway({ messageContext, threads });

    await instance.handle(rawMessage({
      messageId: 'om_reply', rootId: 'om_new_root', parentId: 'om_bot', text: 'reply',
    }));
    await instance.handle(rawMessage({
      messageId: 'om_continue', rootId: 'om_root', parentId: 'om_member', text: 'continue',
    }));
    await instance.handle(rawMessage({ messageId: 'om_noise', text: 'ordinary timeline' }));

    expect(enqueue.mock.calls.map(([message]) => message.conversationKey)).toEqual([
      'oc_team:om_new_root', 'oc_team:om_root',
    ]);
  });

  it('accepts every authorized private message and rejects unauthorized senders', async () => {
    const membership = { authorize: vi.fn()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: 'not_team_member' }) };
    const { gateway: instance, enqueue } = gateway({ membership });

    await instance.handle(rawMessage({ messageId: 'om_dm_1', chatType: 'p2p' }));
    await instance.handle(rawMessage({ messageId: 'om_dm_2', chatType: 'p2p' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: 'oc_dm' }));
  });

  it('does not perform trusted activation lookups for bot or malformed events', async () => {
    const messageContext = { isBotMessage: vi.fn().mockResolvedValue(true) };
    const threads = { exists: vi.fn().mockResolvedValue(true) };
    const { gateway: instance, enqueue } = gateway({ messageContext, threads });
    const botEvent = rawMessage({ messageId: 'om_bot', rootId: 'om_root', parentId: 'om_parent' });
    botEvent.sender.sender_type = 'app';
    const malformed = rawMessage({
      messageId: 'om_bad', rootId: 'om_root', parentId: 'om_parent',
    });
    malformed.message.content = '{broken';

    await instance.handle(botEvent);
    await instance.handle(malformed);

    expect(messageContext.isBotMessage).not.toHaveBeenCalled();
    expect(threads.exists).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('registers the receive handler with the official long-connection shape', async () => {
    const { gateway: instance } = gateway();
    const dispatcher = { register: vi.fn() };
    const wsClient = { start: vi.fn().mockResolvedValue(undefined) };

    const connection = registerLongConnection({ wsClient, dispatcher, gateway: instance });
    const handlers = dispatcher.register.mock.calls[0]?.[0];
    expect(handlers).toHaveProperty('im.message.receive_v1');

    await connection.start();
    expect(wsClient.start).toHaveBeenCalledWith({ eventDispatcher: dispatcher });
  });
});
