import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/runtime/config.js';

describe('loadConfig', () => {
  it('starts in unconfigured mode without external secrets', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      nodeEnv: 'test',
      port: 3000,
      larkCliBin: 'lark-cli',
      larkConfigDir: '/var/lib/minori/lark',
      aiModel: 'gpt-5.6-terra',
      agentMaxSteps: 40,
      agentTimeoutMs: 300_000,
      conversationContextTokenTarget: 24_000,
      messageRetentionDays: 30,
      teamContextTokenBudget: 8_000,
      teamContextStaleMaxMs: 86_400_000,
    });
  });

  it('accepts one optional bounded Team Context document configuration', () => {
    expect(loadConfig({
      TEAM_CONTEXT_DOCUMENT_TOKEN: 'dox_team',
      TEAM_CONTEXT_TOKEN_BUDGET: '7000',
      TEAM_CONTEXT_STALE_MAX_MS: '3600000',
    })).toMatchObject({
      teamContextDocumentToken: 'dox_team',
      teamContextTokenBudget: 7_000,
      teamContextStaleMaxMs: 3_600_000,
    });
    expect(() => loadConfig({ TEAM_CONTEXT_DOCUMENT_TOKEN: '' })).toThrow();
    expect(() => loadConfig({ TEAM_CONTEXT_TOKEN_BUDGET: '0' })).toThrow();
    expect(() => loadConfig({ TEAM_CONTEXT_STALE_MAX_MS: '-1' })).toThrow();
  });

  it('accepts bounded Agent execution limits', () => {
    expect(loadConfig({ AGENT_MAX_STEPS: '30', AGENT_TIMEOUT_MS: '240000' }))
      .toMatchObject({ agentMaxSteps: 30, agentTimeoutMs: 240_000 });
    expect(() => loadConfig({ AGENT_MAX_STEPS: '0' })).toThrow();
    expect(() => loadConfig({ AGENT_MAX_STEPS: '101' })).toThrow();
    expect(() => loadConfig({ AGENT_TIMEOUT_MS: '999' })).toThrow();
    expect(() => loadConfig({ AGENT_TIMEOUT_MS: '900001' })).toThrow();
  });

  it('ignores obsolete allowed-chat configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ALLOWED_CHAT_IDS: 'obsolete-value-must-be-ignored',
    });
    expect(config).not.toHaveProperty('allowedChatIds');
  });

  it('accepts an optional OpenAI-compatible base URL', () => {
    expect(loadConfig({ OPENAI_BASE_URL: 'https://llm.example.com/v1' })).toMatchObject({
      openaiBaseUrl: 'https://llm.example.com/v1',
    });
  });

  it('accepts the dedicated Feishu bot identity used for mention detection', () => {
    expect(loadConfig({ FEISHU_BOT_OPEN_ID: 'ou_bot' }).feishuBotOpenId).toBe('ou_bot');
  });

  it('rejects an unsupported log level at the configuration boundary', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose-ish' })).toThrow();
  });

  it('accepts a configurable positive message retention period', () => {
    expect(loadConfig({ MESSAGE_RETENTION_DAYS: '45' }).messageRetentionDays).toBe(45);
    expect(() => loadConfig({ MESSAGE_RETENTION_DAYS: '0' })).toThrow();
  });
});
