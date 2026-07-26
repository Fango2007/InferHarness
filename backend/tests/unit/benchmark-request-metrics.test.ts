import { describe, expect, it } from 'vitest';

import type {
  ClientAttemptTelemetry,
  ClientOperationTelemetry
} from '../../src/services/benchmark-client-metrics.js';
import type { MetricObservation } from '../../src/services/benchmark-metric-observations.js';
import { composeRequestMetricObservations } from '../../src/services/benchmark-request-metrics.js';

function attempt(overrides: Partial<ClientAttemptTelemetry> = {}): ClientAttemptTelemetry {
  return {
    started_at_ms: 0,
    ended_at_ms: 500,
    first_chunk_at_ms: 50,
    first_output_at_ms: 100,
    first_tool_call_at_ms: null,
    tool_calls_ready_at_ms: null,
    last_output_at_ms: 300,
    tool_call_started: false,
    tool_call_error: null,
    request_succeeded: true,
    timed_out: false,
    response_normalization_succeeded: true,
    stream_completed: true,
    ...overrides
  };
}

function telemetry(overrides: Partial<ClientOperationTelemetry> = {}): ClientOperationTelemetry {
  return {
    operation_started_at_ms: 0,
    operation_ended_at_ms: 500,
    streaming: true,
    attempts: [attempt()],
    ...overrides
  };
}

function providerObservation(
  metricId: string,
  value: number,
  unit: string,
  overrides: Partial<MetricObservation> = {}
): MetricObservation {
  return {
    metric_id: metricId,
    value,
    unit,
    status: 'measured',
    reason: null,
    source: 'server_reported',
    metric_version: 'metrics-v2',
    provider_id: 'server-1',
    provider_protocol: 'ollama_chat',
    provider_version: '0.12.0',
    native_field: metricId,
    native_value: value,
    native_unit: unit,
    normalization: 'identity',
    accounting_scope: null,
    ...overrides
  };
}

function metric(observations: MetricObservation[], metricId: string): MetricObservation {
  const result = observations.find((candidate) => candidate.metric_id === metricId);
  expect(result, `Missing observation: ${metricId}`).toBeDefined();
  return result as MetricObservation;
}

function fullProviderObservations(): MetricObservation[] {
  return [
    providerObservation('input_tokens', 100, 'tokens'),
    providerObservation('output_tokens', 5, 'tokens'),
    providerObservation('server_prefill_time_ms', 50, 'milliseconds'),
    providerObservation('server_decode_time_ms', 200, 'milliseconds')
  ];
}

