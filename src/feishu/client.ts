import type { Logger } from 'pino';
import { Client, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import type { ChatMemberSource } from './membership.js';

type ApiResponse<T> = { code?: number | undefined; data?: T | undefined };

export interface FeishuMessenger {
  replyText(messageId: string, text: string, idempotencyKey: string): Promise<string>;
  addReaction(messageId: string, emojiType: 'Typing'): Promise<string | null>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

export type FeishuBotIdentity = { openId: string; appId: string };

export type FeishuSdk = {
  im: { v1: {
    chatMembers: {
      get(payload: {
        path: { chat_id: string };
        params: {
          member_id_type: 'open_id'; page_size: 100; page_token?: string;
        };
      }): Promise<ApiResponse<{
        items?: Array<{ member_id?: string | undefined }> | undefined;
        has_more?: boolean | undefined;
        page_token?: string | undefined;
      }>>;
    };
    message: {
      reply(payload: {
        path: { message_id: string };
        data: {
          content: string; msg_type: 'text'; reply_in_thread: true; uuid: string;
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
  } };
};

function assertApiSuccess(response: ApiResponse<unknown>, errorCode: string) {
  if (response.code !== undefined && response.code !== 0) throw new Error(errorCode);
}

export class FeishuClientAdapter implements ChatMemberSource, FeishuMessenger {
  constructor(private readonly client: FeishuSdk, private readonly logger: Logger) {}

  async listOpenIds(chatId: string): Promise<Set<string>> {
    const openIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.client.im.v1.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: 'open_id', page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      assertApiSuccess(response, 'member_list_failed');
      for (const item of response.data?.items ?? []) {
        if (item.member_id) openIds.add(item.member_id);
      }
      if (response.data?.has_more) {
        pageToken = response.data.page_token;
        if (!pageToken) throw new Error('member_list_invalid_cursor');
      } else {
        pageToken = undefined;
      }
    } while (pageToken);
    return openIds;
  }

  async replyText(messageId: string, text: string, idempotencyKey: string): Promise<string> {
    if (idempotencyKey.length === 0 || idempotencyKey.length > 50) {
      throw new Error('invalid_reply_idempotency_key');
    }
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: 'text',
        reply_in_thread: true,
        uuid: idempotencyKey,
      },
    });
    assertApiSuccess(response, 'reply_failed');
    const replyMessageId = response.data?.message_id;
    if (!replyMessageId) throw new Error('reply_missing_message_id');
    return replyMessageId;
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
