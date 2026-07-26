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
  first_output_at_ms: number | null;
  first_tool_call_at_ms: number | null;
  tool_calls_ready_at_ms: number | null;
  last_output_at_ms: number | null;
  tool_call_started: boolean;
  tool_call_error: string | null;
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

  const notApplicable = (metricId: string, reason: string) => observation({
    metricId,
    value: null,
    unit: 'milliseconds',
    status: 'not_applicable',
    reason
  });
  const semanticAttempt = successfulAttempt ?? finalAttempt;
  if (!telemetry.streaming) {
    observations.push(
      notApplicable('time_to_first_output_ms', 'The operation did not request a streaming response.'),
      notApplicable('time_to_first_tool_call_ms', 'The operation did not request a streaming response.'),
      notApplicable('time_to_tool_calls_ready_ms', 'The operation did not request a streaming response.')
    );
  } else {
    observations.push(semanticAttempt?.first_output_at_ms !== null && semanticAttempt?.first_output_at_ms !== undefined
      ? observation({
          metricId: 'time_to_first_output_ms',
          value: semanticAttempt.first_output_at_ms - semanticAttempt.started_at_ms,
          unit: 'milliseconds'
        })
      : notApplicable('time_to_first_output_ms', 'The stream contained no normalized model output.'));
    observations.push(semanticAttempt?.first_tool_call_at_ms !== null && semanticAttempt?.first_tool_call_at_ms !== undefined
      ? observation({
          metricId: 'time_to_first_tool_call_ms',
          value: semanticAttempt.first_tool_call_at_ms - semanticAttempt.started_at_ms,
          unit: 'milliseconds'
        })
      : notApplicable('time_to_first_tool_call_ms', 'The stream contained no normalized tool-call output.'));
    if (semanticAttempt?.tool_calls_ready_at_ms !== null && semanticAttempt?.tool_calls_ready_at_ms !== undefined) {
      observations.push(observation({
        metricId: 'time_to_tool_calls_ready_ms',
        value: semanticAttempt.tool_calls_ready_at_ms - semanticAttempt.started_at_ms,
        unit: 'milliseconds'
      }));
    } else if (semanticAttempt?.tool_call_started) {
      observations.push(observation({
        metricId: 'time_to_tool_calls_ready_ms',
        value: null,
        unit: 'milliseconds',
        status: 'execution_error',
        reason: semanticAttempt.tool_call_error
          ?? 'The stream ended before all tool calls were complete and parseable.'
      }));
    } else {
      observations.push(notApplicable(
        'time_to_tool_calls_ready_ms',
        'The stream contained no normalized tool-call output.'
      ));
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
