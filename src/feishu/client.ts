import type { Logger } from 'pino';
import { Client, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { FeishuGroupContextSource } from './group-context.js';
import { FeishuChatDirectory } from './chat-directory.js';
import { richPostContent } from './rich-content.js';

type ApiResponse<T> = { code?: number | undefined; data?: T | undefined };

export interface FeishuMessenger {
  replyText(messageId: string, text: string, idempotencyKey: string): Promise<string>;
  replyRichContent(messageId: string, markdown: string, idempotencyKey: string): Promise<string>;
  addReaction(messageId: string, emojiType: 'Typing'): Promise<string | null>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

export interface ScheduledResultMessenger {
  sendText(chatId: string, text: string, idempotencyKey: string): Promise<string>;
  sendRichContent(chatId: string, markdown: string, idempotencyKey: string): Promise<string>;
}

export type FeishuBotIdentity = { openId: string; appId: string };

export type FeishuSdk = {
  im: { v1: {
    chat: {
      list(payload?: {
        params?: {
          page_token?: string | undefined;
          page_size?: number | undefined;
        } | undefined;
      }): Promise<ApiResponse<{
        items?: Array<{
          chat_id?: string | undefined;
          name?: string | undefined;
          chat_mode?: 'group' | 'p2p' | 'topic' | undefined;
        }> | undefined;
        page_token?: string | undefined;
        has_more?: boolean | undefined;
      }>>;
    };
    message: {
      create(payload: {
        data: { receive_id: string; msg_type: 'text' | 'post'; content: string; uuid: string };
        params: { receive_id_type: 'chat_id' };
      }): Promise<ApiResponse<{ message_id?: string | undefined }>>;
      reply(payload: {
        path: { message_id: string };
        data: {
          content: string; msg_type: 'text' | 'post'; reply_in_thread: false; uuid: string;
        };
      }): Promise<ApiResponse<{ message_id?: string | undefined }>>;
      get(payload: {
        path: { message_id: string };
        params: { user_id_type: 'open_id' };
      }): Promise<ApiResponse<{
        items?: Array<{
          sender?: {
            sender_type?: string | undefined;
            id?: string | undefined;
            id_type?: string | undefined;
            open_bot_id?: string | undefined;
          } | undefined;
        }> | undefined;
      }>>;
      list(payload: {
        params: {
          container_id_type: 'chat';
          container_id: string;
          end_time: string;
          sort_type: 'ByCreateTimeDesc';
          page_size: number;
          page_token?: string;
        };
      }): Promise<ApiResponse<{
        has_more?: boolean | undefined;
        page_token?: string | undefined;
        items?: Array<{
          message_id?: string | undefined;
          msg_type?: string | undefined;
          create_time?: string | undefined;
          chat_id?: string | undefined;
          sender?: {
            id?: string | undefined;
            id_type?: string | undefined;
            sender_type?: string | undefined;
            open_bot_id?: string | undefined;
          } | undefined;
          body?: { content?: string | undefined } | undefined;
          mentions?: Array<{
            key?: string | undefined;
            id?: string | undefined;
            id_type?: string | undefined;
            name?: string | undefined;
          }> | undefined;
        }> | undefined;
      }>>;
    };
    messageReaction: {
      create(payload: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: 'Typing' } };
      }): Promise<ApiResponse<{ reaction_id?: string | undefined }>>;
      delete(payload: {
        path: { message_id: string; reaction_id: string };
      }): Promise<ApiResponse<unknown>>;
    };
    chatMembers: {
      get(payload: {
        path: { chat_id: string };
        params: {
          member_id_type: 'open_id';
          page_size: number;
          page_token?: string;
        };
      }): Promise<ApiResponse<{
        items?: Array<{
          member_id_type?: string | undefined;
          member_id?: string | undefined;
          name?: string | undefined;
        }> | undefined;
        page_token?: string | undefined;
        has_more?: boolean | undefined;
      }>>;
    };
  } };
};

function assertApiSuccess(response: ApiResponse<unknown>, errorCode: string) {
  if (response.code !== undefined && response.code !== 0) throw new Error(errorCode);
}

