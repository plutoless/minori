import { describe, expect, it, vi } from 'vitest';
import { createAgentModel } from '../../src/agent/model.js';

describe('createAgentModel', () => {
  it('constructs a direct OpenAI Responses model after probing an optional base URL', async () => {
    const model = { specificationVersion: 'v4' as const };
    const provider = vi.fn(() => model);
    const createProvider = vi.fn(() => provider);

    const runProbe = vi.fn().mockResolvedValue(undefined);
    await expect(createAgentModel({
      openaiApiKey: 'test-key', openaiBaseUrl: 'https://proxy.example/v1', aiModel: 'gpt-test',
    }, createProvider, runProbe)).resolves.toBe(model);
    expect(runProbe).toHaveBeenCalledWith({
      apiKey: 'test-key', baseURL: 'https://proxy.example/v1', model: 'gpt-test',
    }, expect.any(AbortSignal));
    expect(createProvider).toHaveBeenCalledWith({
      apiKey: 'test-key', baseURL: 'https://proxy.example/v1',
    });
    expect(provider).toHaveBeenCalledWith('gpt-test');
  });

  it('fails clearly when the OpenAI key is missing', async () => {
    await expect(createAgentModel({ aiModel: 'gpt-test' }, vi.fn())).rejects.toThrow(
      'openai_api_key_required',
    );
  });

  it('rejects a custom base URL when its Responses probe fails', async () => {
    await expect(createAgentModel({
      openaiApiKey: 'test-key', openaiBaseUrl: 'https://proxy.example/v1', aiModel: 'gpt-test',
    }, vi.fn(), vi.fn().mockRejectedValue(new Error('chat completions only')))).rejects
      .toThrow('openai_responses_probe_required');
  });
});
