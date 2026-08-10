import { sql } from 'drizzle-orm';

import type {
  CalendarSchedule,
  ScheduledContext,
  ScheduledTask,
  ScheduleTarget,
} from '../schedule/types.js';
import type { Database } from './database.js';

export type CreateScheduleInput = {
  name: string;
  creatorOpenId: string;
  actorOpenId: string;
  origin: ScheduleTarget;
  instruction: string;
  schedule: CalendarSchedule;
  resultTarget: ScheduleTarget;
  scheduledContext?: ScheduledContext;
  nextDueAt: Date;
};

export type ScheduleChanges = {
  name?: string;
  instruction?: string;
  schedule?: CalendarSchedule;
  resultTarget?: ScheduleTarget;
  scheduledContext?: ScheduledContext | null;
  nextDueAt?: Date;
};

export type ScheduleMutationResult =
  | { status: 'updated'; task: ScheduledTask }
  | { status: 'not_found' }
  | { status: 'version_conflict'; task: ScheduledTask }
  | { status: 'name_conflict'; task: ScheduledTask }
  | { status: 'in_flight_update_requires_pause'; task: ScheduledTask }
  | { status: 'invalid_state'; task: ScheduledTask };

type TaskRow = {
  id: string;
  name: string;
  creator_open_id: string;
  origin_chat_id: string;
  origin_display_name: string;
  origin_chat_type: 'group' | 'p2p';
  current_version: number;
  instruction: string | null;
  schedule_kind: 'once' | 'cron';
  once_at: Date | string | null;
  cron_expression: string | null;
  timezone: string;
  result_chat_id: string;
  result_display_name: string;
  result_chat_type: 'group' | 'p2p';
  context_chat_id: string | null;
  context_display_name: string | null;
  state: ScheduledTask['state'];
  name_reserved: boolean;
  next_due_at: Date | string | null;
  latest_missed_at: Date | string | null;
  latest_run_status: ScheduledTask['latestRunStatus'] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const TASK_SELECT = sql.raw(`
  select task.*, revision.instruction
  from scheduled_tasks task
  left join scheduled_task_revisions revision
    on revision.schedule_id = task.id and revision.version = task.current_version
`);

function asSchedule(row: TaskRow): CalendarSchedule {
  if (row.schedule_kind === 'once' && row.once_at) {
    return { kind: 'once', at: new Date(row.once_at), timezone: row.timezone };
  }
  if (row.schedule_kind === 'cron' && row.cron_expression) {
    return { kind: 'cron', expression: row.cron_expression, timezone: row.timezone };
  }
  throw new Error('schedule_definition_invalid');
}

function mapTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    creatorOpenId: row.creator_open_id,
    origin: {
      chatId: row.origin_chat_id,
      displayName: row.origin_display_name,
      chatType: row.origin_chat_type,
    },
    ...(row.instruction === null ? {} : { instruction: row.instruction }),
    version: row.current_version,
    schedule: asSchedule(row),
    resultTarget: {
      chatId: row.result_chat_id,
      displayName: row.result_display_name,
      chatType: row.result_chat_type,
    },
    ...(row.context_chat_id && row.context_display_name
      ? { scheduledContext: { chatId: row.context_chat_id, displayName: row.context_display_name } }
      : {}),
    state: row.state,
    nameReserved: row.name_reserved,
    ...(row.next_due_at ? { nextDueAt: new Date(row.next_due_at) } : {}),
    ...(row.latest_missed_at ? { latestMissedAt: new Date(row.latest_missed_at) } : {}),
    ...(row.latest_run_status ? { latestRunStatus: row.latest_run_status } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function readTask(executor: { execute: Database['execute'] }, id: string, lock = false) {
  const result = await executor.execute(sql`${TASK_SELECT} where task.id = ${id} ${sql.raw(lock ? 'for update of task' : '')}`);
  const row = result.rows[0] as TaskRow | undefined;
  return row ? mapTask(row) : undefined;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && (error as { code?: unknown }).code) {
    return String((error as { code?: unknown }).code);
  }
  return 'cause' in error ? databaseErrorCode((error as { cause?: unknown }).cause) : undefined;
}

export class PostgresScheduleStore {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<ScheduledTask | undefined> {
    return readTask(this.db, id);
  }

  async list(includeHistory = false): Promise<ScheduledTask[]> {
    const condition = includeHistory
      ? sql``
      : sql`where task.state in ('active', 'paused', 'in_flight')`;
    const result = await this.db.execute(sql`${TASK_SELECT} ${condition} order by task.created_at, task.id`);
    return (result.rows as TaskRow[]).map(mapTask);
  }

  async create(input: CreateScheduleInput): Promise<
    { status: 'created'; task: ScheduledTask } | { status: 'name_conflict'; task: ScheduledTask }
  > {
    try {
      return await this.db.transaction(async (tx) => {
        const onceAt = input.schedule.kind === 'once' ? input.schedule.at : null;
        const cronExpression = input.schedule.kind === 'cron' ? input.schedule.expression : null;
        const created = await tx.execute(sql`
          insert into scheduled_tasks (
            name, creator_open_id, origin_chat_id, origin_display_name, origin_chat_type,
            schedule_kind, once_at, cron_expression, timezone,
            result_chat_id, result_display_name, result_chat_type,
            context_chat_id, context_display_name, next_due_at
          ) values (
            ${input.name}, ${input.creatorOpenId}, ${input.origin.chatId},
            ${input.origin.displayName}, ${input.origin.chatType}, ${input.schedule.kind},
            ${onceAt}, ${cronExpression}, ${input.schedule.timezone},
            ${input.resultTarget.chatId}, ${input.resultTarget.displayName},
            ${input.resultTarget.chatType}, ${input.scheduledContext?.chatId ?? null},
            ${input.scheduledContext?.displayName ?? null}, ${input.nextDueAt}
          ) returning id
        `);
        const id = String((created.rows[0] as { id: string }).id);
        await tx.execute(sql`
          insert into scheduled_task_revisions (
            schedule_id, version, actor_open_id, instruction,
            schedule_kind, once_at, cron_expression, timezone,
            result_chat_id, result_display_name, result_chat_type,
            context_chat_id, context_display_name
          ) values (
            ${id}, 1, ${input.actorOpenId}, ${input.instruction},
            ${input.schedule.kind}, ${onceAt}, ${cronExpression}, ${input.schedule.timezone},
            ${input.resultTarget.chatId}, ${input.resultTarget.displayName},
            ${input.resultTarget.chatType}, ${input.scheduledContext?.chatId ?? null},
            ${input.scheduledContext?.displayName ?? null}
          )
        `);
        const task = await readTask(tx, id);
        if (!task) throw new Error('schedule_not_created');
        return { status: 'created' as const, task };
      });
    } catch (error) {
      if (databaseErrorCode(error) !== '23505') throw error;
      const result = await this.db.execute(sql`${TASK_SELECT}
        where task.name_reserved = true and lower(task.name) = lower(${input.name}) limit 1`);
      const row = result.rows[0] as TaskRow | undefined;
      if (!row) throw error;
      return { status: 'name_conflict', task: mapTask(row) };
    }
  }

  async update(
    id: string,
    expectedVersion: number,
    actorOpenId: string,
    changes: ScheduleChanges,
  ): Promise<ScheduleMutationResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await readTask(tx, id, true);
        if (!current) return { status: 'not_found' as const };
        if (current.version !== expectedVersion) {
          return { status: 'version_conflict' as const, task: current };
        }
        if (current.state === 'in_flight') {
          return { status: 'in_flight_update_requires_pause' as const, task: current };
        }
        if (current.state === 'completed' || current.state === 'deleted') {
          return { status: 'invalid_state' as const, task: current };
        }
        const next = {
          name: changes.name ?? current.name,
          instruction: changes.instruction ?? current.instruction,
          schedule: changes.schedule ?? current.schedule,
          resultTarget: changes.resultTarget ?? current.resultTarget,
          scheduledContext: changes.scheduledContext === null
            ? undefined
            : changes.scheduledContext ?? current.scheduledContext,
          nextDueAt: changes.nextDueAt ?? current.nextDueAt,
        };
        if (!next.instruction || !next.nextDueAt) throw new Error('schedule_body_purged');
        const version = current.version + 1;
        const onceAt = next.schedule.kind === 'once' ? next.schedule.at : null;
        const cronExpression = next.schedule.kind === 'cron' ? next.schedule.expression : null;
        await tx.execute(sql`
          update scheduled_tasks set
            name = ${next.name}, current_version = ${version},
            schedule_kind = ${next.schedule.kind}, once_at = ${onceAt},
            cron_expression = ${cronExpression}, timezone = ${next.schedule.timezone},
            result_chat_id = ${next.resultTarget.chatId},
            result_display_name = ${next.resultTarget.displayName},
            result_chat_type = ${next.resultTarget.chatType},
            context_chat_id = ${next.scheduledContext?.chatId ?? null},
            context_display_name = ${next.scheduledContext?.displayName ?? null},
            next_due_at = ${next.nextDueAt}, updated_at = now()
          where id = ${id}
        `);
        await tx.execute(sql`
          insert into scheduled_task_revisions (
            schedule_id, version, actor_open_id, instruction,
            schedule_kind, once_at, cron_expression, timezone,
            result_chat_id, result_display_name, result_chat_type,
            context_chat_id, context_display_name
          ) values (
            ${id}, ${version}, ${actorOpenId}, ${next.instruction},
            ${next.schedule.kind}, ${onceAt}, ${cronExpression}, ${next.schedule.timezone},
            ${next.resultTarget.chatId}, ${next.resultTarget.displayName},
            ${next.resultTarget.chatType}, ${next.scheduledContext?.chatId ?? null},
            ${next.scheduledContext?.displayName ?? null}
          )
        `);
        const task = await readTask(tx, id);
        if (!task) throw new Error('schedule_not_updated');
        return { status: 'updated' as const, task };
      });
    } catch (error) {
      if (databaseErrorCode(error) !== '23505') throw error;
      const result = await this.db.execute(sql`${TASK_SELECT}
        where task.name_reserved = true and lower(task.name) = lower(${changes.name ?? ''}) limit 1`);
      const row = result.rows[0] as TaskRow | undefined;
      if (!row) throw error;
      return { status: 'name_conflict', task: mapTask(row) };
    }
  }

  async pause(id: string, expectedVersion: number, actorOpenId: string): Promise<ScheduleMutationResult> {
    return this.transition(id, expectedVersion, actorOpenId, 'paused');
  }

  async resume(
    id: string,
    expectedVersion: number,
    actorOpenId: string,
    nextDueAt: Date,
  ): Promise<ScheduleMutationResult> {
    return this.transition(id, expectedVersion, actorOpenId, 'active', nextDueAt);
  }

  async delete(id: string, expectedVersion: number, actorOpenId: string): Promise<ScheduleMutationResult> {
    return this.transition(id, expectedVersion, actorOpenId, 'deleted');
  }

  private async transition(
    id: string,
    expectedVersion: number,
    actorOpenId: string,
    target: 'active' | 'paused' | 'deleted',
    nextDueAt?: Date,
  ): Promise<ScheduleMutationResult> {
    return this.db.transaction(async (tx) => {
      const current = await readTask(tx, id, true);
      if (!current) return { status: 'not_found' as const };
      if (current.version !== expectedVersion) return { status: 'version_conflict' as const, task: current };
      if (current.state === 'completed' || current.state === 'deleted') {
        return { status: 'invalid_state' as const, task: current };
      }
      if (target === 'active' && current.state !== 'paused') {
        return { status: 'invalid_state' as const, task: current };
      }
      const version = current.version + 1;
      const active = await tx.execute(sql`
        select id, status from scheduled_runs where schedule_id = ${id}
          and status in ('queued', 'processing') for update
      `);
      const processing = active.rows.some((row) => (row as { status?: string }).status === 'processing');
      const nameReserved = target !== 'deleted' || processing;
      await tx.execute(sql`
        update scheduled_tasks set state = ${target}, current_version = ${version},
          name_reserved = ${nameReserved},
          next_due_at = ${target === 'active' ? nextDueAt ?? current.nextDueAt ?? null : null},
          deleted_at = ${target === 'deleted' ? new Date() : null}, updated_at = now()
        where id = ${id}
      `);
      if (target !== 'active') {
        await tx.execute(sql`
          update scheduled_runs set status = 'cancelled', updated_at = now()
          where schedule_id = ${id} and status = 'queued'
        `);
      }
      if (!current.instruction) throw new Error('schedule_body_purged');
      const onceAt = current.schedule.kind === 'once' ? current.schedule.at : null;
      const cronExpression = current.schedule.kind === 'cron' ? current.schedule.expression : null;
      await tx.execute(sql`
        insert into scheduled_task_revisions (
          schedule_id, version, actor_open_id, instruction,
          schedule_kind, once_at, cron_expression, timezone,
          result_chat_id, result_display_name, result_chat_type,
          context_chat_id, context_display_name
        ) values (
          ${id}, ${version}, ${actorOpenId}, ${current.instruction},
          ${current.schedule.kind}, ${onceAt}, ${cronExpression}, ${current.schedule.timezone},
          ${current.resultTarget.chatId}, ${current.resultTarget.displayName},
          ${current.resultTarget.chatType}, ${current.scheduledContext?.chatId ?? null},
          ${current.scheduledContext?.displayName ?? null}
        )
      `);
      const task = await readTask(tx, id);
      if (!task) throw new Error('schedule_not_updated');
      return { status: 'updated' as const, task };
    });
  }

  async purgeTerminalBodies(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        update scheduled_tasks set body_purged_at = ${now}, updated_at = now()
        where state in ('completed', 'deleted') and body_purged_at is null
          and coalesce(completed_at, deleted_at) < ${cutoff}
        returning id
      `);
      const ids = rows.rows.map((row) => String((row as { id: string }).id));
      for (const id of ids) {
        await tx.execute(sql`
          update scheduled_task_revisions set instruction = null, body_purged_at = ${now}
          where schedule_id = ${id}
        `);
      }
      return ids.length;
    });
  }
}
