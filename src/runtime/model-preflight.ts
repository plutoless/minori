import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { ComponentStatus } from './health.js';

export type ModelProbeSettings = {
  apiKey: string;
  baseURL?: string;
  model: string;
};

export type ModelProbeRunner = (
  settings: ModelProbeSettings,
  signal: AbortSignal,
) => Promise<void>;

export type ModelPreflight = {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  status(): ComponentStatus;
};

type ModelPreflightOptions = {
  runProbe?: ModelProbeRunner;
  timeoutMs?: number;
  logWarning?: (details: { errorCode: 'model_preflight_failed' }) => void;
};

export async function runOpenAIResponsesProbe(
  settings: ModelProbeSettings,
  signal: AbortSignal,
): Promise<void> {
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
  });
  const result = await generateText({
    model: provider(settings.model),
    prompt: 'Call the readinessCheck tool exactly once.',
    tools: {
      readinessCheck: tool({
        description: 'Confirms that structured Responses API tool calls work.',
        inputSchema: z.object({ protocol: z.literal('responses') }),
        execute: async () => ({ ok: true }),
      }),
    },
    toolChoice: { type: 'tool', toolName: 'readinessCheck' },
    providerOptions: { openai: { store: false } },
    abortSignal: signal,
  });

  if (!result.toolCalls.some((call) => call.toolName === 'readinessCheck')) {
    throw new Error('structured_tool_call_missing');
  }
}

export function createModelPreflight(
  config: AppConfig,
  options: ModelPreflightOptions = {},
): ModelPreflight {
  const runProbe = options.runProbe ?? runOpenAIResponsesProbe;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let currentStatus: ComponentStatus = config.openaiApiKey ? 'degraded' : 'unconfigured';
  let initialization: Promise<void> | undefined;
  let activeProbe: Promise<void> | undefined;

  async function performInitialization() {
    if (!config.openaiApiKey) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await runProbe({
        apiKey: config.openaiApiKey,
        ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
        model: config.aiModel,
      }, controller.signal);
      currentStatus = 'ok';
    } catch {
      currentStatus = 'degraded';
      options.logWarning?.({ errorCode: 'model_preflight_failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  function runProbeOnce() {
    activeProbe ??= performInitialization().finally(() => {
      activeProbe = undefined;
    });
    return activeProbe;
  }

  return {
    initialize() {
      initialization ??= runProbeOnce();
      return initialization;
    },
    refresh() {
      return runProbeOnce();
    },
    status() {
      return currentStatus;
    },
  };
}
