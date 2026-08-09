import type { Logger } from 'pino';
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { NormalizedMessage } from '../contracts/messages.js';
import { isValidUserMessageEvent, normalizeMessageEvent } from './normalize-event.js';
import type { FeishuBotIdentity, FeishuMessenger } from './client.js';

export interface GatewayEventStore {
  enqueue(message: NormalizedMessage): Promise<'queued' | 'duplicate'>;
  attachProcessingReaction(eventId: string, reactionId: string): Promise<boolean>;
}

export interface MessageContextSource {
  isBotMessage(messageId: string, bot: FeishuBotIdentity): Promise<boolean>;
}

export type FeishuGatewayDependencies = {
  botOpenId: string;
  botAppId: string;
  eventStore: GatewayEventStore;
  reactions: Pick<FeishuMessenger, 'addReaction' | 'removeReaction'>;
  messageContext: MessageContextSource;
  signalWorker(): void | Promise<void>;
  logger: Logger;
};

const activationLookupSchema = z.object({
  message: z.object({
    chat_id: z.string(),
    chat_type: z.enum(['group', 'p2p']),
    parent_id: z.string().optional(),
  }).passthrough(),
}).passthrough();

export class FeishuGateway {
  constructor(private readonly dependencies: FeishuGatewayDependencies) {}

  async handle(data: unknown): Promise<void> {
    let normalized = normalizeMessageEvent(data, {
      botOpenId: this.dependencies.botOpenId,
    });

    if (!normalized) {
      if (!isValidUserMessageEvent(data)) return;
      const lookup = activationLookupSchema.safeParse(data);
      if (!lookup.success || lookup.data.message.chat_type !== 'group') return;
      const { message } = lookup.data;
      if (!message.parent_id) return;
      try {
        const repliedToBot = await this.dependencies.messageContext.isBotMessage(
          message.parent_id,
          {
            openId: this.dependencies.botOpenId,
            appId: this.dependencies.botAppId,
          },
        );
        normalized = normalizeMessageEvent(data, {
          botOpenId: this.dependencies.botOpenId,
          repliedToBot,
        });
      } catch {
        this.dependencies.logger.warn(
          { errorCode: 'message_activation_lookup_failed' },
          'message activation lookup failed',
        );
        return;
      }
    }
    if (!normalized) return;

    const status = await this.dependencies.eventStore.enqueue(normalized);
    if (status === 'duplicate') return;

    let reactionId: string | null = null;
    try {
      reactionId = await this.dependencies.reactions.addReaction(normalized.messageId, 'Typing');
    } catch {
      this.dependencies.logger.warn(
        { errorCode: 'reaction_add_failed' },
        'reaction add failed',
      );
    }
    if (reactionId) {
      let attached = false;
      try {
        attached = await this.dependencies.eventStore.attachProcessingReaction(
          normalized.eventId,
          reactionId,
        );
      } catch {
        this.dependencies.logger.warn(
          { errorCode: 'reaction_state_attach_failed' },
          'reaction state attach failed',
        );
      }
      if (!attached) {
        try {
          await this.dependencies.reactions.removeReaction(normalized.messageId, reactionId);
        } catch {
          this.dependencies.logger.warn(
            { errorCode: 'reaction_remove_failed' },
            'reaction remove failed',
          );
        }
      }
    }

    try {
      const signal = this.dependencies.signalWorker();
      void Promise.resolve(signal).catch(() => {
        this.dependencies.logger.warn(
          { errorCode: 'worker_signal_failed' },
          'worker signal failed',
        );
      });
    } catch {
      this.dependencies.logger.warn({ errorCode: 'worker_signal_failed' }, 'worker signal failed');
    }
  }
}

export type LongConnectionDependencies = {
  wsClient: { start(options: { eventDispatcher: unknown }): Promise<void> | void };
  dispatcher: {
    register(handlers: { 'im.message.receive_v1': (data: unknown) => Promise<void> }): unknown;
  };
  gateway: FeishuGateway;
};

export function registerLongConnection(dependencies: LongConnectionDependencies) {
  dependencies.dispatcher.register({
    'im.message.receive_v1': (data) => dependencies.gateway.handle(data),
  });
  return {
    async start() {
      await dependencies.wsClient.start({ eventDispatcher: dependencies.dispatcher });
    },
  };
}

export function createOfficialLongConnection(
  credentials: { appId: string; appSecret: string },
  gateway: FeishuGateway,
) {
  const eventDispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': (data) => gateway.handle(data),
  });
  const wsClient = new WSClient({
    ...credentials,
    loggerLevel: LoggerLevel.info,
    handshakeTimeoutMs: 15_000,
  });
  return {
    start: () => wsClient.start({ eventDispatcher }),
    stop: () => wsClient.close(),
    status: () => wsClient.getConnectionStatus().state,
  };
}
