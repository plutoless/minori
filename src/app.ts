import type { AppConfig } from './runtime/config.js';
import { buildHealthServer, type HealthProbes } from './runtime/health.js';
import { createModelPreflight } from './runtime/model-preflight.js';
import type { Logger } from 'pino';
import { createStorageRuntime } from './storage/runtime.js';

export interface MinoriApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApp(config: AppConfig, logger: Logger): MinoriApp {
  const modelPreflight = createModelPreflight(config, {
    logWarning: (details) => logger.warn(details, 'model preflight failed'),
  });
  const storage = createStorageRuntime(config, logger);
  const probes = {
    database: async () => storage.databaseStatus(),
    feishu: async () => 'unconfigured',
    lark: async () => 'unconfigured',
    model: async () => modelPreflight.status(),
    retention: async () => storage.retentionStatus(),
  } satisfies HealthProbes;
  const healthServer = buildHealthServer(probes);
  let started = false;
  let healthStarted = false;

  return {
    async start() {
      if (started) return;
      await modelPreflight.initialize();
      await storage.start();
      try {
        await healthServer.listen({ port: config.port, host: '0.0.0.0' });
        healthStarted = true;
      } catch (error) {
        await storage.stop();
        throw error;
      }
      started = true;
      logger.info({ port: config.port }, 'minori service started');
    },

    async stop() {
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
