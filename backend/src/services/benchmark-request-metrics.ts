import {
  normalizeClientMetricObservations,
  type ClientOperationTelemetry
} from './benchmark-client-metrics.js';
import type {
  MetricObservation,
  MetricObservationStatus
} from './benchmark-metric-observations.js';

export interface ComposeRequestMetricObservationsInput {
  clientTelemetry: ClientOperationTelemetry;
  providerObservations: MetricObservation[];
}

function measuredObservation(
  observations: MetricObservation[],
  metricId: string
): MetricObservation | null {
  return observations.find(
    (candidate) => candidate.metric_id === metricId
      && candidate.status === 'measured'
      && typeof candidate.value === 'number'
  ) ?? null;
}

function numericValue(observation: MetricObservation | null): number | null {
  return observation && typeof observation.value === 'number'
    ? observation.value
    : null;
}

function derivedObservation(input: {
  metricId: string;
  unit: string;
  value?: number;
  status?: MetricObservationStatus;
  reason?: string;
  formula: string;
  components: MetricObservation[];
  accountingScope?: Record<string, unknown>;
}): MetricObservation {
  const providerReference = input.components.find(
    (component) => component.provider_protocol !== null || component.provider_id !== null
  );
  const componentScopes = input.components
    .filter((component) => component.accounting_scope !== null)
    .map((component) => ({
      metric_id: component.metric_id,
      accounting_scope: component.accounting_scope
    }));
  return {
    metric_id: input.metricId,
    value: input.value ?? null,
    unit: input.unit,
    status: input.status ?? 'measured',
    reason: input.reason ?? null,
    source: 'derived',
    metric_version: 'metrics-v2',
    provider_id: providerReference?.provider_id ?? null,
    provider_protocol: providerReference?.provider_protocol ?? null,
    provider_version: providerReference?.provider_version ?? null,
    native_field: null,
    native_value: null,
    native_unit: null,
    normalization: input.formula,
    accounting_scope: {
      component_metric_ids: input.components.map((component) => component.metric_id),
      ...(componentScopes.length > 0 ? { component_accounting_scopes: componentScopes } : {}),
      ...(input.accountingScope ?? {})
    }
  };
}

function shareProviderScope(left: MetricObservation, right: MetricObservation): boolean {
  if (
    left.provider_protocol !== null
    && right.provider_protocol !== null
    && left.provider_protocol !== right.provider_protocol
  ) {
    return false;
  }
  return !(
    left.provider_id !== null
    && right.provider_id !== null
    && left.provider_id !== right.provider_id
  );
}

function streamOutputScopeIssue(
  outputTokens: MetricObservation,
  observations: MetricObservation[]
): string | null {
  const scope = outputTokens.accounting_scope;
  if (scope?.candidate_scope === 'all_candidates' && scope.candidate_count !== 1) {
    return 'Output token usage spans multiple or unknown response candidates.';
  }
  const reasoningTokens = measuredObservation(observations, 'reasoning_tokens');
  if (
    numericValue(reasoningTokens) !== null
    && (numericValue(reasoningTokens) as number) > 0
    && reasoningTokens?.accounting_scope?.relationship === 'subset_of'
    && reasoningTokens.accounting_scope.parent_metric_id === 'output_tokens'
  ) {
    return 'Output token usage includes hidden reasoning tokens outside the measured stream.';
  }
  return null;
}

function composeGenerationObservations(
  input: ComposeRequestMetricObservationsInput,
  observations: MetricObservation[]
): MetricObservation[] {
  const outputTokens = measuredObservation(observations, 'output_tokens');
  if (!outputTokens) return [];

  const outputCount = numericValue(outputTokens) as number;
  const formula = 't_last_output - t_first_output';
  const generationComponents = [outputTokens];
  let generation: MetricObservation;

  if (!input.clientTelemetry.streaming) {
    generation = derivedObservation({
      metricId: 'generation_window_ms',
      unit: 'milliseconds',
      status: 'not_applicable',
      reason: 'The operation did not request a streaming response.',
      formula,
      components: generationComponents
    });
  } else if (outputCount < 2) {
    generation = derivedObservation({
      metricId: 'generation_window_ms',
      unit: 'milliseconds',
      status: 'not_applicable',
      reason: 'Generation-window metrics require at least two output tokens.',
      formula,
      components: generationComponents
    });
  } else {
    const scopeIssue = streamOutputScopeIssue(outputTokens, observations);
    const successfulAttempt = [...input.clientTelemetry.attempts]
      .reverse()
      .find((attempt) => attempt.request_succeeded);
    if (scopeIssue) {
      generation = derivedObservation({
        metricId: 'generation_window_ms',
        unit: 'milliseconds',
        status: 'unavailable',
        reason: scopeIssue,
        formula,
        components: generationComponents
      });
    } else if (
      successfulAttempt?.first_output_at_ms === null
      || successfulAttempt?.first_output_at_ms === undefined
      || successfulAttempt.last_output_at_ms === null
    ) {
      generation = derivedObservation({
        metricId: 'generation_window_ms',
        unit: 'milliseconds',
        status: 'unavailable',
        reason: 'The stream did not provide complete first- and last-output timing.',
        formula,
        components: generationComponents
      });
    } else {
      const generationWindow = successfulAttempt.last_output_at_ms
        - successfulAttempt.first_output_at_ms;
      generation = generationWindow < 0
        ? derivedObservation({
            metricId: 'generation_window_ms',
            unit: 'milliseconds',
            status: 'unavailable',
            reason: 'The measured last-output timestamp preceded first output.',
            formula,
            components: generationComponents
          })
        : derivedObservation({
            metricId: 'generation_window_ms',
            unit: 'milliseconds',
            value: generationWindow,
            formula,
            components: generationComponents,
            accountingScope: { timing_basis: ['t_first_output', 't_last_output'] }
          });
    }
  }

  const derived = [generation];
  if (generation.status !== 'measured') {
    derived.push(
      derivedObservation({
        metricId: 'time_per_output_token_ms',
        unit: 'milliseconds_per_token',
        status: generation.status,
        reason: generation.reason ?? 'Generation window is unavailable.',
        formula: 'generation_window_ms / (output_tokens - 1)',
        components: [generation, outputTokens]
      }),
      derivedObservation({
        metricId: 'decode_output_tokens_per_second',
        unit: 'tokens_per_second',
        status: generation.status,
        reason: generation.reason ?? 'Generation window is unavailable.',
        formula: '(output_tokens - 1) / (generation_window_ms / 1000)',
        components: [generation, outputTokens]
      })
    );
    return derived;
  }

  const generationWindow = numericValue(generation) as number;
  derived.push(derivedObservation({
    metricId: 'time_per_output_token_ms',
    unit: 'milliseconds_per_token',
    value: generationWindow / (outputCount - 1),
    formula: 'generation_window_ms / (output_tokens - 1)',
    components: [generation, outputTokens]
  }));
  derived.push(generationWindow > 0
    ? derivedObservation({
        metricId: 'decode_output_tokens_per_second',
        unit: 'tokens_per_second',
        value: (outputCount - 1) / (generationWindow / 1000),
        formula: '(output_tokens - 1) / (generation_window_ms / 1000)',
        components: [generation, outputTokens]
      })
    : derivedObservation({
        metricId: 'decode_output_tokens_per_second',
        unit: 'tokens_per_second',
        status: 'unavailable',
        reason: 'Decode throughput requires a positive generation window.',
        formula: '(output_tokens - 1) / (generation_window_ms / 1000)',
        components: [generation, outputTokens]
      }));
  return derived;
}

