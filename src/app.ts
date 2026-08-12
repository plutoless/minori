import { spawn } from 'node:child_process';
import type { Logger } from 'pino';
import { createAgentModel } from './agent/model.js';
import { runKnowledgeAgent } from './agent/run.js';
import { createAgentInvocationRunner } from './agent/invocation-runner.js';
import { createOfficialFeishuRuntime } from './feishu/client.js';
import { createOfficialLongConnection, FeishuGateway } from './feishu/gateway.js';
import { LarkKnowledgeService } from './lark/knowledge-service.js';
import { LarkMeetingService } from './lark/meeting-service.js';
import { LarkRunner } from './lark/runner.js';
import type { AppConfig } from './runtime/config.js';
import { buildHealthServer, type ComponentStatus, type HealthProbes } from './runtime/health.js';
import { createModelPreflight } from './runtime/model-preflight.js';
import { createStorageRuntime } from './storage/runtime.js';
import { createCalendarCalculator } from './schedule/calendar.js';
import { createScheduleDispatcher, type ScheduleDispatcher } from './schedule/dispatcher.js';
import { createScheduledTaskWorker, type ScheduledTaskWorker } from './schedule/worker.js';
import { DefaultTeamContextSource, type TeamContextSource } from './team-context/source.js';
import { MessageWorker } from './worker/message-worker.js';
import { createAdmissionCoordinator, type AdmissionCoordinator } from './worker/admission-coordinator.js';
import { AGENT_ADMISSION_CONCURRENCY } from './worker/admission-policy.js';

export interface MinoriApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type LongConnection = ReturnType<typeof createOfficialLongConnection>;

