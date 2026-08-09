import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { conversations, messages } from './schema.js';

export type StoredMessage = {
  messageId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  senderOpenId?: string;
  content: string;
  createdAt: Date;
};

export type StoredMessageExcerpt = Pick<StoredMessage, 'messageId' | 'role' | 'createdAt'> & {
  excerpt: string;
};

export type ConversationIdentity = {
  conversationKey: string;
  chatId: string;
  type: 'group' | 'p2p';
};

export type ConversationStoreOptions = {
  estimateTokens?: (text: string) => number;
  now?: () => Date;
  retentionMs?: number;
};

export interface ConversationStore {
  getOrCreateConversation(identity: ConversationIdentity): Promise<string>;
  append(message: StoredMessage): Promise<void>;
  recentWithinBudget(
    conversationKey: string,
    tokenTarget: number,
    triggerMessageId: string,
  ): Promise<StoredMessage[]>;
  search(conversationKey: string, query: string, limit: number): Promise<StoredMessageExcerpt[]>;
  purgeExpired(before: Date): Promise<number>;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function estimateConversationTokens(text: string): number {
  let tokens = 0;
  let latinRun = 0;
  for (const character of text) {
    if (character.codePointAt(0)! > 0x7f) {
      tokens += Math.ceil(latinRun / 4) + 1;
      latinRun = 0;
    } else {
      latinRun += 1;
    }
  }
  return Math.max(1, tokens + Math.ceil(latinRun / 4));
}

function escapeLike(term: string) {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function excerptAroundMatch(content: string, query: string, maximumLength = 500) {
  if (content.length <= maximumLength) return content;
  const matchAt = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, matchAt - Math.floor(maximumLength / 3));
  const excerpt = content.slice(start, start + maximumLength);
  return `${start > 0 ? '…' : ''}${excerpt}${start + maximumLength < content.length ? '…' : ''}`;
}

export class PostgresConversationStore implements ConversationStore {
  private readonly estimateTokens: (text: string) => number;
  private readonly now: () => Date;
  private readonly retentionMs: number;

  constructor(private readonly db: Database, options: ConversationStoreOptions = {}) {
    this.estimateTokens = options.estimateTokens ?? estimateConversationTokens;
    this.now = options.now ?? (() => new Date());
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  async getOrCreateConversation(identity: ConversationIdentity): Promise<string> {
    const [conversation] = await this.db.insert(conversations).values({
      conversationKey: identity.conversationKey,
      chatId: identity.chatId,
      type: identity.type,
      lastActivityAt: this.now(),
    }).onConflictDoUpdate({
      target: conversations.conversationKey,
      set: { lastActivityAt: this.now() },
    }).returning({ id: conversations.id });

    if (!conversation) throw new Error('conversation_identity_unavailable');
    return conversation.id;
  }

  async append(message: StoredMessage): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inserted = await tx.insert(messages).values({
        messageId: message.messageId,
        conversationId: message.conversationId,
        role: message.role,
        senderOpenId: message.senderOpenId,
        content: message.content,
        createdAt: message.createdAt,
      }).onConflictDoNothing({ target: messages.messageId }).returning({ id: messages.id });

      if (inserted.length === 1) {
        await tx.update(conversations).set({
          lastActivityAt: sql`greatest(${conversations.lastActivityAt}, ${message.createdAt})`,
        }).where(eq(conversations.id, message.conversationId));
      }
    });
  }

  async recentWithinBudget(
    conversationKey: string,
    tokenTarget: number,
    triggerMessageId: string,
  ): Promise<StoredMessage[]> {
    const retainedSince = new Date(this.now().getTime() - this.retentionMs);
    const rows = await this.db.select({
      messageId: messages.messageId,
      conversationId: messages.conversationId,
      role: messages.role,
      senderOpenId: messages.senderOpenId,
      content: messages.content,
      createdAt: messages.createdAt,
    }).from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(
        eq(conversations.conversationKey, conversationKey),
        isNotNull(messages.content),
        gte(messages.createdAt, retainedSince),
      ))
      .orderBy(desc(messages.sequence));

    const triggerIndex = rows.findIndex((row) => row.messageId === triggerMessageId);
    if (triggerIndex === -1) throw new Error('trigger_message_not_found');
    const rowsAtOrBeforeTrigger = rows.slice(triggerIndex);

    const selected: StoredMessage[] = [];
    let usedTokens = 0;
    for (const row of rowsAtOrBeforeTrigger) {
      if (row.content === null) continue;
      const estimated = this.estimateTokens(row.content);
      if (selected.length > 0 && usedTokens + estimated > tokenTarget) break;
      selected.push({
        messageId: row.messageId,
        conversationId: row.conversationId,
        role: row.role,
        ...(row.senderOpenId ? { senderOpenId: row.senderOpenId } : {}),
        content: row.content,
        createdAt: row.createdAt,
      });
      usedTokens += estimated;
    }

    return selected.reverse();
  }

  async search(
    conversationKey: string,
    query: string,
    limit: number,
  ): Promise<StoredMessageExcerpt[]> {
    const terms = query.trim().split(/\s+/u).filter(Boolean).slice(0, 10);
    if (terms.length === 0 || limit <= 0) return [];
    const retainedSince = new Date(this.now().getTime() - this.retentionMs);
    const termConditions = terms.map((term) =>
      sql`${messages.content} ilike ${`%${escapeLike(term)}%`} escape '\\'`);

    const rows = await this.db.select({
      messageId: messages.messageId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    }).from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(
        eq(conversations.conversationKey, conversationKey),
        isNotNull(messages.content),
        gte(messages.createdAt, retainedSince),
        ...termConditions,
      ))
      .orderBy(desc(messages.sequence))
      .limit(limit);

    return rows.flatMap((row) => row.content === null ? [] : [{
      messageId: row.messageId,
      role: row.role,
      createdAt: row.createdAt,
      excerpt: excerptAroundMatch(row.content, terms[0]!),
    }]);
  }

  async purgeExpired(before: Date): Promise<number> {
    const purged = await this.db.update(messages).set({
      content: null,
      purgedAt: this.now(),
    }).where(and(
      lt(messages.createdAt, before),
      isNotNull(messages.content),
    )).returning({ id: messages.id });

    return purged.length;
  }
}