function composeRateObservation(input: {
  metricId: string;
  unit: string;
  numerator: MetricObservation | null;
  denominator: MetricObservation | null;
  formula: string;
  scale: number;
}): MetricObservation | null {
  if (!input.numerator || !input.denominator) return null;
  if (!shareProviderScope(input.numerator, input.denominator)) {
    return derivedObservation({
      metricId: input.metricId,
      unit: input.unit,
      status: 'unavailable',
      reason: 'Formula inputs do not share compatible provider provenance.',
      formula: input.formula,
      components: [input.numerator, input.denominator]
    });
  }
  const denominator = numericValue(input.denominator) as number;
  if (denominator <= 0) {
    return derivedObservation({
      metricId: input.metricId,
      unit: input.unit,
      status: 'unavailable',
      reason: 'Formula requires a positive duration denominator.',
      formula: input.formula,
      components: [input.numerator, input.denominator]
    });
  }
  return derivedObservation({
    metricId: input.metricId,
    unit: input.unit,
    value: (numericValue(input.numerator) as number) / (denominator / input.scale),
    formula: input.formula,
    components: [input.numerator, input.denominator]
  });
}

export function composeRequestMetricObservations(
  input: ComposeRequestMetricObservationsInput
): MetricObservation[] {
  const clientObservations = normalizeClientMetricObservations(input.clientTelemetry);
  const observations = [...clientObservations, ...input.providerObservations];
  const outputTokens = measuredObservation(observations, 'output_tokens');
  const inputTokens = measuredObservation(observations, 'input_tokens');
  const successfulLatency = measuredObservation(observations, 'successful_attempt_latency_ms');
  const serverPrefill = measuredObservation(observations, 'server_prefill_time_ms');
  const serverDecode = measuredObservation(observations, 'server_decode_time_ms');
  const derived: MetricObservation[] = composeGenerationObservations(input, observations);

  const requestRate = composeRateObservation({
    metricId: 'per_request_output_tokens_per_second',
    unit: 'tokens_per_second',
    numerator: outputTokens,
    denominator: successfulLatency,
    formula: 'output_tokens / (successful_attempt_latency_ms / 1000)',
    scale: 1000
  });
  if (requestRate) derived.push(requestRate);

  const prefillRate = composeRateObservation({
    metricId: 'server_prefill_tokens_per_second',
    unit: 'tokens_per_second',
    numerator: inputTokens,
    denominator: serverPrefill,
    formula: 'input_tokens / (server_prefill_time_ms / 1000)',
    scale: 1000
  });
  if (prefillRate) derived.push(prefillRate);

  const decodeRate = composeRateObservation({
    metricId: 'server_decode_tokens_per_second',
    unit: 'tokens_per_second',
    numerator: outputTokens,
    denominator: serverDecode,
    formula: 'output_tokens / (server_decode_time_ms / 1000)',
    scale: 1000
  });
  if (decodeRate) derived.push(decodeRate);

  if (inputTokens && outputTokens) {
    const inputCount = numericValue(inputTokens) as number;
    derived.push(inputCount > 0
      ? derivedObservation({
          metricId: 'output_input_token_ratio',
          unit: 'ratio',
          value: (numericValue(outputTokens) as number) / inputCount,
          formula: 'output_tokens / input_tokens',
          components: [outputTokens, inputTokens]
        })
      : derivedObservation({
          metricId: 'output_input_token_ratio',
          unit: 'ratio',
          status: 'not_applicable',
          reason: 'Output/input ratio requires a positive input token count.',
          formula: 'output_tokens / input_tokens',
          components: [outputTokens, inputTokens]
        }));
  }

  return [...observations, ...derived];
}
