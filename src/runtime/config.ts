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
  CONVERSATION_CONTEXT_TOKEN_TARGET: z.coerce.number().int().positive().default(24_000),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  ALLOWED_CHAT_IDS: z.string().default(''),
  LARK_CLI_BIN: z.string().default('lark-cli'),
  LARKSUITE_CLI_CONFIG_DIR: z.string().default('/var/lib/minori/lark'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);

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
    conversationContextTokenTarget: parsed.CONVERSATION_CONTEXT_TOKEN_TARGET,
    messageRetentionDays: parsed.MESSAGE_RETENTION_DAYS,
    allowedChatIds: [...new Set(
      parsed.ALLOWED_CHAT_IDS
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )],
    larkCliBin: parsed.LARK_CLI_BIN,
    larkConfigDir: parsed.LARKSUITE_CLI_CONFIG_DIR,
  };
}
