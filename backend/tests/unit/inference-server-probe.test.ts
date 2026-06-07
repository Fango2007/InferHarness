import { describe, expect, it } from 'vitest';

import { normalizeOpenAiModels } from '../../src/services/inference-server-probe.js';

describe('inference server probe model normalization', () => {
  it('normalizes Mistral OpenAI-compatible model metadata', () => {
    const models = normalizeOpenAiModels({
      object: 'list',
      data: [
        {
          id: 'codestral-latest',
          object: 'model',
          owned_by: 'mistralai',
          name: 'codestral-2508',
          description: 'Our cutting-edge language model for coding released August 2025.',
          max_context_length: 256000,
          aliases: ['codestral-2508', 'mistral-code-latest'],
          deprecation: null,
          deprecation_replacement_model: null,
          default_model_temperature: 0.3,
          type: 'base',
          capabilities: {
            completion_chat: true,
            function_calling: true,
            reasoning: false,
            completion_fim: true,
            vision: false
          }
        }
      ]
    });

    expect(models[0]).toMatchObject({
      model_id: 'codestral-latest',
      display_name: 'codestral-2508',
      context_window_tokens: 256000,
      quantisation: null,
      provider: 'mistralai',
      base_model_name: 'codestral-2508',
      default_temperature: 0.3,
      capabilities: {
        completion_chat: true,
        function_calling: true,
        reasoning: false,
        completion_fim: true,
        vision: false
      },
      raw: {
        id: 'codestral-latest',
        aliases: ['codestral-2508', 'mistral-code-latest'],
        deprecation: null
      }
    });
  });

  it('falls back to the model id when OpenAI-compatible entries do not expose a name', () => {
    const models = normalizeOpenAiModels({
      data: [{ id: 'gpt-oss:20b-q4_k_m' }]
    });

    expect(models[0]).toMatchObject({
      model_id: 'gpt-oss:20b-q4_k_m',
      display_name: 'gpt-oss:20b-q4_k_m'
    });
    expect(models[0].quantisation).toMatchObject({ bits: 4 });
  });
});
