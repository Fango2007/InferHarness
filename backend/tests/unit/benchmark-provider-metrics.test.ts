import { describe, expect, it } from 'vitest';

import {
  normalizeProviderMetricObservations,
  type MetricObservation,
  type ProviderMetricContext
} from '../../src/services/benchmark-provider-metrics.js';

function context(overrides: Partial<ProviderMetricContext> = {}): ProviderMetricContext {
  return {
    protocol: 'openai_chat',
    provider_id: 'server-1',
    provider_name: 'OpenAI',
    provider_version: '2026-07-01',
    ...overrides
  };
}

function observation(
  observations: MetricObservation[],
  metricId: string
): MetricObservation {
  const result = observations.find((candidate) => candidate.metric_id === metricId);
  expect(result, `Missing observation: ${metricId}`).toBeDefined();
  return result as MetricObservation;
}

describe('normalizeProviderMetricObservations', () => {
  it('normalizes Ollama token counts and registered nanosecond timings', () => {
    const observations = normalizeProviderMetricObservations(
      context({
        protocol: 'ollama_chat',
        provider_name: 'ollama',
        provider_version: '0.12.0'
      }),
      {
        prompt_eval_count: 19,
        eval_count: 7,
        total_duration: 2_500_000,
        load_duration: 500_000,
        prompt_eval_duration: 750_000,
        eval_duration: 1_250_000
      }
    );

    expect(observations).toHaveLength(6);
    expect(observation(observations, 'input_tokens')).toMatchObject({
      value: 19,
      source: 'server_reported',
      provider_id: 'server-1',
      provider_protocol: 'ollama_chat',
      provider_version: '0.12.0',
      native_field: 'prompt_eval_count',
      native_value: 19,
      native_unit: 'tokens',
      normalization: 'identity',
      metric_version: 'metrics-v2'
    });
    expect(observation(observations, 'server_total_time_ms')).toMatchObject({
      value: 2.5,
      native_field: 'total_duration',
      native_unit: 'nanoseconds',
      normalization: 'divide_by_1000000'
    });
    expect(observation(observations, 'model_load_time_ms').value).toBe(0.5);
    expect(observation(observations, 'server_prefill_time_ms').value).toBe(0.75);
    expect(observation(observations, 'server_decode_time_ms').value).toBe(1.25);
  });

  it('normalizes OpenAI Chat token counts and derives uncached input', () => {
    const observations = normalizeProviderMetricObservations(context(), {
      usage: {
        prompt_tokens: 20,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens: 8,
        total_tokens: 28,
        service_tier: 'priority'
      }
    });

    expect(observation(observations, 'input_tokens')).toMatchObject({
      value: 20,
      source: 'provider_reported',
      native_field: 'usage.prompt_tokens'
    });
    expect(observation(observations, 'cached_input_tokens')).toMatchObject({
      value: 6,
      accounting_scope: { relationship: 'subset_of', parent_metric_id: 'input_tokens' }
    });
    expect(observation(observations, 'uncached_input_tokens')).toMatchObject({
      value: 14,
      source: 'derived',
      native_field: null,
      normalization: 'usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens'
    });
    expect(observation(observations, 'output_tokens').value).toBe(8);
    expect(observations.some((candidate) => candidate.metric_id === 'total_tokens')).toBe(false);
    expect(observations.some((candidate) => candidate.native_field === 'usage.service_tier')).toBe(false);
  });

  it('treats OpenAI-compatible server usage as server-reported', () => {
    const observations = normalizeProviderMetricObservations(
      context({ provider_name: 'vLLM', provider_version: '0.10.0' }),
      { usage: { prompt_tokens: 4 } }
    );

    expect(observation(observations, 'input_tokens')).toMatchObject({
      source: 'server_reported',
      provider_version: '0.10.0'
    });
  });

  it('normalizes Anthropic cache accounting and exact effective input formula', () => {
    const observations = normalizeProviderMetricObservations(
      context({
        protocol: 'anthropic_messages',
        provider_name: 'Anthropic API'
      }),
      {
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          output_tokens: 7,
          output_tokens_details: { thinking_tokens: 2 }
        }
      }
    );

    expect(observation(observations, 'uncached_input_tokens').value).toBe(11);
    expect(observation(observations, 'cached_input_tokens').value).toBe(5);
    expect(observation(observations, 'cache_write_input_tokens').value).toBe(3);
    expect(observation(observations, 'input_tokens')).toMatchObject({
      value: 19,
      source: 'derived',
      accounting_scope: {
        relationship: 'sum_of_non_overlapping_components',
        component_metric_ids: [
          'uncached_input_tokens',
          'cached_input_tokens',
          'cache_write_input_tokens'
        ]
      }
    });
    expect(observation(observations, 'output_tokens').value).toBe(7);
    expect(observation(observations, 'reasoning_tokens')).toMatchObject({
      value: 2,
      accounting_scope: { relationship: 'subset_of', parent_metric_id: 'output_tokens' }
    });
  });

  it('does not derive Anthropic effective input from incomplete cache accounting', () => {
    const observations = normalizeProviderMetricObservations(
      context({ protocol: 'anthropic_messages', provider_name: 'Anthropic' }),
      { usage: { input_tokens: 11, output_tokens: 7 } }
    );

    expect(observation(observations, 'uncached_input_tokens').value).toBe(11);
    expect(observations.some((candidate) => candidate.metric_id === 'input_tokens')).toBe(false);
  });

  it('normalizes Gemini token categories and qualified candidate scope', () => {
    const observations = normalizeProviderMetricObservations(
      context({
        protocol: 'gemini_generate_content',
        provider_name: 'Google Gemini'
      }),
      {
        candidates: [{ content: { parts: [{ text: 'Answer' }] } }],
        usageMetadata: {
          promptTokenCount: 30,
          cachedContentTokenCount: 10,
          candidatesTokenCount: 12,
          thoughtsTokenCount: 4,
          toolUsePromptTokenCount: 3,
          totalTokenCount: 46,
          trafficType: 'ON_DEMAND'
        }
      }
    );

    expect(observation(observations, 'uncached_input_tokens')).toMatchObject({
      value: 20,
      source: 'derived'
    });
    expect(observation(observations, 'output_tokens')).toMatchObject({
      value: 12,
      accounting_scope: {
        mapping_classification: 'qualified',
        candidate_scope: 'all_candidates',
        candidate_count: 1,
        comparison_requires_equivalent_candidate_scope: true
      }
    });
    expect(observation(observations, 'reasoning_tokens').value).toBe(4);
    expect(observation(observations, 'tool_input_tokens')).toMatchObject({
      value: 3,
      accounting_scope: {
        relationship: 'provider_reported_component',
        inclusion_in_input_tokens: 'unknown',
        inclusion_in_total_tokens: 'unknown'
      }
    });
    expect(observation(observations, 'total_tokens').value).toBe(46);
    expect(observations.some((candidate) => candidate.native_field === 'usageMetadata.trafficType')).toBe(false);
  });

  it.each([
    ['negative count', -1],
    ['non-integer count', 1.5],
    ['non-finite count', Number.POSITIVE_INFINITY]
  ])('marks a present %s unavailable', (_label, invalidValue) => {
    const observations = normalizeProviderMetricObservations(
      context(),
      { usage: { prompt_tokens: invalidValue } }
    );

    expect(observation(observations, 'input_tokens')).toMatchObject({
      value: null,
      status: 'unavailable',
      source: 'provider_reported',
      native_field: 'usage.prompt_tokens',
      native_value: null,
      reason: expect.stringContaining('expected a finite non-negative integer')
    });
  });

  it('marks a negative provider duration unavailable instead of converting it', () => {
    const observations = normalizeProviderMetricObservations(
      context({ protocol: 'ollama_chat', provider_name: 'ollama' }),
      { total_duration: -1 }
    );

    expect(observation(observations, 'server_total_time_ms')).toMatchObject({
      value: null,
      status: 'unavailable',
      reason: expect.stringContaining('expected a finite non-negative number')
    });
  });

  it('retains zero counts and durations as measured values', () => {
    const observations = normalizeProviderMetricObservations(
      context({ protocol: 'ollama_chat', provider_name: 'ollama' }),
      { prompt_eval_count: 0, total_duration: 0 }
    );

    expect(observation(observations, 'input_tokens')).toMatchObject({
      value: 0,
      status: 'measured'
    });
    expect(observation(observations, 'server_total_time_ms')).toMatchObject({
      value: 0,
      status: 'measured'
    });
  });

  it('does not derive a negative uncached count from inconsistent cache accounting', () => {
    const observations = normalizeProviderMetricObservations(
      context(),
      {
        usage: {
          prompt_tokens: 5,
          prompt_tokens_details: { cached_tokens: 6 }
        }
      }
    );

    expect(observations.some((candidate) => candidate.metric_id === 'uncached_input_tokens')).toBe(false);
  });

  it('omits missing fields and unsupported provider-only metadata', () => {
    expect(normalizeProviderMetricObservations(context(), null)).toEqual([]);
    expect(normalizeProviderMetricObservations(context(), { usage: { service_tier: 'default' } })).toEqual([]);
    expect(normalizeProviderMetricObservations(
      { ...context(), protocol: 'openai_responses' as never },
      { usage: { input_tokens: 4 } }
    )).toEqual([]);
  });
});
