import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyLarkAuth, verifyRuntime } from '../../scripts/verify-runtime.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyRuntime', () => {
  it('reports only component categories and succeeds when every dependency is ready', async () => {
    const result = await verifyRuntime({
      database: vi.fn(async () => 'ok'),
      feishu: vi.fn(async () => 'ok'),
      lark: vi.fn(async () => 'ok'),
      model: vi.fn(async () => 'ok'),
    });

    expect(result).toEqual({
      ok: true,
      components: { database: 'ok', feishu: 'ok', lark: 'ok', model: 'ok' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('fails closed and redacts rejected dependency details', async () => {
    const result = await verifyRuntime({
      database: vi.fn(async () => { throw new Error('postgres://user:secret@host/db'); }),
      feishu: vi.fn(async () => 'ok'),
      lark: vi.fn(async () => 'unconfigured'),
      model: vi.fn(async () => 'degraded'),
    });

    expect(result).toEqual({
      ok: false,
      components: {
        database: 'degraded', feishu: 'ok', lark: 'unconfigured', model: 'degraded',
      },
    });
    expect(JSON.stringify(result)).not.toContain('postgres');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    ['a relative config directory', './config', '/var/lib/minori/lark/data'],
    ['a relative data directory', '/var/lib/minori/lark/config', './data'],
  ])('marks Lark unconfigured for %s without exposing directory details', async (_label, configDir, dataDir) => {
    const status = await verifyLarkAuth('lark-cli', configDir, dataDir);

    expect(status).toBe('unconfigured');
    expect(JSON.stringify({ lark: status })).not.toContain(configDir);
    expect(JSON.stringify({ lark: status })).not.toContain(dataDir);
  });

  it('passes the persistent Lark home through to the CLI health check', async () => {
    vi.stubEnv('HOME', '/var/lib/minori/lark/home');
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);

    const result = verifyLarkAuth(
      'lark-cli', '/var/lib/minori/lark/config', '/var/lib/minori/lark/data',
    );
    queueMicrotask(() => {
      stdout.emit('data', JSON.stringify({
        identity: 'user', identities: { user: { available: true } },
      }));
      child.emit('close', 0);
    });

    await expect(result).resolves.toBe('ok');
    expect(vi.mocked(spawn).mock.lastCall?.[2]?.env).toMatchObject({
      HOME: '/var/lib/minori/lark/home',
    });
  });
});
