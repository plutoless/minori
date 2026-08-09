import { z } from 'zod';
import type { NormalizedMessage } from '../contracts/messages.js';
import { parseFeishuMessageContent } from './message-content.js';

const mentionSchema = z.object({
  key: z.string(),
  id: z.object({ open_id: z.string().optional() }).passthrough(),
  name: z.string(),
}).passthrough();

const messageEventSchema = z.object({
  event_id: z.string(),
  sender: z.object({
    sender_type: z.string(),
    sender_id: z.object({ open_id: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
  message: z.object({
    message_id: z.string(),
    parent_id: z.string().optional(),
    create_time: z.string(),
    chat_id: z.string(),
    chat_type: z.enum(['group', 'p2p']),
    message_type: z.string(),
    content: z.string(),
    mentions: z.array(mentionSchema).optional(),
  }).passthrough(),
}).passthrough();

export type MessageActivationContext = {
  botOpenId: string;
  repliedToBot?: boolean;
};

export function isValidUserMessageEvent(data: unknown): boolean {
  const parsed = messageEventSchema.safeParse(data);
  if (!parsed.success) return false;
  if (parsed.data.sender.sender_type !== 'user' || !parsed.data.sender.sender_id?.open_id) {
    return false;
  }
  if (Number.isNaN(new Date(Number(parsed.data.message.create_time)).getTime())) return false;
  try {
    JSON.parse(parsed.data.message.content);
    return true;
  } catch {
    return false;
  }
}

export function normalizeMessageEvent(
  data: unknown,
  activation: MessageActivationContext,
): NormalizedMessage | null {
  const parsed = messageEventSchema.safeParse(data);
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  const senderOpenId = sender.sender_id?.open_id;
  if (sender.sender_type !== 'user' || !senderOpenId) return null;

  const botMentions = (message.mentions ?? [])
    .filter((mention) => mention.id.open_id === activation.botOpenId);
  const isPrivate = message.chat_type === 'p2p';
  const isActivated = isPrivate
    || botMentions.length > 0
    || activation.repliedToBot === true;
  if (!isActivated) return null;

  const parsedContent = parseFeishuMessageContent({
    messageType: message.message_type,
    rawContent: message.content,
    botOpenId: activation.botOpenId,
    botMentionKeys: botMentions.map((mention) => mention.key),
  });
  if (!parsedContent) return null;
  const content: NormalizedMessage['content'] = parsedContent.kind === 'text'
    ? parsedContent
    : { kind: 'unsupported', sourceMessageType: parsedContent.sourceMessageType };

  const occurredAt = new Date(Number(message.create_time));
  if (Number.isNaN(occurredAt.getTime())) return null;
  return {
    eventId: parsed.data.event_id,
    messageId: message.message_id,
    chatId: message.chat_id,
    conversationKey: message.chat_id,
    senderOpenId,
    chatType: message.chat_type,
    content,
    occurredAt,
  };
}
