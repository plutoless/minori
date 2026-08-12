import type { Logger } from 'pino';
import type { AppConfig } from '../runtime/config.js';
import type { ComponentStatus } from '../runtime/health.js';
import { PostgresAgentRunStore } from './agent-run-store.js';
import { PostgresConversationStore } from './conversation-store.js';
import { createDatabase, type DatabaseHandle } from './database.js';
import { PostgresEventStore } from './event-store.js';
import { createRetentionService, type RetentionService } from './retention.js';
import { PostgresTeamContextStore } from './team-context-store.js';
import { PostgresScheduleStore } from './schedule-store.js';
import { PostgresScheduledRunStore } from './scheduled-run-store.js';

export type StorageRuntime = {
  eventStore?: PostgresEventStore;
  conversationStore?: PostgresConversationStore;
  agentRunStore?: PostgresAgentRunStore;
  teamContextStore?: PostgresTeamContextStore;
  scheduleStore?: PostgresScheduleStore;
  scheduledRunStore?: PostgresScheduledRunStore;
  databaseStatus(): Promise<ComponentStatus>;
  retentionStatus(): ComponentStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

export function createStorageRuntime(config: AppConfig, logger: Logger): StorageRuntime {
  if (!config.databaseUrl) {
    return {
      async databaseStatus() { return 'unconfigured'; },
      retentionStatus() { return 'unconfigured'; },
      async start() {},
      async stop() {},
    };
  }

  const database: DatabaseHandle = createDatabase(config.databaseUrl);
  const conversationStore = new PostgresConversationStore(database.db, {
    retentionMs: config.messageRetentionDays * DAY_MS,
  });
  const scheduleStore = new PostgresScheduleStore(database.db);
  const agentRunStore = new PostgresAgentRunStore(database.db);
  let currentRetentionStatus: ComponentStatus = 'degraded';
  const retention: RetentionService = createRetentionService({
    async purgeExpired(before) {
      const messages = await conversationStore.purgeExpired(before);
      const agentFailures = await agentRunStore.purgeFailureDetails(before);
      const schedules = await scheduleStore.purgeTerminalBodies(new Date());
      return messages + agentFailures + schedules;
    },
  }, {
    retentionMs: config.messageRetentionDays * DAY_MS,
    onSuccess: () => { currentRetentionStatus = 'ok'; },
    onError: (details) => {
      currentRetentionStatus = 'degraded';
      logger.warn(details, 'retention purge failed');
    },
  });
  let started = false;
  let stopped = false;

  return {
    eventStore: new PostgresEventStore(database.db),
    conversationStore,
    agentRunStore,
    teamContextStore: new PostgresTeamContextStore(database.db),
    scheduleStore,
    scheduledRunStore: new PostgresScheduledRunStore(database.db),
    async databaseStatus() {
      if (stopped) return 'degraded';
      try {
        await database.pool.query('select 1');
        return 'ok';
      } catch {
        return 'degraded';
      }
    },
    retentionStatus() {
      return currentRetentionStatus;
    },
    async start() {
      if (started || stopped) return;
      started = true;
      try {
        await retention.start();
      } catch {
        logger.warn({ errorCode: 'storage_start_failed' }, 'storage startup failed');
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      retention.stop();
      await database.close();
    },
  };
}
