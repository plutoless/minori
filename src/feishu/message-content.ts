import { z } from 'zod';

export type ParsedFeishuMessageContent = {
  kind: 'text';
  text: string;
  feishuLinks: string[];
} | {
  kind: 'omitted';
  sourceMessageType: string;
};

export type ParseFeishuMessageContentInput = {
  messageType: string;
  rawContent: string;
  botOpenId: string;
  botMentionKeys: string[];
};

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

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseTextContent(
  raw: string,
  botMentionKeys: string[],
): ParsedFeishuMessageContent | null {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const result = z.object({ text: z.string() }).safeParse(parsed);
  if (!result.success) return null;
  let text = result.data.text;
  for (const key of botMentionKeys) text = text.split(key).join('');
  text = normalizedLine(text);
  return { kind: 'text', text, feishuLinks: uniqueLinks(text) };
}

function parsePostContent(
  raw: string,
  botOpenId: string,
  botMentionKeys: string[],
): ParsedFeishuMessageContent | null {
  const parsed = parseJson(raw);
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
  return { kind: 'text', text, feishuLinks: uniqueLinks(text, links) };
}

export function parseFeishuMessageContent(
  input: ParseFeishuMessageContentInput,
): ParsedFeishuMessageContent | null {
  if (input.messageType === 'text') {
    return parseTextContent(input.rawContent, input.botMentionKeys);
  }
  if (input.messageType === 'post') {
    return parsePostContent(input.rawContent, input.botOpenId, input.botMentionKeys);
  }
  const sourceMessageType = /^[a-z0-9_]+$/u.test(input.messageType)
    ? input.messageType
    : 'unknown';
  return { kind: 'omitted', sourceMessageType };
}
