export type NormalizedMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  conversationKey: string;
  senderOpenId: string;
  chatType: 'group' | 'p2p';
  content:
    | { kind: 'text'; text: string; feishuLinks: string[] }
    | { kind: 'unsupported'; sourceMessageType: string };
  occurredAt: Date;
};
