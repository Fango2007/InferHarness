import {
  measuredMetricValue,
  type MetricObservation,
  type MetricObservationSource,
  type MetricObservationStatus
} from './benchmark-metric-observations.js';

export interface ClientAttemptTelemetry {
  started_at_ms: number;
  ended_at_ms: number;
  first_chunk_at_ms: number | null;
  request_succeeded: boolean;
  timed_out: boolean;
  response_normalization_succeeded: boolean | null;
  stream_completed: boolean | null;
}

export interface ClientOperationTelemetry {
  operation_started_at_ms: number;
  operation_ended_at_ms: number;
  streaming: boolean;
  attempts: ClientAttemptTelemetry[];
}

function observation(input: {
  metricId: string;
  value: number | boolean | null;
  unit: string;
  status?: MetricObservationStatus;
  reason?: string | null;
  source?: MetricObservationSource;
  normalization?: string | null;
}): MetricObservation {
  return {
    metric_id: input.metricId,
    value: input.value,
    unit: input.unit,
    status: input.status ?? 'measured',
    reason: input.reason ?? null,
    source: input.source ?? 'client_observed',
    metric_version: 'metrics-v2',
    provider_id: null,
    provider_protocol: null,
    provider_version: null,
    native_field: null,
    native_value: null,
    native_unit: null,
    normalization: input.normalization ?? null,
    accounting_scope: null
  };
}

export function normalizeClientMetricObservations(
  telemetry: ClientOperationTelemetry
): MetricObservation[] {
  const attempts = telemetry.attempts;
  const finalAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const operationElapsed = telemetry.operation_ended_at_ms - telemetry.operation_started_at_ms;
  const attemptedElapsed = attempts.reduce(
    (total, attempt) => total + (attempt.ended_at_ms - attempt.started_at_ms),
    0
  );
  const observations: MetricObservation[] = [
    observation({
      metricId: 'operation_elapsed_ms',
      value: operationElapsed,
      unit: 'milliseconds'
    }),
    observation({
      metricId: 'attempt_count',
      value: attempts.length,
      unit: 'attempts'
    }),
    observation({
      metricId: 'retry_overhead_ms',
      value: Math.max(0, operationElapsed - attemptedElapsed),
      unit: 'milliseconds',
      source: 'derived',
      normalization: 'operation_elapsed_ms - sum(attempt_elapsed_ms)'
    }),
    observation({
      metricId: 'request_success',
      value: finalAttempt?.request_succeeded ?? false,
      unit: 'boolean'
    }),
    observation({
      metricId: 'timeout_occurred',
      value: Boolean(finalAttempt?.timed_out && !finalAttempt.request_succeeded),
      unit: 'boolean'
    })
  ];

  const successfulAttempt = [...attempts].reverse().find((attempt) => attempt.request_succeeded);
  if (successfulAttempt) {
    observations.push(observation({
      metricId: 'successful_attempt_latency_ms',
      value: successfulAttempt.ended_at_ms - successfulAttempt.started_at_ms,
      unit: 'milliseconds'
    }));
    if (successfulAttempt.first_chunk_at_ms !== null) {
      observations.push(observation({
        metricId: 'time_to_first_chunk_ms',
        value: successfulAttempt.first_chunk_at_ms - successfulAttempt.started_at_ms,
        unit: 'milliseconds'
      }));
    }
  }

  if (finalAttempt && finalAttempt.response_normalization_succeeded !== null) {
    observations.push(observation({
      metricId: 'response_normalization_success',
      value: finalAttempt.response_normalization_succeeded,
      unit: 'boolean'
    }));
  } else {
    observations.push(observation({
      metricId: 'response_normalization_success',
      value: null,
      unit: 'boolean',
      status: 'not_applicable',
      reason: 'No provider response was available to normalize.'
    }));
  }

  if (!telemetry.streaming) {
    observations.push(observation({
      metricId: 'stream_completed',
      value: null,
      unit: 'boolean',
      status: 'not_applicable',
      reason: 'The operation did not request a streaming response.'
    }));
  } else if (finalAttempt && finalAttempt.stream_completed !== null) {
    observations.push(observation({
      metricId: 'stream_completed',
      value: finalAttempt.stream_completed,
      unit: 'boolean'
    }));
  } else {
    observations.push(observation({
      metricId: 'stream_completed',
      value: false,
      unit: 'boolean'
    }));
  }

  return observations;
}

export function measuredClientMetric(
  observations: MetricObservation[],
  metricId: string
): number | null {
  return measuredMetricValue(observations, metricId);
}
