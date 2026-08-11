import { describe, expect, it } from 'vitest';
import { buildHealthServer } from '../../src/runtime/health.js';

describe('buildHealthServer', () => {
  it('reports liveness without running dependency probes', async () => {
    let probeCalls = 0;
    const app = buildHealthServer({
      database: async () => {
        probeCalls += 1;
        return 'ok';
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(probeCalls).toBe(0);
    await app.close();
  });

  it('reports component readiness without exposing details', async () => {
    const app = buildHealthServer({
      database: async () => 'ok',
      model: async () => 'unconfigured',
      worker: async () => 'ok',
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      components: { database: 'ok', model: 'unconfigured', worker: 'ok' },
    });
    await app.close();
  });

  it('turns a rejected probe into a redacted degraded status', async () => {
    const app = buildHealthServer({
      database: async () => {
        throw new Error('postgres://user:secret@example.com/minori');
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
    expect(response.json()).toEqual({
      status: 'degraded',
      components: { database: 'degraded' },
    });
    await app.close();
  });

  it('reports degraded Team Context without blocking core service readiness', async () => {
    const app = buildHealthServer({
      database: async () => 'ok',
      feishu: async () => 'ok',
      lark: async () => 'ok',
      model: async () => 'ok',
      retention: async () => 'ok',
      worker: async () => 'ok',
      teamContext: async () => 'degraded',
      scheduler: async () => 'degraded',
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      components: {
        database: 'ok', feishu: 'ok', lark: 'ok', model: 'ok',
        retention: 'ok', worker: 'ok', teamContext: 'degraded', scheduler: 'degraded',
      },
    });
    await app.close();
  });
});
