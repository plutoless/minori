import { and, eq } from 'drizzle-orm';
import type { Database } from './database.js';
import { allowedChats } from './schema.js';

export interface AllowedChatStore {
  isAllowed(chatId: string): Promise<boolean>;
  listAllowedChatIds(): Promise<string[]>;
}

export class PostgresAllowedChatStore implements AllowedChatStore {
  constructor(private readonly db: Database) {}

  async isAllowed(chatId: string): Promise<boolean> {
    const [allowed] = await this.db.select({ chatId: allowedChats.chatId })
      .from(allowedChats)
      .where(and(
        eq(allowedChats.chatId, chatId),
        eq(allowedChats.enabled, true),
      ))
      .limit(1);

    return allowed !== undefined;
  }

  async listAllowedChatIds(): Promise<string[]> {
    const rows = await this.db.select({ chatId: allowedChats.chatId })
      .from(allowedChats)
      .where(eq(allowedChats.enabled, true));
    return rows.map((row) => row.chatId);
  }
}