export class FeishuClientAdapter implements FeishuMessenger, ScheduledResultMessenger {
  constructor(private readonly client: FeishuSdk, private readonly logger: Logger) {}

  private validateIdempotencyKey(idempotencyKey: string, errorCode: string): void {
    if (idempotencyKey.length === 0 || idempotencyKey.length > 50) {
      throw new Error(errorCode);
    }
  }

  private async reply(
    messageId: string,
    content: string,
    msgType: 'text' | 'post',
    idempotencyKey: string,
  ): Promise<string> {
    this.validateIdempotencyKey(idempotencyKey, 'invalid_reply_idempotency_key');
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content,
        msg_type: msgType,
        reply_in_thread: false,
        uuid: idempotencyKey,
      },
    });
    assertApiSuccess(response, 'reply_failed');
    const replyMessageId = response.data?.message_id;
    if (!replyMessageId) throw new Error('reply_missing_message_id');
    return replyMessageId;
  }

  private async send(
    chatId: string,
    content: string,
    msgType: 'text' | 'post',
    idempotencyKey: string,
  ): Promise<string> {
    this.validateIdempotencyKey(idempotencyKey, 'invalid_send_idempotency_key');
    const response = await this.client.im.v1.message.create({
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
        uuid: idempotencyKey,
      },
      params: { receive_id_type: 'chat_id' },
    });
    assertApiSuccess(response, 'scheduled_delivery_rejected');
    const sentMessageId = response.data?.message_id;
    if (!sentMessageId) throw new Error('scheduled_delivery_uncertain');
    return sentMessageId;
  }

  async replyText(messageId: string, text: string, idempotencyKey: string): Promise<string> {
    return this.reply(messageId, JSON.stringify({ text }), 'text', idempotencyKey);
  }

  async replyRichContent(
    messageId: string,
    markdown: string,
    idempotencyKey: string,
  ): Promise<string> {
    return this.reply(messageId, richPostContent(markdown), 'post', idempotencyKey);
  }

  async sendText(chatId: string, text: string, idempotencyKey: string): Promise<string> {
    return this.send(chatId, JSON.stringify({ text }), 'text', idempotencyKey);
  }

  async sendRichContent(
    chatId: string,
    markdown: string,
    idempotencyKey: string,
  ): Promise<string> {
    return this.send(chatId, richPostContent(markdown), 'post', idempotencyKey);
  }

  async isBotMessage(messageId: string, bot: FeishuBotIdentity): Promise<boolean> {
    const response = await this.client.im.v1.message.get({
      path: { message_id: messageId },
      params: { user_id_type: 'open_id' },
    });
    assertApiSuccess(response, 'message_lookup_failed');
    const sender = response.data?.items?.[0]?.sender;
    return sender?.sender_type === 'app'
      && (sender.open_bot_id === bot.openId
        || (sender.id_type === 'app_id' && sender.id === bot.appId));
  }

  async addReaction(messageId: string, emojiType: 'Typing'): Promise<string | null> {
    try {
      const response = await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      assertApiSuccess(response, 'reaction_add_failed');
      return response.data?.reaction_id ?? null;
    } catch {
      this.logger.warn({ errorCode: 'reaction_add_failed' }, 'reaction add failed');
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const response = await this.client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      assertApiSuccess(response, 'reaction_remove_failed');
    } catch {
      this.logger.warn({ errorCode: 'reaction_remove_failed' }, 'reaction remove failed');
    }
  }
}

export function createOfficialFeishuClient(
  credentials: { appId: string; appSecret: string },
  logger: Logger,
) {
  defaultHttpInstance.defaults.timeout = 30_000;
  const client = new Client(credentials);
  return new FeishuClientAdapter(client, logger);
}

export function createOfficialFeishuRuntime(
  credentials: { appId: string; appSecret: string },
  logger: Logger,
) {
  defaultHttpInstance.defaults.timeout = 30_000;
  const client = new Client(credentials);
  return {
    messenger: new FeishuClientAdapter(client, logger),
    groupContext: new FeishuGroupContextSource(client, logger),
    chatDirectory: new FeishuChatDirectory(client, logger),
  };
}
