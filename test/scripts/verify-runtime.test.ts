import { describe, expect, it, vi } from 'vitest';
import { verifyRuntime } from '../../scripts/verify-runtime.js';

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
});
