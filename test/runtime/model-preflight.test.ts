import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';
import { createModelPreflight } from '../../src/runtime/model-preflight.js';

describe('createModelPreflight', () => {
  it('remains unconfigured and makes no request without an API key', async () => {
    const runProbe = vi.fn();
    const preflight = createModelPreflight(loadConfig({ NODE_ENV: 'test' }), { runProbe });

    await preflight.initialize();

    expect(preflight.status()).toBe('unconfigured');
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('runs once and caches a successful Responses tool-call check', async () => {
    const runProbe = vi.fn().mockResolvedValue(undefined);
    const preflight = createModelPreflight(loadConfig({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: 'https://llm.example.com/v1',
    }), { runProbe });

    await preflight.initialize();
    await preflight.initialize();

    expect(preflight.status()).toBe('ok');
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      baseURL: 'https://llm.example.com/v1',
      model: 'gpt-5.6-terra',
    }), expect.any(AbortSignal));
  });

  it('degrades on a bounded failure and logs only a stable category', async () => {
    const warnings: unknown[] = [];
    const runProbe = vi.fn((_settings, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Bearer leaked-secret')), { once: true });
    }));
    const preflight = createModelPreflight(loadConfig({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'test-key',
    }), {
      runProbe,
      timeoutMs: 5,
      logWarning: (details) => warnings.push(details),
    });

    await preflight.initialize();

    expect(preflight.status()).toBe('degraded');
    expect(JSON.stringify(warnings)).toBe('[{"errorCode":"model_preflight_failed"}]');
  });

  it('can recover a degraded startup probe without restarting the process', async () => {
    const runProbe = vi.fn()
      .mockRejectedValueOnce(new Error('temporary upstream failure'))
      .mockResolvedValueOnce(undefined);
    const preflight = createModelPreflight(loadConfig({
      NODE_ENV: 'test', OPENAI_API_KEY: 'test-key',
    }), { runProbe });

    await preflight.initialize();
    expect(preflight.status()).toBe('degraded');
    await preflight.refresh();

    expect(preflight.status()).toBe('ok');
    expect(runProbe).toHaveBeenCalledTimes(2);
  });
});
