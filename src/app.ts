import type { AppConfig } from './runtime/config.js';
import { buildHealthServer, type HealthProbes } from './runtime/health.js';
import { createModelPreflight } from './runtime/model-preflight.js';
import type { Logger } from 'pino';

export interface MinoriApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApp(config: AppConfig, logger: Logger): MinoriApp {
  const modelPreflight = createModelPreflight(config, {
    logWarning: (details) => logger.warn(details, 'model preflight failed'),
  });
  const probes = {
    database: async () => 'unconfigured',
    feishu: async () => 'unconfigured',
    lark: async () => 'unconfigured',
    model: async () => modelPreflight.status(),
    retention: async () => 'unconfigured',
  } satisfies HealthProbes;
  const healthServer = buildHealthServer(probes);
  let started = false;

  return {
    async start() {
      if (started) return;
      await modelPreflight.initialize();
      await healthServer.listen({ port: config.port, host: '0.0.0.0' });
      started = true;
      logger.info({ port: config.port }, 'minori service started');
    },

    async stop() {
      if (!started) return;
      await healthServer.close();
      started = false;
      logger.info('minori service stopped');
    },
  };
}
