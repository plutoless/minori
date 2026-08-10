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
import { sql } from 'drizzle-orm';
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

export type ScheduleState = 'active' | 'paused' | 'in_flight' | 'completed' | 'deleted';
export type ScheduledRunStatus =
  | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'delivery_uncertain';

export const scheduledTasks = pgTable('scheduled_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  creatorOpenId: text('creator_open_id').notNull(),
  originChatId: text('origin_chat_id').notNull(),
  originDisplayName: text('origin_display_name').notNull(),
  originChatType: text('origin_chat_type').$type<'group' | 'p2p'>().notNull(),
  currentVersion: integer('current_version').default(1).notNull(),
  scheduleKind: text('schedule_kind').$type<'once' | 'cron'>().notNull(),
  onceAt: timestamp('once_at', { withTimezone: true }),
  cronExpression: text('cron_expression'),
  timezone: text('timezone').notNull(),
  resultChatId: text('result_chat_id').notNull(),
  resultDisplayName: text('result_display_name').notNull(),
  resultChatType: text('result_chat_type').$type<'group' | 'p2p'>().notNull(),
  contextChatId: text('context_chat_id'),
  contextDisplayName: text('context_display_name'),
  state: text('state').$type<ScheduleState>().default('active').notNull(),
  nameReserved: boolean('name_reserved').default(true).notNull(),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }),
  latestMissedAt: timestamp('latest_missed_at', { withTimezone: true }),
  latestRunStatus: text('latest_run_status').$type<ScheduledRunStatus>(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  bodyPurgedAt: timestamp('body_purged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('scheduled_tasks_reserved_name_unique')
    .on(sql`lower(${table.name})`)
    .where(sql`${table.nameReserved} = true`),
  index('scheduled_tasks_due_idx').on(table.state, table.nextDueAt),
]);

export const scheduledTaskRevisions = pgTable('scheduled_task_revisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  scheduleId: uuid('schedule_id').notNull()
    .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  actorOpenId: text('actor_open_id').notNull(),
  instruction: text('instruction'),
  scheduleKind: text('schedule_kind').$type<'once' | 'cron'>().notNull(),
  onceAt: timestamp('once_at', { withTimezone: true }),
  cronExpression: text('cron_expression'),
  timezone: text('timezone').notNull(),
  resultChatId: text('result_chat_id').notNull(),
  resultDisplayName: text('result_display_name').notNull(),
  resultChatType: text('result_chat_type').$type<'group' | 'p2p'>().notNull(),
  contextChatId: text('context_chat_id'),
  contextDisplayName: text('context_display_name'),
  bodyPurgedAt: timestamp('body_purged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('scheduled_task_revisions_schedule_version_unique')
    .on(table.scheduleId, table.version),
]);

export const scheduledRuns = pgTable('scheduled_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  scheduleId: uuid('schedule_id').notNull()
    .references(() => scheduledTasks.id, { onDelete: 'restrict' }),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  taskVersion: integer('task_version').notNull(),
  instruction: text('instruction').notNull(),
  resultChatId: text('result_chat_id').notNull(),
  resultDisplayName: text('result_display_name').notNull(),
  resultChatType: text('result_chat_type').$type<'group' | 'p2p'>().notNull(),
  contextChatId: text('context_chat_id'),
  contextDisplayName: text('context_display_name'),
  status: text('status').$type<ScheduledRunStatus>().default('queued').notNull(),
  claimAttempt: integer('claim_attempt').default(0).notNull(),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  writeStartedAt: timestamp('write_started_at', { withTimezone: true }),
  deliveryIdempotencyKey: text('delivery_idempotency_key'),
  deliveryAttemptedAt: timestamp('delivery_attempted_at', { withTimezone: true }),
  deliveryMessageId: text('delivery_message_id'),
  outcomeCategory: text('outcome_category'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('scheduled_runs_schedule_occurrence_unique')
    .on(table.scheduleId, table.scheduledFor),
  uniqueIndex('scheduled_runs_one_active_per_task')
    .on(table.scheduleId)
    .where(sql`${table.status} in ('queued', 'processing')`),
  index('scheduled_runs_ready_idx').on(table.status, table.createdAt),
]);

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