describe('composeRequestMetricObservations', () => {
  it('composes client and provider inputs and emits every registered request formula', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: fullProviderObservations()
    });

    expect(metric(observations, 'generation_window_ms')).toMatchObject({
      value: 200,
      unit: 'milliseconds',
      source: 'derived',
      normalization: 't_last_output - t_first_output',
      native_field: null,
      native_value: null,
      metric_version: 'metrics-v2',
      provider_id: 'server-1',
      provider_protocol: 'ollama_chat'
    });
    for (const [metricId, value, normalization] of [
      [
        'per_request_output_tokens_per_second',
        10,
        'output_tokens / (successful_attempt_latency_ms / 1000)'
      ],
      ['time_per_output_token_ms', 50, 'generation_window_ms / (output_tokens - 1)'],
      [
        'decode_output_tokens_per_second',
        20,
        '(output_tokens - 1) / (generation_window_ms / 1000)'
      ],
      [
        'server_prefill_tokens_per_second',
        2000,
        'input_tokens / (server_prefill_time_ms / 1000)'
      ],
      [
        'server_decode_tokens_per_second',
        25,
        'output_tokens / (server_decode_time_ms / 1000)'
      ],
      ['output_input_token_ratio', 0.05, 'output_tokens / input_tokens']
    ] as const) {
      expect(metric(observations, metricId)).toMatchObject({ value, normalization });
    }
    expect(metric(observations, 'decode_output_tokens_per_second').accounting_scope).toMatchObject({
      component_metric_ids: ['generation_window_ms', 'output_tokens']
    });
  });

  it('uses the successful retry attempt for request latency and generation timing', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry({
        operation_ended_at_ms: 700,
        attempts: [
          attempt({
            started_at_ms: 0,
            ended_at_ms: 100,
            first_chunk_at_ms: null,
            first_output_at_ms: null,
            last_output_at_ms: null,
            request_succeeded: false,
            response_normalization_succeeded: null,
            stream_completed: false
          }),
          attempt({
            started_at_ms: 200,
            ended_at_ms: 700,
            first_output_at_ms: 300,
            last_output_at_ms: 500
          })
        ]
      }),
      providerObservations: [providerObservation('output_tokens', 5, 'tokens')]
    });

    expect(metric(observations, 'attempt_count').value).toBe(2);
    expect(metric(observations, 'per_request_output_tokens_per_second').value).toBe(10);
    expect(metric(observations, 'generation_window_ms').value).toBe(200);
  });

  it('marks stream-window formulas not applicable for non-streaming requests', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry({
        streaming: false,
        attempts: [attempt({
          first_chunk_at_ms: null,
          first_output_at_ms: null,
          last_output_at_ms: null,
          stream_completed: null
        })]
      }),
      providerObservations: [providerObservation('output_tokens', 5, 'tokens')]
    });

    for (const metricId of [
      'generation_window_ms',
      'time_per_output_token_ms',
      'decode_output_tokens_per_second'
    ]) {
      expect(metric(observations, metricId).status).toBe('not_applicable');
    }
    expect(metric(observations, 'per_request_output_tokens_per_second').value).toBe(10);
  });

  it('handles zero token counts and non-positive duration denominators', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry({
        attempts: [attempt({ started_at_ms: 500, ended_at_ms: 500 })]
      }),
      providerObservations: [
        providerObservation('input_tokens', 0, 'tokens'),
        providerObservation('output_tokens', 0, 'tokens'),
        providerObservation('server_prefill_time_ms', 0, 'milliseconds'),
        providerObservation('server_decode_time_ms', 0, 'milliseconds')
      ]
    });

    expect(metric(observations, 'generation_window_ms').status).toBe('not_applicable');
    expect(metric(observations, 'per_request_output_tokens_per_second').status).toBe('unavailable');
    expect(metric(observations, 'server_prefill_tokens_per_second').status).toBe('unavailable');
    expect(metric(observations, 'server_decode_tokens_per_second').status).toBe('unavailable');
    expect(metric(observations, 'output_input_token_ratio').status).toBe('not_applicable');
  });

  it('omits formulas whose optional provider inputs are absent', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: []
    });

    expect(observations.some(({ metric_id }) => [
      'generation_window_ms',
      'per_request_output_tokens_per_second',
      'server_prefill_tokens_per_second',
      'server_decode_tokens_per_second',
      'output_input_token_ratio'
    ].includes(metric_id))).toBe(false);
  });

  it('does not derive from unavailable provider observations', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: [providerObservation('output_tokens', 0, 'tokens', {
        value: null,
        status: 'unavailable',
        reason: 'Native output token count was non-finite.',
        native_value: null
      })]
    });

    expect(observations.some(({ metric_id }) => metric_id === 'generation_window_ms')).toBe(false);
    expect(observations.some(
      ({ metric_id }) => metric_id === 'per_request_output_tokens_per_second'
    )).toBe(false);
  });

  it('rejects multi-candidate Gemini output scope for stream-window metrics', () => {
    const outputTokens = providerObservation('output_tokens', 5, 'tokens', {
      provider_protocol: 'gemini_generate_content',
      accounting_scope: {
        candidate_scope: 'all_candidates',
        candidate_count: 2
      }
    });
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: [outputTokens]
    });

    expect(metric(observations, 'generation_window_ms')).toMatchObject({
      status: 'unavailable',
      reason: 'Output token usage spans multiple or unknown response candidates.'
    });
  });

  it('accepts Gemini output tokens when usage covers exactly one candidate', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: [providerObservation('output_tokens', 5, 'tokens', {
        provider_protocol: 'gemini_generate_content',
        accounting_scope: {
          candidate_scope: 'all_candidates',
          candidate_count: 1
        }
      })]
    });

    expect(metric(observations, 'generation_window_ms').value).toBe(200);
  });

  it('rejects output scope containing hidden reasoning tokens', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: [
        providerObservation('output_tokens', 5, 'tokens', {
          provider_protocol: 'anthropic_messages'
        }),
        providerObservation('reasoning_tokens', 2, 'tokens', {
          provider_protocol: 'anthropic_messages',
          accounting_scope: {
            relationship: 'subset_of',
            parent_metric_id: 'output_tokens'
          }
        })
      ]
    });

    expect(metric(observations, 'generation_window_ms')).toMatchObject({
      status: 'unavailable',
      reason: 'Output token usage includes hidden reasoning tokens outside the measured stream.'
    });
  });

  it('keeps a zero generation window but rejects its decode-rate denominator', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry({
        attempts: [attempt({ first_output_at_ms: 100, last_output_at_ms: 100 })]
      }),
      providerObservations: [providerObservation('output_tokens', 2, 'tokens')]
    });

    expect(metric(observations, 'generation_window_ms').value).toBe(0);
    expect(metric(observations, 'time_per_output_token_ms').value).toBe(0);
    expect(metric(observations, 'decode_output_tokens_per_second').status).toBe('unavailable');
  });

  it('marks a reversed semantic timing window unavailable', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry({
        attempts: [attempt({ first_output_at_ms: 300, last_output_at_ms: 100 })]
      }),
      providerObservations: [providerObservation('output_tokens', 5, 'tokens')]
    });

    expect(metric(observations, 'generation_window_ms').status).toBe('unavailable');
  });

  it('rejects server-rate inputs from incompatible provider scopes', () => {
    const observations = composeRequestMetricObservations({
      clientTelemetry: telemetry(),
      providerObservations: [
        providerObservation('input_tokens', 100, 'tokens'),
        providerObservation('server_prefill_time_ms', 50, 'milliseconds', {
          provider_id: 'server-2'
        })
      ]
    });

    expect(metric(observations, 'server_prefill_tokens_per_second')).toMatchObject({
      status: 'unavailable',
      reason: 'Formula inputs do not share compatible provider provenance.'
    });
  });
});
