import type { Logger } from 'pino';
import type { FeishuSdk } from './client.js';
import { parseFeishuMessageContent } from './message-content.js';

export type LiveGroupHistoryMessage = {
  speakerName: string;
  role: 'user' | 'assistant';
  content: string;
  occurredAt: Date;
};

export type GroupHistoryAudit = {
  status: 'loaded' | 'unavailable';
  messageCount: number;
  pageCallCount: number;
  cutoff: Date;
  errorCategory?: 'group_history_unavailable' | 'group_member_names_unavailable';
};

export type GroupHistoryPage = {
  messages: LiveGroupHistoryMessage[];
  nextCursor?: string;
  audit: GroupHistoryAudit;
};

export type InitialGroupContext = GroupHistoryPage & {
  currentSenderName: string;
};

export interface ScopedGroupContextReader {
  loadInitial(signal?: AbortSignal): Promise<InitialGroupContext>;
  readEarlier(
    input: { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<GroupHistoryPage>;
}

export interface GroupContextSource {
  open(input: {
    chatId: string;
    cutoff: Date;
    triggerMessageId: string;
    currentSenderOpenId: string;
    botOpenId: string;
    botAppId: string;
  }): ScopedGroupContextReader;
}

type GroupContextInput = Parameters<GroupContextSource['open']>[0];
type ProviderMessage = NonNullable<
  NonNullable<Awaited<ReturnType<FeishuSdk['im']['v1']['message']['list']>>['data']>['items']
>[number];

type SelectedMessage = {
  senderId?: string;
  speakerKind: 'member' | 'minori' | 'other_bot';
  content: string;
  occurredAt: Date;
};

const INITIAL_MESSAGE_LIMIT = 20;
const MAX_PAGE_SIZE = 50;
const UNRESOLVED_MEMBER_NAME = '姓名不可用的成员';
const OTHER_BOT_NAME = '其他机器人';

type HistoryTraversalState =
  | { kind: 'not_loaded' }
  | { kind: 'first'; providerToken?: string }
  | { kind: 'opaque'; cursor: string; providerToken: string }
  | { kind: 'exhausted' };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new Error('operation_aborted') : signal.reason;
}

function waitForProvider<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function validProviderPageToken(hasMore: boolean | undefined, pageToken: string | undefined) {
  return hasMore === true && pageToken ? pageToken : undefined;
}

class FeishuScopedGroupContextReader implements ScopedGroupContextReader {
  private readonly memberNames = new Map<string, string>();
  private nextOpaqueCursor = 1;
  private historyTraversal: HistoryTraversalState = { kind: 'not_loaded' };
  private memberProviderToken: string | undefined;
  private membersStarted = false;
  private membersExhausted = false;
  private memberNamesUnavailable = false;
  private historyUnavailable = false;
  private messageCount = 0;
  private pageCallCount = 0;

  constructor(
    private readonly client: FeishuSdk,
    private readonly logger: Logger,
    private readonly input: GroupContextInput,
  ) {}

  async loadInitial(signal?: AbortSignal): Promise<InitialGroupContext> {
    signal?.throwIfAborted();
    const loaded = await this.loadProviderPage(undefined, INITIAL_MESSAGE_LIMIT, signal);
    this.historyTraversal = {
      kind: 'first',
      ...(loaded.nextProviderToken ? { providerToken: loaded.nextProviderToken } : {}),
    };
    const targetIds = new Set(loaded.messages.flatMap((message) => (
      message.speakerKind === 'member' && message.senderId ? [message.senderId] : []
    )));
    targetIds.add(this.input.currentSenderOpenId);
    await this.resolveMemberNames(targetIds, signal);

    return {
      messages: this.renderMessages(loaded.messages),
      currentSenderName: this.memberNames.get(this.input.currentSenderOpenId)
        ?? UNRESOLVED_MEMBER_NAME,
      audit: this.audit(),
    };
  }