export function createApp(config: AppConfig, logger: Logger): MinoriApp {
  const modelPreflight = createModelPreflight(config, {
    logWarning: (details) => logger.warn(details, 'model preflight failed'),
  });
  const storage = createStorageRuntime(config, logger);
  const lark = new LarkRunner({
    binary: config.larkCliBin,
    configDir: config.larkConfigDir,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    spawn,
    onExecution: (metadata) => logger.info(metadata, 'lark command completed'),
  });
  let connection: LongConnection | undefined;
  let worker: MessageWorker | undefined;
  let scheduledWorker: ScheduledTaskWorker | undefined;
  let dispatcher: ScheduleDispatcher | undefined;
  let coordinator: AdmissionCoordinator | undefined;
  let larkStatus: ComponentStatus = 'degraded';
  let larkProbe: Promise<ComponentStatus> | undefined;
  let runtimeInitialization: Promise<void> | undefined;
  let runtimeRetryTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  let workerStatus: ComponentStatus = 'unconfigured';
  let teamContextStatus: ComponentStatus = config.teamContextDocumentToken
    ? 'degraded'
    : 'unconfigured';
  const feishuConfigured = Boolean(
    config.feishuAppId && config.feishuAppSecret && config.feishuBotOpenId,
  );

  const probes = {
    database: async () => storage.databaseStatus(),
    feishu: async () => {
      if (!feishuConfigured) return 'unconfigured';
      return connection?.status() === 'connected' ? 'ok' : 'degraded';
    },
    lark: async () => larkStatus,
    model: async () => modelPreflight.status(),
    retention: async () => storage.retentionStatus(),
    worker: async () => workerStatus,
    teamContext: async () => teamContextStatus,
    scheduler: async () => config.scheduleEnabled
      ? (dispatcher?.status() === 'ok' ? 'ok' : 'degraded')
      : 'ok',
  } satisfies HealthProbes;
  const healthServer = buildHealthServer(probes);
  let started = false;
  let healthStarted = false;

  function probeLarkAuth(): Promise<ComponentStatus> {
    if (larkProbe) return larkProbe;
    larkProbe = lark.run<{
        identity: 'user' | 'bot' | 'none';
        identities: { user: { available: boolean } };
      }>({ id: 'auth.status' })
      .then((auth) => {
        larkStatus = auth.identity === 'user' && auth.identities.user.available
          ? 'ok'
          : 'degraded';
        return larkStatus;
      })
      .catch(() => {
        larkStatus = 'degraded';
        logger.warn({ errorCode: 'lark_auth_probe_failed' }, 'lark auth probe failed');
        return larkStatus;
      })
      .finally(() => {
        larkProbe = undefined;
      });
    return larkProbe;
  }

  async function initializeMessageRuntime() {
    if (worker || shuttingDown) return;
    await probeLarkAuth();

    if (!feishuConfigured
      || !storage.eventStore
      || !storage.conversationStore
      || !storage.agentRunStore
      || modelPreflight.status() !== 'ok'
      || larkStatus !== 'ok') {
      workerStatus = storage.eventStore ? 'degraded' : 'unconfigured';
      return;
    }

    const model = await createAgentModel({
      openaiApiKey: config.openaiApiKey!,
      ...(config.openaiBaseUrl ? { openaiBaseUrl: config.openaiBaseUrl } : {}),
      aiModel: config.aiModel,
    });
    const service = new LarkKnowledgeService(lark);
    const meetingService = new LarkMeetingService(lark, service);
    let teamContextSource: TeamContextSource | undefined;
    if (config.teamContextDocumentToken && storage.teamContextStore) {
      const source = new DefaultTeamContextSource({
        documentToken: config.teamContextDocumentToken,
        tokenBudget: config.teamContextTokenBudget,
        staleMaxMs: config.teamContextStaleMaxMs,
        knowledge: service,
        store: storage.teamContextStore,
      });
      teamContextSource = {
        documentToken: source.documentToken,
        async load(signal) {
          const result = await source.load(signal);
          teamContextStatus = result.status === 'loaded' ? 'ok' : 'degraded';
          return result;
        },
        update: (input, signal) => source.update(input, signal),
      };
    }
    const feishu = createOfficialFeishuRuntime({
      appId: config.feishuAppId!,
      appSecret: config.feishuAppSecret!,
    }, logger);
    const { messenger } = feishu;
    const calendar = createCalendarCalculator();
    const onAgentOperationalError = (
      errorCode: 'search_audit_unavailable' | 'meeting_audit_unavailable',
    ) => {
      logger.warn({ errorCode }, 'agent operational audit unavailable');
    };
    const nextWorker = new MessageWorker({
      eventStore: storage.eventStore,
      conversations: storage.conversationStore,
      loadWriteAttempts: (eventId) => storage.agentRunStore!.listWriteAttempts(eventId),
      messenger,
      logger,
      runAgent: (message, claimAttempt, signal) => {
        if (message.content.kind !== 'text') throw new Error('unsupported_agent_input');
        return runKnowledgeAgent({
          prompt: message.content.text,
          history: [],
          trigger: {
            kind: 'feishu_member',
            senderOpenId: message.senderOpenId,
            chatId: message.chatId,
            chatType: message.chatType,
            occurredAt: message.occurredAt,
          },
        }, {
          model,
          service,
          meetingService,
          eventId: message.eventId,
          claimAttempt,
          modelName: config.aiModel,
          maxSteps: config.agentMaxSteps,
          timeoutMs: config.agentTimeoutMs,
          botOpenId: config.feishuBotOpenId!,
          botAppId: config.feishuAppId!,
          groupContextSource: feishu.groupContext,
          ...(teamContextSource ? { teamContextSource } : {}),
          ...(storage.scheduleStore && storage.scheduledRunStore ? {
            scheduleTools: {
              store: storage.scheduleStore,
              calendar,
              chatDirectory: feishu.chatDirectory,
              defaultTimezone: config.scheduleDefaultTimezone,
              now: () => new Date(),
            },
          } : {}),
          agentRunStore: storage.agentRunStore!,
          onOperationalError: onAgentOperationalError,
          conversationKey: message.conversationKey,
          triggerMessageId: message.messageId,
          conversationStore: storage.conversationStore!,
          contextTokenTarget: config.conversationContextTokenTarget,
        }, signal);
      },
    });
    let nextScheduledWorker: ScheduledTaskWorker | undefined;
    let nextDispatcher: ScheduleDispatcher | undefined;
    let nextCoordinator: AdmissionCoordinator | undefined;
    if (config.scheduleEnabled && storage.scheduleStore && storage.scheduledRunStore) {
      nextScheduledWorker = createScheduledTaskWorker({
        runs: storage.scheduledRunStore,
        schedules: storage.scheduleStore,
        agent: createAgentInvocationRunner(),
        agentDependencies: {
          model,
          service,
          meetingService,
          modelName: config.aiModel,
          maxSteps: config.agentMaxSteps,
          timeoutMs: config.agentTimeoutMs,
          botOpenId: config.feishuBotOpenId!,
          botAppId: config.feishuAppId!,
          groupContextSource: feishu.groupContext,
          ...(teamContextSource ? { teamContextSource } : {}),
          agentRunStore: storage.agentRunStore,
          onOperationalError: onAgentOperationalError,
          contextTokenTarget: config.conversationContextTokenTarget,
        },
        messenger,
        leaseMs: config.scheduleLeaseMs,
      });
      nextDispatcher = createScheduleDispatcher({
        store: storage.scheduleStore,
        runs: storage.scheduledRunStore,
        calendar,
        enabled: true,
        pollMs: config.schedulePollMs,
      });
      nextCoordinator = createAdmissionCoordinator({
        message: nextWorker,
        scheduled: nextScheduledWorker,
        concurrency: AGENT_ADMISSION_CONCURRENCY,
        pollMs: 1_000,
        onError: (errorCode) => logger.warn({ errorCode }, 'admission iteration failed'),
      });
    }
    const gateway = new FeishuGateway({
      botOpenId: config.feishuBotOpenId!,
      botAppId: config.feishuAppId!,
      eventStore: storage.eventStore,
      reactions: messenger,
      messageContext: messenger,
      signalWorker: () => {
        nextWorker.wake();
        nextCoordinator?.wake();
      },
      logger,
    });
    const nextConnection = createOfficialLongConnection({
      appId: config.feishuAppId!,
      appSecret: config.feishuAppSecret!,
    }, gateway);

    await nextWorker.start(nextCoordinator ? false : true);
    nextScheduledWorker?.start(Math.min(config.scheduleLeaseMs / 2, 30_000));
    await nextCoordinator?.start();
    nextDispatcher?.start();
    try {
      await nextConnection.start();
    } catch (error) {
      workerStatus = 'degraded';
      nextDispatcher?.stop();
      await nextCoordinator?.stop();
      await nextScheduledWorker?.stop();
      await nextWorker.stop();
      throw error;
    }
    if (shuttingDown) {
      nextConnection.stop();
      nextDispatcher?.stop();
      await nextCoordinator?.stop();
      await nextScheduledWorker?.stop();
      await nextWorker.stop();
      return;
    }
    connection?.stop();
    connection = nextConnection;
    worker = nextWorker;
    scheduledWorker = nextScheduledWorker;
    dispatcher = nextDispatcher;
    coordinator = nextCoordinator;
    workerStatus = 'ok';
  }

  function ensureMessageRuntime(): Promise<void> {
    if (runtimeInitialization) return runtimeInitialization;
    runtimeInitialization = (async () => {
      if (worker || shuttingDown) return;
      if (modelPreflight.status() !== 'ok') await modelPreflight.refresh();
      await initializeMessageRuntime();
    })().catch(() => {
      workerStatus = 'degraded';
      logger.warn({ errorCode: 'message_runtime_start_failed' }, 'message runtime startup failed');
    }).finally(() => {
      runtimeInitialization = undefined;
    });
    return runtimeInitialization;
  }

  async function maintainRuntime() {
    await probeLarkAuth();
    await ensureMessageRuntime();
  }

  return {
    async start() {
      if (started) return;
      shuttingDown = false;
      await storage.start();
      await modelPreflight.initialize();
      try {
        await healthServer.listen({ port: config.port, host: '0.0.0.0' });
        healthStarted = true;
        await ensureMessageRuntime();
        runtimeRetryTimer = setInterval(() => {
          void maintainRuntime();
        }, 30_000);
        runtimeRetryTimer.unref?.();
      } catch (error) {
        await storage.stop();
        throw error;
      }
      started = true;
      logger.info({ port: config.port }, 'minori service started');
    },

    async stop() {
      shuttingDown = true;
      if (runtimeRetryTimer) {
        clearInterval(runtimeRetryTimer);
        runtimeRetryTimer = undefined;
      }
      await runtimeInitialization;
      connection?.stop();
      connection = undefined;
      dispatcher?.stop();
      dispatcher = undefined;
      if (coordinator) {
        await coordinator.stop();
        coordinator = undefined;
      }
      if (worker) {
        await worker.stop();
        worker = undefined;
      }
      if (scheduledWorker) {
        await scheduledWorker.stop();
      }
      scheduledWorker = undefined;
      workerStatus = 'degraded';
      if (healthStarted) {
        await healthServer.close();
        healthStarted = false;
      }
      await storage.stop();
      if (!started) return;
      started = false;
      logger.info('minori service stopped');
    },
  };
}
