import { z } from 'zod';
import type { NormalizedMessage } from '../contracts/messages.js';

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
    root_id: z.string().optional(),
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
  knownAgentThread?: boolean;
};

const UNSUPPORTED_MESSAGE_TYPES = new Set(['image', 'audio', 'media', 'file']);
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gu;

function isFeishuDocumentLink(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isFeishuHost = hostname === 'feishu.cn'
      || hostname.endsWith('.feishu.cn')
      || hostname === 'larksuite.com'
      || hostname.endsWith('.larksuite.com')
      || hostname === 'larkoffice.com'
      || hostname.endsWith('.larkoffice.com');
    return isFeishuHost && /^\/(?:wiki|docx|docs|sheets|base)\/[A-Za-z0-9_-]+/u.test(url.pathname);
  } catch {
    return false;
  }
}

function uniqueLinks(text: string, explicit: string[] = []) {
  return [...new Set([...explicit, ...(text.match(URL_PATTERN) ?? [])]
    .filter(isFeishuDocumentLink))];
}

function normalizedLine(text: string) {
  return text.replace(/[\t ]+/gu, ' ').trim();
}

function parseTextContent(
  raw: string,
  botMentionKeys: string[],
): { text: string; feishuLinks: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = z.object({ text: z.string() }).safeParse(parsed);
  if (!result.success) return null;
  let text = result.data.text;
  for (const key of botMentionKeys) text = text.split(key).join('');
  text = normalizedLine(text);
  return { text, feishuLinks: uniqueLinks(text) };
}

function parsePostContent(
  raw: string,
  botOpenId: string,
  botMentionKeys: string[],
): { text: string; feishuLinks: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const direct = parsed as { title?: unknown; content?: unknown };
  const candidate = Array.isArray(direct.content) ? direct : Object.values(parsed)[0];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const post = candidate as { title?: unknown; content?: unknown };
  if (!Array.isArray(post.content)) return null;

  const lines: string[] = [];
  const links: string[] = [];
  if (typeof post.title === 'string' && normalizedLine(post.title)) {
    lines.push(normalizedLine(post.title));
  }
  for (const rawRow of post.content) {
    if (!Array.isArray(rawRow)) continue;
    let inline = '';
    const flushInline = () => {
      const line = normalizedLine(inline);
      if (line) lines.push(line);
      inline = '';
    };
    for (const rawNode of rawRow) {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
      const node = rawNode as Record<string, unknown>;
      if (node.tag === 'at') {
        const userId = String(node.user_id);
        if (userId !== botOpenId
          && !botMentionKeys.includes(userId)
          && typeof node.user_name === 'string') {
          inline += `@${node.user_name}`;
        }
      } else if (node.tag === 'a') {
        if (typeof node.text === 'string') inline += node.text;
        if (typeof node.href === 'string') links.push(node.href);
      } else if (node.tag === 'code_block' && typeof node.text === 'string') {
        flushInline();
        const language = typeof node.language === 'string' ? node.language : '';
        lines.push(`\`\`\`${language}\n${node.text}\n\`\`\``);
      } else if (typeof node.text === 'string') {
        inline += node.text;
      }
    }
    flushInline();
  }
  const text = lines.join('\n').trim();
  return { text, feishuLinks: uniqueLinks(text, links) };
}

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
    || activation.repliedToBot === true
    || (activation.knownAgentThread === true && message.root_id !== undefined);
  if (!isActivated) return null;

  let content: NormalizedMessage['content'];
  if (UNSUPPORTED_MESSAGE_TYPES.has(message.message_type)) {
    content = { kind: 'unsupported', sourceMessageType: message.message_type };
  } else if (message.message_type === 'text') {
    const text = parseTextContent(message.content, botMentions.map((mention) => mention.key));
    if (!text) return null;
    content = { kind: 'text', ...text };
  } else if (message.message_type === 'post') {
    const text = parsePostContent(
      message.content,
      activation.botOpenId,
      botMentions.map((mention) => mention.key),
    );
    if (!text) return null;
    content = { kind: 'text', ...text };
  } else {
    return null;
  }

  const occurredAt = new Date(Number(message.create_time));
  if (Number.isNaN(occurredAt.getTime())) return null;
  const rootId = isPrivate
    ? undefined
    : (message.root_id ?? (activation.repliedToBot ? message.parent_id : undefined) ?? message.message_id);
  if (!isPrivate && !rootId) return null;

  return {
    eventId: parsed.data.event_id,
    messageId: message.message_id,
    chatId: message.chat_id,
    conversationKey: isPrivate ? message.chat_id : `${message.chat_id}:${rootId}`,
    ...(rootId ? { rootId } : {}),
    senderOpenId,
    chatType: message.chat_type,
    content,
    occurredAt,
  };
}