  async readEarlier(
    input: { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<GroupHistoryPage> {
    signal?.throwIfAborted();
    if (Object.keys(input).some((key) => key !== 'cursor' && key !== 'limit')) {
      throw new Error('invalid_group_history_input');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
      throw new Error('invalid_group_history_limit');
    }

    const traversal = this.historyTraversal;
    const isFirstRequest = traversal.kind === 'first' && input.cursor === undefined;
    const isExpectedCursor = traversal.kind === 'opaque' && input.cursor === traversal.cursor;
    if (!isFirstRequest && !isExpectedCursor) {
      throw new Error('invalid_group_history_cursor');
    }
    const providerToken = traversal.kind === 'first' || traversal.kind === 'opaque'
      ? traversal.providerToken
      : undefined;
    this.historyTraversal = { kind: 'exhausted' };

    if (this.historyUnavailable || !providerToken) {
      return { messages: [], audit: this.audit() };
    }

    const loaded = await this.loadProviderPage(providerToken, input.limit, signal);
    const targetIds = new Set(loaded.messages.flatMap((message) => (
      message.speakerKind === 'member' && message.senderId ? [message.senderId] : []
    )));
    await this.resolveMemberNames(targetIds, signal);

    const nextCursor = loaded.nextProviderToken
      ? this.registerNextProviderCursor(loaded.nextProviderToken)
      : undefined;
    return {
      messages: this.renderMessages(loaded.messages),
      ...(nextCursor ? { nextCursor } : {}),
      audit: this.audit(),
    };
  }

  private async loadProviderPage(
    pageToken: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ messages: SelectedMessage[]; nextProviderToken?: string }> {
    this.pageCallCount += 1;
    try {
      const response = await waitForProvider(this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: this.input.chatId,
          end_time: String(Math.floor(this.input.cutoff.getTime() / 1_000)),
          sort_type: 'ByCreateTimeDesc',
          page_size: Math.min(limit, MAX_PAGE_SIZE),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), signal);
      signal?.throwIfAborted();
      if ((response.code !== undefined && response.code !== 0) || !response.data) {
        throw new Error('provider_history_response_failed');
      }

      const messages = (response.data.items ?? [])
        .flatMap((message) => {
          const selected = this.selectMessage(message);
          return selected ? [selected] : [];
        })
        .slice(0, limit)
        .reverse();
      this.messageCount += messages.length;
      const nextProviderToken = validProviderPageToken(
        response.data.has_more,
        response.data.page_token,
      );
      return {
        messages,
        ...(nextProviderToken ? { nextProviderToken } : {}),
      };
    } catch {
      signal?.throwIfAborted();
      this.historyUnavailable = true;
      this.logger.warn(
        { errorCode: 'group_history_unavailable' },
        'group history unavailable',
      );
      return { messages: [] };
    }
  }

  private selectMessage(message: ProviderMessage): SelectedMessage | null {
    if (!message.message_id || message.message_id === this.input.triggerMessageId) return null;
    if (message.chat_id && message.chat_id !== this.input.chatId) return null;
    if (!message.create_time || !message.msg_type || !message.body?.content) return null;
    if (message.msg_type === 'system') return null;
    const occurredAt = new Date(Number(message.create_time));
    if (Number.isNaN(occurredAt.getTime()) || occurredAt > this.input.cutoff) return null;

    const sender = message.sender;
    if (!sender || (sender.sender_type !== 'user' && sender.sender_type !== 'app')) return null;
    const botMentionKeys = (message.mentions ?? []).flatMap((mention) => {
      const isMinori = (mention.id_type === 'open_id' && mention.id === this.input.botOpenId)
        || (mention.id_type === 'app_id' && mention.id === this.input.botAppId);
      return isMinori && mention.key ? [mention.key] : [];
    });
    const content = parseFeishuMessageContent({
      messageType: message.msg_type,
      rawContent: message.body.content,
      botOpenId: this.input.botOpenId,
      botMentionKeys,
    });
    if (!content) return null;
    const renderedContent = content.kind === 'text'
      ? content.text
      : `[未读取：${content.sourceMessageType} 消息]`;

    if (sender.sender_type === 'app') {
      const isMinori = sender.open_bot_id === this.input.botOpenId
        || (sender.id_type === 'app_id' && sender.id === this.input.botAppId);
      return {
        speakerKind: isMinori ? 'minori' : 'other_bot',
        content: renderedContent,
        occurredAt,
      };
    }
    if (sender.id_type !== 'open_id' || !sender.id) return null;
    return {
      senderId: sender.id,
      speakerKind: 'member',
      content: renderedContent,
      occurredAt,
    };
  }

  private async resolveMemberNames(targetIds: Set<string>, signal?: AbortSignal): Promise<void> {
    for (const resolvedId of this.memberNames.keys()) targetIds.delete(resolvedId);
    while (targetIds.size > 0 && !this.membersExhausted && !this.memberNamesUnavailable) {
      signal?.throwIfAborted();
      try {
        const response = await waitForProvider(this.client.im.v1.chatMembers.get({
          path: { chat_id: this.input.chatId },
          params: {
            member_id_type: 'open_id',
            page_size: MAX_PAGE_SIZE,
            ...(this.membersStarted && this.memberProviderToken
              ? { page_token: this.memberProviderToken }
              : {}),
          },
        }), signal);
        signal?.throwIfAborted();
        if ((response.code !== undefined && response.code !== 0) || !response.data) {
          throw new Error('provider_member_response_failed');
        }
        this.membersStarted = true;
        for (const member of response.data.items ?? []) {
          if ((member.member_id_type === undefined || member.member_id_type === 'open_id')
            && member.member_id
            && member.name) {
            this.memberNames.set(member.member_id, member.name);
            targetIds.delete(member.member_id);
          }
        }
        this.memberProviderToken = validProviderPageToken(
          response.data.has_more,
          response.data.page_token,
        );
        this.membersExhausted = this.memberProviderToken === undefined;
      } catch {
        signal?.throwIfAborted();
        this.memberNamesUnavailable = true;
        this.logger.warn(
          { errorCode: 'group_member_names_unavailable' },
          'group member names unavailable',
        );
      }
    }
  }

  private renderMessages(messages: SelectedMessage[]): LiveGroupHistoryMessage[] {
    return messages.map((message) => {
      if (message.speakerKind === 'minori') {
        return {
          speakerName: 'Minori', role: 'assistant', content: message.content,
          occurredAt: message.occurredAt,
        };
      }
      if (message.speakerKind === 'other_bot') {
        return {
          speakerName: OTHER_BOT_NAME, role: 'user', content: message.content,
          occurredAt: message.occurredAt,
        };
      }
      return {
        speakerName: message.senderId
          ? this.memberNames.get(message.senderId) ?? UNRESOLVED_MEMBER_NAME
          : UNRESOLVED_MEMBER_NAME,
        role: 'user',
        content: message.content,
        occurredAt: message.occurredAt,
      };
    });
  }

  private registerNextProviderCursor(providerToken: string): string {
    const opaqueCursor = `group_cursor_${this.nextOpaqueCursor}`;
    this.nextOpaqueCursor += 1;
    this.historyTraversal = { kind: 'opaque', cursor: opaqueCursor, providerToken };
    return opaqueCursor;
  }

  private audit(): GroupHistoryAudit {
    const errorCategory = this.historyUnavailable
      ? 'group_history_unavailable' as const
      : this.memberNamesUnavailable
        ? 'group_member_names_unavailable' as const
        : undefined;
    return {
      status: this.historyUnavailable ? 'unavailable' : 'loaded',
      messageCount: this.messageCount,
      pageCallCount: this.pageCallCount,
      cutoff: new Date(this.input.cutoff),
      ...(errorCategory ? { errorCategory } : {}),
    };
  }
}

export class FeishuGroupContextSource implements GroupContextSource {
  constructor(private readonly client: FeishuSdk, private readonly logger: Logger) {}

  open(input: GroupContextInput): ScopedGroupContextReader {
    return new FeishuScopedGroupContextReader(this.client, this.logger, {
      ...input,
      cutoff: new Date(input.cutoff),
    });
  }
}
