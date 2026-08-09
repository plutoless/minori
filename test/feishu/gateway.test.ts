import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FeishuGateway, registerLongConnection } from '../../src/feishu/gateway.js';

const BOT_OPEN_ID = 'ou_minori';

function rawMessage(input: {
  messageId?: string;
  text?: string;
  mention?: boolean;
  chatType?: 'group' | 'p2p';
  senderOpenId?: string;
  rawRootId?: string;
  parentId?: string;
} = {}) {
  const messageId = input.messageId ?? 'om_1';
  return {
    event_id: `evt_${messageId}`,
    sender: { sender_type: 'user', sender_id: { open_id: input.senderOpenId ?? 'ou_member' } },
    message: {
      message_id: messageId,
      chat_id: input.chatType === 'p2p' ? 'oc_dm' : 'oc_team',
      chat_type: input.chatType ?? 'group',
      message_type: 'text',
      create_time: '1785888000000',
      content: JSON.stringify({ text: input.mention ? `@_user_1 ${input.text ?? 'hello'}` : input.text ?? 'hello' }),
      ...(input.rawRootId ? { root_id: input.rawRootId } : {}),
      ...(input.parentId ? { parent_id: input.parentId } : {}),
      ...(input.mention ? {
        mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Minori' }],
      } : {}),
    },
  };
}

function gateway(overrides: Partial<ConstructorParameters<typeof FeishuGateway>[0]> = {}) {
  const enqueue = vi.fn().mockResolvedValue('queued');
  const attachProcessingReaction = vi.fn().mockResolvedValue(true);
  const signalWorker = vi.fn(() => new Promise<void>(() => undefined));
  const reactions = {
    addReaction: vi.fn().mockResolvedValue('reaction_1'),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies: ConstructorParameters<typeof FeishuGateway>[0] = {
    botOpenId: BOT_OPEN_ID,
    botAppId: 'cli_minori',
    eventStore: { enqueue, attachProcessingReaction },
    messageContext: { isBotMessage: vi.fn().mockResolvedValue(false) },
    reactions,
    signalWorker,
    logger: pino({ level: 'silent' }),
    ...overrides,
  };
  return {
    gateway: new FeishuGateway(dependencies), dependencies, enqueue,
    attachProcessingReaction, reactions, signalWorker,
  };
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
      eventId: 'evt_om_1', conversationKey: 'oc_team',
    }));
    expect(signalWorker).toHaveBeenCalledTimes(1);
  });

  it('adds Typing after durable acceptance and attaches it before signaling work', async () => {
    const calls: string[] = [];
    const { gateway: instance } = gateway({
      eventStore: {
        enqueue: vi.fn(async () => { calls.push('enqueue'); return 'queued'; }),
        attachProcessingReaction: vi.fn(async (eventId, reactionId) => {
          calls.push(`attachReaction:${eventId}:${reactionId}`);
          return true;
        }),
      },
      reactions: {
        addReaction: vi.fn(async (messageId) => {
          calls.push(`addReaction:${messageId}`);
          return 'reaction_1';
        }),
        removeReaction: vi.fn(async () => undefined),
      },
      signalWorker: vi.fn(() => { calls.push('signalWorker'); }),
    });

    await instance.handle(rawMessage({ mention: true }));

    expect(calls).toEqual([
      'enqueue',
      'addReaction:om_1',
      'attachReaction:evt_om_1:reaction_1',
      'signalWorker',
    ]);
  });

  it('does not signal work for a duplicate event', async () => {
    const enqueue = vi.fn().mockResolvedValue('duplicate');
    const attachProcessingReaction = vi.fn().mockResolvedValue(true);
    const { gateway: instance, reactions, signalWorker } = gateway({
      eventStore: { enqueue, attachProcessingReaction },
    });

    await instance.handle(rawMessage({ mention: true }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(reactions.addReaction).not.toHaveBeenCalled();
    expect(attachProcessingReaction).not.toHaveBeenCalled();
    expect(signalWorker).not.toHaveBeenCalled();
  });

  it('still signals work when reaction creation fails', async () => {
    const reactions = {
      addReaction: vi.fn().mockRejectedValue(new Error('reaction api secret')),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };
    const { gateway: instance, attachProcessingReaction, signalWorker } = gateway({ reactions });

    await instance.handle(rawMessage({ mention: true }));

    expect(attachProcessingReaction).not.toHaveBeenCalled();
    expect(signalWorker).toHaveBeenCalledOnce();
  });

  it('removes a reaction whose attachment loses to terminal completion', async () => {
    const attachProcessingReaction = vi.fn().mockResolvedValue(false);
    const { gateway: instance, reactions, signalWorker } = gateway({
      eventStore: { enqueue: vi.fn().mockResolvedValue('queued'), attachProcessingReaction },
    });

    await instance.handle(rawMessage({ mention: true }));

    expect(reactions.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
    expect(signalWorker).toHaveBeenCalledOnce();
  });

  it('accepts only direct replies to Minori in a group', async () => {
    const messageContext = { isBotMessage: vi.fn(async (id: string) => id === 'om_bot') };
    const { gateway: instance, enqueue } = gateway({ messageContext });

    await instance.handle(rawMessage({
      messageId: 'om_reply', rawRootId: 'om_new_root', parentId: 'om_bot', text: 'reply',
    }));
    expect(messageContext.isBotMessage).toHaveBeenCalledOnce();
    expect(messageContext.isBotMessage).toHaveBeenNthCalledWith(1, 'om_bot', {
      openId: BOT_OPEN_ID, appId: 'cli_minori',
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_reply', conversationKey: 'oc_team',
    }));

    await instance.handle(rawMessage({ messageId: 'om_human_reply', parentId: 'om_member', text: 'continue' }));
    await instance.handle(rawMessage({ messageId: 'om_noise', text: 'ordinary timeline' }));

    expect(messageContext.isBotMessage).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts every delivered private message without a membership lookup', async () => {
    const { gateway: instance, enqueue } = gateway();

    await instance.handle(rawMessage({ messageId: 'om_dm_external', chatType: 'p2p' }));

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_dm_external',
      conversationKey: 'oc_dm',
      senderOpenId: 'ou_member',
    }));
  });

  it('accepts a directly mentioned group message from an external collaborator', async () => {
    const { gateway: instance, enqueue } = gateway();

    await instance.handle(rawMessage({
      messageId: 'om_group_external', mention: true, senderOpenId: 'ou_external',
    }));

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_group_external', senderOpenId: 'ou_external', conversationKey: 'oc_team',
    }));
  });

  it('does not perform trusted activation lookups for bot or malformed events', async () => {
    const messageContext = { isBotMessage: vi.fn().mockResolvedValue(true) };
    const { gateway: instance, enqueue } = gateway({ messageContext });
    const botEvent = rawMessage({ messageId: 'om_bot', rawRootId: 'om_root', parentId: 'om_parent' });
    botEvent.sender.sender_type = 'app';
    const malformed = rawMessage({
      messageId: 'om_bad', rawRootId: 'om_root', parentId: 'om_parent',
    });
    malformed.message.content = '{broken';

    await instance.handle(botEvent);
    await instance.handle(malformed);

    expect(messageContext.isBotMessage).not.toHaveBeenCalled();
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
