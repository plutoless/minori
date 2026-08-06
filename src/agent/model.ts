import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import {
  runOpenAIResponsesProbe,
  type ModelProbeRunner,
} from '../runtime/model-preflight.js';

export type AgentModelConfig = {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  aiModel: string;
};

type OpenAIProviderFactory = (settings: {
  apiKey: string;
  baseURL?: string;
}) => (model: string) => LanguageModel;

export async function createAgentModel(
  config: AgentModelConfig,
  createProvider: OpenAIProviderFactory = createOpenAI,
  runProbe: ModelProbeRunner = runOpenAIResponsesProbe,
): Promise<LanguageModel> {
  if (!config.openaiApiKey) throw new Error('openai_api_key_required');
  if (config.openaiBaseUrl) {
    const signal = AbortSignal.timeout(10_000);
    try {
      await runProbe({
        apiKey: config.openaiApiKey,
        baseURL: config.openaiBaseUrl,
        model: config.aiModel,
      }, signal);
    } catch {
      throw new Error('openai_responses_probe_required');
    }
  }
  const provider = createProvider({
    apiKey: config.openaiApiKey,
    ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  });
  return provider(config.aiModel);
}
