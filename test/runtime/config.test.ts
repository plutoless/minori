import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';

describe('loadConfig', () => {
  it('starts in unconfigured mode without external secrets', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      nodeEnv: 'test',
      port: 3000,
      allowedChatIds: [],
      larkCliBin: 'lark-cli',
      larkConfigDir: '/var/lib/minori/lark',
      aiModel: 'gpt-5.6-terra',
      conversationContextTokenTarget: 24_000,
    });
  });

  it('splits and deduplicates allowed chat ids', () => {
    expect(loadConfig({ ALLOWED_CHAT_IDS: 'oc_a, oc_b,oc_a' }).allowedChatIds)
      .toEqual(['oc_a', 'oc_b']);
  });

  it('accepts an optional OpenAI-compatible base URL', () => {
    expect(loadConfig({ OPENAI_BASE_URL: 'https://llm.example.com/v1' })).toMatchObject({
      openaiBaseUrl: 'https://llm.example.com/v1',
    });
  });

  it('rejects an unsupported log level at the configuration boundary', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose-ish' })).toThrow();
  });
});
