import { z } from 'zod';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.string().url().optional(),
  FEISHU_APP_ID: z.string().min(1).optional(),
  FEISHU_APP_SECRET: z.string().min(1).optional(),
  FEISHU_BOT_OPEN_ID: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  AI_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(40),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(900_000).default(300_000),
  CONVERSATION_CONTEXT_TOKEN_TARGET: z.coerce.number().int().positive().default(24_000),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  TEAM_CONTEXT_DOCUMENT_TOKEN: z.string().min(1).optional(),
  TEAM_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(8_000),
  TEAM_CONTEXT_STALE_MAX_MS: z.coerce.number().int().nonnegative().default(86_400_000),
  SCHEDULE_DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),
  SCHEDULE_ENABLED: z.stringbool().default(true),
  SCHEDULE_POLL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  SCHEDULE_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(420_000),
  LARK_CLI_BIN: z.string().default('lark-cli'),
  LARKSUITE_CLI_CONFIG_DIR: z.string().default('/var/lib/minori/lark'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.SCHEDULE_DEFAULT_TIMEZONE }).format(0);
  } catch {
    throw new Error('schedule_default_timezone_invalid');
  }
  if (parsed.SCHEDULE_ENABLED && parsed.SCHEDULE_LEASE_MS < parsed.AGENT_TIMEOUT_MS + 90_000) {
    throw new Error('schedule_lease_must_cover_agent_and_delivery');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
    feishuBotOpenId: parsed.FEISHU_BOT_OPEN_ID,
    openaiApiKey: parsed.OPENAI_API_KEY,
    openaiBaseUrl: parsed.OPENAI_BASE_URL,
    aiModel: parsed.AI_MODEL,
    agentMaxSteps: parsed.AGENT_MAX_STEPS,
    agentTimeoutMs: parsed.AGENT_TIMEOUT_MS,
    conversationContextTokenTarget: parsed.CONVERSATION_CONTEXT_TOKEN_TARGET,
    messageRetentionDays: parsed.MESSAGE_RETENTION_DAYS,
    teamContextDocumentToken: parsed.TEAM_CONTEXT_DOCUMENT_TOKEN,
    teamContextTokenBudget: parsed.TEAM_CONTEXT_TOKEN_BUDGET,
    teamContextStaleMaxMs: parsed.TEAM_CONTEXT_STALE_MAX_MS,
    scheduleDefaultTimezone: parsed.SCHEDULE_DEFAULT_TIMEZONE,
    scheduleEnabled: parsed.SCHEDULE_ENABLED,
    schedulePollMs: parsed.SCHEDULE_POLL_MS,
    scheduleLeaseMs: parsed.SCHEDULE_LEASE_MS,
    larkCliBin: parsed.LARK_CLI_BIN,
    larkConfigDir: parsed.LARKSUITE_CLI_CONFIG_DIR,
  };
}
