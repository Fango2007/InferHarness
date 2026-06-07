import { describe, expect, it } from 'vitest';

import { normalizeOpenAiModels } from '../../src/services/inference-server-probe.js';

describe('inference server probe model normalization', () => {
  it('keeps only canonical Mistral OpenAI-compatible model metadata', () => {
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
          default_model_temperature: 0.3,
          type: 'base',
          capabilities: {
            completion_chat: true,
            function_calling: true,
            completion_fim: true
          }
        },
        {
          id: 'codestral-2508',
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

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      model_id: 'codestral-2508',
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
        id: 'codestral-2508',
        aliases: ['codestral-2508', 'mistral-code-latest'],
        deprecation: null
      }
    });
  });

  it('keeps OpenAI-compatible aliases for non-Mistral providers', () => {
    const models = normalizeOpenAiModels({
      data: [
        { id: 'vendor-model-latest', owned_by: 'example', name: 'vendor-model-2026' },
        { id: 'vendor-model-2026', owned_by: 'example', name: 'vendor-model-2026' }
      ]
    });

    expect(models.map((model) => model.model_id)).toEqual(['vendor-model-latest', 'vendor-model-2026']);
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
