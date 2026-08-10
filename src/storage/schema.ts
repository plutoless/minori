import {
  boolean,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { NormalizedMessage } from '../contracts/messages.js';

export type EventStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type EventOutcome = {
  replyMessageId?: string;
  errorCode?: string;
  preparedReplyText?: string;
};

export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  messageId: text('message_id').notNull(),
  payload: jsonb('payload').$type<NormalizedMessage>().notNull(),
  conversationKey: text('conversation_key').notNull(),
  status: text('status').$type<EventStatus>().notNull(),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  processingReactionId: text('processing_reaction_id'),
  writeStartedAt: timestamp('write_started_at', { withTimezone: true }),
  replyIdempotencyKey: text('reply_idempotency_key'),
  replyAttemptedAt: timestamp('reply_attempted_at', { withTimezone: true }),
  replyMessageId: text('reply_message_id'),
  outcome: jsonb('outcome').$type<EventOutcome>(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('processed_events_ready_idx').on(table.status, table.nextAttemptAt, table.receivedAt),
  index('processed_events_conversation_lease_idx').on(
    table.conversationKey,
    table.status,
    table.leasedUntil,
  ),
]);

/**
 * @deprecated Physical compatibility only for rollback to releases at or before 4f936ab.
 * The current runtime must not read or write this table. Remove it in a later contract
 * migration only after the supported rollback floor has advanced beyond those releases.
 */
export const rollbackCompatibilityAdmission = pgTable('allowed_chats', {
  chatId: text('chat_id').primaryKey(),
  name: text('name'),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationKey: text('conversation_key').notNull(),
  chatId: text('chat_id').notNull(),
  type: text('type').$type<'group' | 'p2p'>().notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('conversations_key_unique').on(table.conversationKey),
]);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sequence: bigserial('sequence', { mode: 'number' }).notNull(),
  messageId: text('message_id').notNull(),
  conversationId: uuid('conversation_id').notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderOpenId: text('sender_open_id'),
  role: text('role').$type<'user' | 'assistant'>().notNull(),
  content: text('content'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('messages_message_id_unique').on(table.messageId),
  index('messages_conversation_sequence_idx').on(table.conversationId, table.sequence),
]);

export const teamContextSnapshots = pgTable('team_context_snapshots', {
  documentToken: text('document_token').primaryKey(),
  sourceRevision: integer('source_revision'),
  normalizedContent: text('normalized_content'),
  estimatedTokens: integer('estimated_tokens'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  invalidationCategory: text('invalidation_category')
    .$type<'team_context_missing' | 'team_context_forbidden'>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  eventId: text('event_id').references(() => processedEvents.eventId, { onDelete: 'set null' }),
  claimAttempt: integer('claim_attempt'),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms'),
  toolCallCount: integer('tool_call_count').default(0).notNull(),
  outcome: text('outcome').notNull(),
  groupHistoryStatus: text('group_history_status')
    .$type<'loaded' | 'unavailable'>(),
  groupHistoryMessageCount: integer('group_history_message_count'),
  groupHistoryPageCount: integer('group_history_page_count'),
  groupHistoryCutoff: timestamp('group_history_cutoff', { withTimezone: true }),
  groupHistoryErrorCategory: text('group_history_error_category'),
  teamContextStatus: text('team_context_status')
    .$type<'loaded' | 'stale' | 'unavailable' | 'over_budget'>(),
  teamContextRevision: integer('team_context_revision'),
  teamContextTokenCount: integer('team_context_token_count'),
  teamContextFetchedAt: timestamp('team_context_fetched_at', { withTimezone: true }),
  teamContextErrorCategory: text('team_context_error_category'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const toolRuns = pgTable('tool_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentRunId: uuid('agent_run_id').notNull()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  targetIdentifiers: jsonb('target_identifiers').$type<Record<string, string>>(),
  success: boolean('success'),
  errorCategory: text('error_category'),
  sanitizedSummary: text('sanitized_summary'),
  resultIdentifiers: jsonb('result_identifiers').$type<Record<string, string>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [
  index('tool_runs_agent_run_idx').on(table.agentRunId, table.startedAt),
]);
