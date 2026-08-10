import Fastify, { type FastifyInstance } from 'fastify';

export type ComponentStatus = 'ok' | 'degraded' | 'unconfigured';
export type HealthComponent =
  | 'database' | 'feishu' | 'lark' | 'model' | 'retention' | 'worker'
  | 'teamContext';
export type HealthProbes = Partial<Record<HealthComponent, () => Promise<ComponentStatus>>>;

export function buildHealthServer(probes: HealthProbes): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health/live', async () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply) => {
    const entries = await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => {
        try {
          return [name, await probe()] as const;
        } catch {
          return [name, 'degraded'] as const;
        }
      }),
    );
    const components = Object.fromEntries(entries) as Partial<Record<HealthComponent, ComponentStatus>>;
    const blockingComponents = Object.entries(components)
      .filter(([name]) => name !== 'teamContext')
      .map(([, value]) => value);
    const status = blockingComponents.every((value) => value === 'ok')
      ? 'ok'
      : 'degraded';

    return reply
      .code(status === 'ok' ? 200 : 503)
      .send({ status, components });
  });

  return app;
}
