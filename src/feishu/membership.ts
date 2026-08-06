import type { NormalizedMessage } from '../contracts/messages.js';
import type { AllowedChatStore } from '../storage/allowed-chat-store.js';

export type AuthorizationResult =
  | { allowed: true }
  | {
    allowed: false;
    reason: 'chat_not_allowed' | 'not_team_member' | 'membership_unavailable';
  };

export interface ChatMemberSource {
  listOpenIds(chatId: string): Promise<Set<string>>;
}

export type MembershipPolicyOptions = {
  allowedChats: AllowedChatStore;
  members: ChatMemberSource;
  now?: () => Date;
  cacheMs?: number;
};

const DEFAULT_CACHE_MS = 5 * 60 * 1_000;

export class MembershipPolicy {
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, { openIds: Set<string>; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Set<string>>>();

  constructor(private readonly options: MembershipPolicyOptions) {
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  }

  async authorize(message: NormalizedMessage): Promise<AuthorizationResult> {
    if (message.chatType === 'group') {
      try {
        if (!await this.options.allowedChats.isAllowed(message.chatId)) {
          return { allowed: false, reason: 'chat_not_allowed' };
        }
        const members = await this.membersFor(message.chatId);
        return members.has(message.senderOpenId)
          ? { allowed: true }
          : { allowed: false, reason: 'not_team_member' };
      } catch {
        return { allowed: false, reason: 'membership_unavailable' };
      }
    }

    let chatIds: string[];
    try {
      chatIds = await this.options.allowedChats.listAllowedChatIds();
    } catch {
      return { allowed: false, reason: 'membership_unavailable' };
    }

    const lookups = await Promise.allSettled(chatIds.map((chatId) => this.membersFor(chatId)));
    if (lookups.some(
      (lookup) => lookup.status === 'fulfilled' && lookup.value.has(message.senderOpenId),
    )) return { allowed: true };
    const lookupFailed = lookups.some((lookup) => lookup.status === 'rejected');
    return lookupFailed
      ? { allowed: false, reason: 'membership_unavailable' }
      : { allowed: false, reason: 'not_team_member' };
  }

  private async membersFor(chatId: string) {
    const now = this.now().getTime();
    const cached = this.cache.get(chatId);
    if (cached && cached.expiresAt > now) return cached.openIds;
    const active = this.pending.get(chatId);
    if (active) return active;
    const loading = this.options.members.listOpenIds(chatId).then((openIds) => {
      this.cache.set(chatId, {
        openIds,
        expiresAt: this.now().getTime() + this.cacheMs,
      });
      return openIds;
    }).finally(() => {
      this.pending.delete(chatId);
    });
    this.pending.set(chatId, loading);
    return loading;
  }
}
