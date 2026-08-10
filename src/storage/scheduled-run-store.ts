import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { ScheduledRun, ScheduledRunStatus } from '../schedule/types.js';
import type { Database } from './database.js';
import {
  AGENT_ADMISSION_CONCURRENCY,
  AGENT_ADMISSION_LOCK_KEY,
} from '../worker/admission-policy.js';

type RunRow = {
  id: string;
  schedule_id: string;
  scheduled_for: Date | string;
  task_version: number;
  instruction: string;
  result_chat_id: string;
  result_display_name: string;
  result_chat_type: 'group' | 'p2p';
  context_chat_id: string | null;
  context_display_name: string | null;
  status: ScheduledRunStatus;
  claim_attempt: number;
  leased_until: Date | string | null;
  write_started_at: Date | string | null;
  outcome_category: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapRun(row: RunRow): ScheduledRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: new Date(row.scheduled_for),
    taskVersion: row.task_version,
    instruction: row.instruction,
    resultTarget: {
      chatId: row.result_chat_id,
      displayName: row.result_display_name,
      chatType: row.result_chat_type,
    },
    ...(row.context_chat_id && row.context_display_name
      ? { scheduledContext: { chatId: row.context_chat_id, displayName: row.context_display_name } }
      : {}),
    status: row.status,
    claimAttempt: row.claim_attempt,
    ...(row.leased_until ? { leasedUntil: new Date(row.leased_until) } : {}),
    ...(row.write_started_at ? { writeStartedAt: new Date(row.write_started_at) } : {}),
    ...(row.outcome_category ? { outcomeCategory: row.outcome_category } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export type CreateDueInput = {
  scheduleId: string;
  expectedDueAt: Date;
  scheduledFor: Date;
  nextDueAt?: Date;
};

export type CreateDueResult =
  | { status: 'created'; run: ScheduledRun }
  | { status: 'not_found' | 'not_due' | 'inactive' | 'active_run' };

export class PostgresScheduledRunStore {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<ScheduledRun | undefined> {
    const result = await this.db.execute(sql`select * from scheduled_runs where id = ${id}`);
    const row = result.rows[0] as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  async createDue(input: CreateDueInput): Promise<CreateDueResult> {
    return this.db.transaction(async (tx) => {
      const taskResult = await tx.execute(sql`
        select * from scheduled_tasks where id = ${input.scheduleId} for update
      `);
      const task = taskResult.rows[0] as {
        id: string;
        state: string;
        current_version: number;
        next_due_at: Date | string | null;
        schedule_kind: 'once' | 'cron';
        result_chat_id: string;
        result_display_name: string;
        result_chat_type: 'group' | 'p2p';
        context_chat_id: string | null;
        context_display_name: string | null;
      } | undefined;
      if (!task) return { status: 'not_found' as const };
      if (task.state !== 'active') return { status: 'inactive' as const };
      if (!task.next_due_at || new Date(task.next_due_at).getTime() !== input.expectedDueAt.getTime()) {
        return { status: 'not_due' as const };
      }
      const active = await tx.execute(sql`
        select id from scheduled_runs where schedule_id = ${input.scheduleId}
          and status in ('queued', 'processing') limit 1
      `);
      if (active.rows.length > 0) {
        await tx.execute(sql`
          update scheduled_tasks set latest_missed_at = greatest(
            coalesce(latest_missed_at, ${input.scheduledFor}), ${input.scheduledFor}
          ), next_due_at = ${input.nextDueAt ?? task.next_due_at},
          updated_at = now() where id = ${input.scheduleId}
        `);
        return { status: 'active_run' as const };
      }
      const revisionResult = await tx.execute(sql`
        select instruction from scheduled_task_revisions
        where schedule_id = ${input.scheduleId} and version = ${task.current_version}
      `);
      const instruction = (revisionResult.rows[0] as { instruction: string | null } | undefined)?.instruction;
      if (!instruction) throw new Error('schedule_body_unavailable');
      const created = await tx.execute(sql`
        insert into scheduled_runs (
          id, schedule_id, scheduled_for, task_version, instruction,
          result_chat_id, result_display_name, result_chat_type,
          context_chat_id, context_display_name, delivery_idempotency_key
        ) values (
          ${randomUUID()}, ${input.scheduleId}, ${input.scheduledFor}, ${task.current_version}, ${instruction},
          ${task.result_chat_id}, ${task.result_display_name}, ${task.result_chat_type},
          ${task.context_chat_id}, ${task.context_display_name}, null
        ) returning *
      `);
      const createdRow = created.rows[0] as RunRow;
      await tx.execute(sql`
        update scheduled_runs set delivery_idempotency_key = ${`s:${createdRow.id}:result`}
        where id = ${createdRow.id}
      `);
      await tx.execute(sql`
        update scheduled_tasks set
          state = ${task.schedule_kind === 'once' ? 'in_flight' : 'active'},
          next_due_at = ${task.schedule_kind === 'once' ? null : input.nextDueAt ?? null},
          latest_missed_at = null,
          latest_run_status = 'queued', updated_at = now()
        where id = ${input.scheduleId}
      `);
      return { status: 'created' as const, run: mapRun(createdRow) };
    });
  }

  async claim(id: string, _now: Date, leaseMs: number): Promise<ScheduledRun | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${AGENT_ADMISSION_LOCK_KEY}))`);
      const candidate = await tx.execute(sql`
        select schedule_id from scheduled_runs where id = ${id} and status = 'queued'
      `);
      const scheduleId = (candidate.rows[0] as { schedule_id: string } | undefined)?.schedule_id;
      if (!scheduleId) return undefined;
      const taskResult = await tx.execute(sql`
        select state from scheduled_tasks where id = ${scheduleId} for update
      `);
      const taskState = (taskResult.rows[0] as { state: string } | undefined)?.state;
      if (taskState !== 'active' && taskState !== 'in_flight') return undefined;
      const result = await tx.execute(sql`
        update scheduled_runs set status = 'processing', claim_attempt = claim_attempt + 1,
          leased_until = clock_timestamp() + (${leaseMs} * interval '1 millisecond'), updated_at = now()
        where id = ${id} and status = 'queued'
        returning *
      `);
      const row = result.rows[0] as RunRow | undefined;
      if (!row) return undefined;
      await tx.execute(sql`
        update scheduled_tasks set latest_run_status = 'processing', updated_at = now()
        where id = ${row.schedule_id}
      `);
      return mapRun(row);
    });
  }

  async claimNext(_now: Date, leaseMs: number): Promise<ScheduledRun | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${AGENT_ADMISSION_LOCK_KEY}))`);
      const selected = await tx.execute(sql`
        select run.id, run.schedule_id from scheduled_runs run where run.status = 'queued'
          and not exists (select 1 from scheduled_runs active where active.status = 'processing')
          and (
            (select count(*) from processed_events where status = 'processing')
            + (select count(*) from scheduled_runs where status = 'processing')
          ) < ${AGENT_ADMISSION_CONCURRENCY}
          and not exists (
            select 1 from processed_events waiting
            where waiting.status = 'queued' and waiting.next_attempt_at <= clock_timestamp()
          )
          and not exists (
            select 1 from processed_events event
            where event.status = 'processing' and event.conversation_key = run.result_chat_id
          )
        order by run.scheduled_for, run.created_at limit 1
      `);
      const candidate = selected.rows[0] as { id: string; schedule_id: string } | undefined;
      if (!candidate) return undefined;
      const taskResult = await tx.execute(sql`
        select state from scheduled_tasks where id = ${candidate.schedule_id} for update
      `);
      const taskState = (taskResult.rows[0] as { state: string } | undefined)?.state;
      if (taskState !== 'active' && taskState !== 'in_flight') return undefined;
      const result = await tx.execute(sql`
        update scheduled_runs set status = 'processing', claim_attempt = claim_attempt + 1,
          leased_until = clock_timestamp() + (${leaseMs} * interval '1 millisecond'), updated_at = now()
        where id = ${candidate.id} and status = 'queued' returning *
      `);
      const row = result.rows[0] as RunRow | undefined;
      if (!row) return undefined;
      await tx.execute(sql`
        update scheduled_tasks set latest_run_status = 'processing', updated_at = now()
        where id = ${row.schedule_id}
      `);
      return mapRun(row);
    });
  }

  async prepareDelivery(id: string, claimAttempt: number, text: string): Promise<string> {
    const result = await this.db.execute(sql`
      update scheduled_runs set prepared_result_text = ${text}, delivery_attempted_at = now(),
        updated_at = now()
      where id = ${id} and status = 'processing' and claim_attempt = ${claimAttempt}
        and delivery_attempted_at is null
      returning delivery_idempotency_key
    `);
    const key = (result.rows[0] as { delivery_idempotency_key: string | null } | undefined)
      ?.delivery_idempotency_key;
    if (!key) throw new Error('scheduled_delivery_already_attempted');
    return key;
  }

  async extendLease(id: string, claimAttempt: number, leaseMs: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      update scheduled_runs set
        leased_until = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
        updated_at = now()
      where id = ${id} and status = 'processing' and claim_attempt = ${claimAttempt}
        and leased_until >= clock_timestamp()
      returning id
    `);
    return result.rows.length === 1;
  }

  async markDelivered(id: string, claimAttempt: number, messageId: string): Promise<void> {
    const result = await this.db.execute(sql`
      update scheduled_runs set delivery_message_id = ${messageId}, updated_at = now()
      where id = ${id} and status = 'processing' and claim_attempt = ${claimAttempt}
        and delivery_attempted_at is not null and delivery_message_id is null
      returning id
    `);
    if (result.rows.length !== 1) throw new Error('scheduled_delivery_state_stale');
  }

  async beginFallback(id: string, claimAttempt: number): Promise<string> {
    const result = await this.db.execute(sql`
      update scheduled_runs set fallback_attempted_at = now(), updated_at = now()
      where id = ${id} and status = 'processing' and claim_attempt = ${claimAttempt}
        and fallback_attempted_at is null
      returning id
    `);
    if (result.rows.length !== 1) throw new Error('scheduled_fallback_already_attempted');
    return `s:${id}:fallback`;
  }

  async finishFallback(id: string, messageId?: string, category?: string): Promise<void> {
    await this.db.execute(sql`
      update scheduled_runs set fallback_message_id = ${messageId ?? null},
        fallback_outcome_category = ${category ?? null}, updated_at = now()
      where id = ${id} and fallback_attempted_at is not null
    `);
  }

  async cancelQueuedForTask(scheduleId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      update scheduled_runs set status = 'cancelled', updated_at = now()
      where schedule_id = ${scheduleId} and status = 'queued' returning id
    `);
    return result.rows.length > 0;
  }

  async finish(
    id: string,
    claimAttempt: number,
    outcome: Extract<ScheduledRunStatus, 'completed' | 'failed' | 'delivery_uncertain'>,
    outcomeCategory?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const candidate = await tx.execute(sql`
        select schedule_id from scheduled_runs where id = ${id}
      `);
      const row = candidate.rows[0] as { schedule_id: string } | undefined;
      if (!row) throw new Error('scheduled_run_claim_stale');
      const taskResult = await tx.execute(sql`
        select schedule_kind, state from scheduled_tasks where id = ${row.schedule_id} for update
      `);
      const task = taskResult.rows[0] as { schedule_kind: 'once' | 'cron'; state: string };
      const result = await tx.execute(sql`
        update scheduled_runs set status = ${outcome}, outcome_category = ${outcomeCategory ?? null},
          leased_until = null, updated_at = now()
        where id = ${id} and status = 'processing' and claim_attempt = ${claimAttempt}
        returning id
      `);
      if (result.rows.length !== 1) throw new Error('scheduled_run_claim_stale');
      const terminalOneTime = task.schedule_kind === 'once' && task.state !== 'deleted';
      await tx.execute(sql`
        update scheduled_tasks set
          state = ${terminalOneTime ? 'completed' : task.state},
          name_reserved = ${task.state === 'deleted' || terminalOneTime ? false : true},
          completed_at = ${terminalOneTime ? new Date() : null},
          latest_run_status = ${outcome}, updated_at = now()
        where id = ${row.schedule_id}
      `);
    });
  }

  async recoverExpired(_now: Date): Promise<number> {
    const candidates = await this.db.execute(sql`
      select id, schedule_id from scheduled_runs
      where status = 'processing' and leased_until < clock_timestamp()
      order by leased_until, id
    `);
    let recovered = 0;
    for (const row of candidates.rows as Array<{ id: string; schedule_id: string }>) {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select id from scheduled_tasks where id = ${row.schedule_id} for update`);
        const result = await tx.execute(sql`
          update scheduled_runs set status = 'failed', leased_until = null,
            outcome_category = 'scheduled_run_claim_expired', updated_at = now()
          where id = ${row.id} and status = 'processing' and leased_until < clock_timestamp()
          returning id
        `);
        if (result.rows.length !== 1) return;
        await tx.execute(sql`
          update scheduled_tasks set
            state = case when schedule_kind = 'once' and state <> 'deleted'
              then 'completed' else state end,
            name_reserved = case when schedule_kind = 'once' or state = 'deleted'
              then false else name_reserved end,
            completed_at = case when schedule_kind = 'once' and state <> 'deleted'
              then clock_timestamp() else completed_at end,
            latest_run_status = 'failed', updated_at = now()
          where id = ${row.schedule_id}
        `);
        recovered += 1;
      });
    }
    return recovered;
  }
}
