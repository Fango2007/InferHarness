import { describe, expect, it } from 'vitest';

import {
  normalizeClientMetricObservations,
  type ClientOperationTelemetry
} from '../../src/services/benchmark-client-metrics.js';
import type { MetricObservation } from '../../src/services/benchmark-metric-observations.js';

function metric(observations: MetricObservation[], metricId: string): MetricObservation {
  const result = observations.find((candidate) => candidate.metric_id === metricId);
  expect(result, `Missing observation: ${metricId}`).toBeDefined();
  return result as MetricObservation;
}

function telemetry(overrides: Partial<ClientOperationTelemetry> = {}): ClientOperationTelemetry {
  return {
    operation_started_at_ms: 0,
    operation_ended_at_ms: 120,
    streaming: false,
    attempts: [{
      started_at_ms: 10,
      ended_at_ms: 110,
      first_chunk_at_ms: null,
      request_succeeded: true,
      timed_out: false,
      response_normalization_succeeded: true,
      stream_completed: null
    }],
    ...overrides
  };
}

describe('normalizeClientMetricObservations', () => {
  it('separates operation latency from successful attempt latency', () => {
    const observations = normalizeClientMetricObservations(telemetry());

    expect(metric(observations, 'operation_elapsed_ms')).toMatchObject({
      value: 120,
      unit: 'milliseconds',
      source: 'client_observed',
      metric_version: 'metrics-v2',
      provider_protocol: null
    });
    expect(metric(observations, 'successful_attempt_latency_ms').value).toBe(100);
    expect(metric(observations, 'retry_overhead_ms')).toMatchObject({
      value: 20,
      source: 'derived',
      normalization: 'operation_elapsed_ms - sum(attempt_elapsed_ms)'
    });
    expect(metric(observations, 'attempt_count').value).toBe(1);
    expect(metric(observations, 'request_success').value).toBe(true);
    expect(metric(observations, 'timeout_occurred').value).toBe(false);
    expect(metric(observations, 'response_normalization_success').value).toBe(true);
    expect(metric(observations, 'stream_completed')).toMatchObject({
      value: null,
      status: 'not_applicable',
      reason: 'The operation did not request a streaming response.'
    });
  });

  it('measures retry overhead and successful-attempt first chunk from the final attempt', () => {
    const observations = normalizeClientMetricObservations(telemetry({
      operation_ended_at_ms: 260,
      streaming: true,
      attempts: [
        {
          started_at_ms: 0,
          ended_at_ms: 50,
          first_chunk_at_ms: null,
          request_succeeded: false,
          timed_out: false,
          response_normalization_succeeded: false,
          stream_completed: false
        },
        {
          started_at_ms: 100,
          ended_at_ms: 250,
          first_chunk_at_ms: 130,
          request_succeeded: true,
          timed_out: false,
          response_normalization_succeeded: true,
          stream_completed: true
        }
      ]
    }));

    expect(metric(observations, 'attempt_count').value).toBe(2);
    expect(metric(observations, 'operation_elapsed_ms').value).toBe(260);
    expect(metric(observations, 'successful_attempt_latency_ms').value).toBe(150);
    expect(metric(observations, 'time_to_first_chunk_ms').value).toBe(30);
    expect(metric(observations, 'retry_overhead_ms').value).toBe(60);
    expect(metric(observations, 'stream_completed').value).toBe(true);
  });

  it('does not mark an intermediate timeout when a retry succeeds', () => {
    const observations = normalizeClientMetricObservations(telemetry({
      attempts: [
        {
          started_at_ms: 0,
          ended_at_ms: 50,
          first_chunk_at_ms: null,
          request_succeeded: false,
          timed_out: true,
          response_normalization_succeeded: null,
          stream_completed: null
        },
        {
          started_at_ms: 60,
          ended_at_ms: 110,
          first_chunk_at_ms: null,
          request_succeeded: true,
          timed_out: false,
          response_normalization_succeeded: true,
          stream_completed: null
        }
      ]
    }));

    expect(metric(observations, 'request_success').value).toBe(true);
    expect(metric(observations, 'timeout_occurred').value).toBe(false);
  });

  it('records terminal timeout and unavailable response normalization evidence', () => {
    const observations = normalizeClientMetricObservations(telemetry({
      operation_ended_at_ms: 100,
      streaming: true,
      attempts: [{
        started_at_ms: 0,
        ended_at_ms: 100,
        first_chunk_at_ms: null,
        request_succeeded: false,
        timed_out: true,
        response_normalization_succeeded: null,
        stream_completed: false
      }]
    }));

    expect(metric(observations, 'request_success').value).toBe(false);
    expect(metric(observations, 'timeout_occurred').value).toBe(true);
    expect(metric(observations, 'response_normalization_success')).toMatchObject({
      value: null,
      status: 'not_applicable',
      reason: 'No provider response was available to normalize.'
    });
    expect(metric(observations, 'stream_completed').value).toBe(false);
    expect(observations.some((candidate) => candidate.metric_id === 'successful_attempt_latency_ms')).toBe(false);
  });
});
