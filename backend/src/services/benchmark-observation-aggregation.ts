import type {
  MetricObservation,
  MetricObservationSource,
  ProviderProtocol
} from './benchmark-metric-observations.js';
import {
  CANONICAL_TOOL_CALL_METRICS,
  resolveCanonicalCorrectnessMetricIds
} from './benchmark-correctness-metrics.js';

export type CanonicalMetricValueType = 'number' | 'boolean';

export type CanonicalNumericAggregation =
  | 'mean'
  | 'median'
  | 'min'
  | 'max'
  | 'sum'
  | 'stddev'
  | 'variance'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99';

export interface MetricObservationSample {
  stage_id: string;
  item_index: number;
  iteration: number;
  pair_member_id: string | null;
  streaming: boolean;
  expected: true;
  attempted: boolean;
  completed: boolean;
  attempt_observations: MetricObservation[][];
  terminal_observations: MetricObservation[] | null;
}

export interface MetricObservationStagePlan {
  stage_id: string;
  stage_type: 'dataset_loop' | 'single_request' | 'paired_request_loop';
  item_count: number;
  iterations_per_item: number;
  pair_member_ids: string[];
  record_metrics: boolean;
}

export interface CanonicalMetricIntent {
  stage_id: string;
  pair_member_id: string | null;
  metric_id: string;
  value_type: CanonicalMetricValueType;
  unit: string;
}

export interface CanonicalMetricIntentContext {
  stage_id: string;
  pair_member_id: string | null;
  requested_metrics: string[];
  derived_metric_references?: string[];
  streaming: boolean;
}

export interface CanonicalProvenanceSignature {
  source: MetricObservationSource;
  provider_id: string | null;
  provider_protocol: ProviderProtocol | null;
  provider_version: string | null;
  native_field: string | null;
  accounting_scope: Record<string, unknown> | null;
}

export interface CanonicalMetricAggregate {
  stage_id: string;
  pair_member_id: string | null;
  metric_id: string;
  metric_version: 'metrics-v2';
  value_type: CanonicalMetricValueType;
  unit: string;
  expected_sample_count: number;
  attempted_sample_count: number;
  completed_sample_count: number;
  valid_sample_count: number;
  passed_sample_count: number;
  unavailable_sample_count: number;
  not_applicable_sample_count: number;
  execution_error_sample_count: number;
  observed_pass_rate: number | null;
  coverage_rate: number;
  end_to_end_pass_rate: number | null;
  statistics: Partial<Record<CanonicalNumericAggregation, number>>;
  aggregation_eligible: boolean;
  provenance_signatures: CanonicalProvenanceSignature[];
  warnings: string[];
}

interface MetricDefinition {
  value_type: CanonicalMetricValueType;
  unit: string;
}

const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  request_success: { value_type: 'boolean', unit: 'boolean' },
  stream_completed: { value_type: 'boolean', unit: 'boolean' },
  response_normalization_success: { value_type: 'boolean', unit: 'boolean' },
  attempt_count: { value_type: 'number', unit: 'attempts' },
  timeout_occurred: { value_type: 'boolean', unit: 'boolean' },
  retry_overhead_ms: { value_type: 'number', unit: 'milliseconds' },
  operation_elapsed_ms: { value_type: 'number', unit: 'milliseconds' },
  successful_attempt_latency_ms: { value_type: 'number', unit: 'milliseconds' },
  time_to_first_chunk_ms: { value_type: 'number', unit: 'milliseconds' },
  time_to_first_output_ms: { value_type: 'number', unit: 'milliseconds' },
  time_to_first_tool_call_ms: { value_type: 'number', unit: 'milliseconds' },
  time_to_tool_calls_ready_ms: { value_type: 'number', unit: 'milliseconds' },
  generation_window_ms: { value_type: 'number', unit: 'milliseconds' },
  model_load_time_ms: { value_type: 'number', unit: 'milliseconds' },
  server_total_time_ms: { value_type: 'number', unit: 'milliseconds' },
  server_prefill_time_ms: { value_type: 'number', unit: 'milliseconds' },
  server_decode_time_ms: { value_type: 'number', unit: 'milliseconds' },
  input_tokens: { value_type: 'number', unit: 'tokens' },
  output_tokens: { value_type: 'number', unit: 'tokens' },
  total_tokens: { value_type: 'number', unit: 'tokens' },
  per_request_output_tokens_per_second: { value_type: 'number', unit: 'tokens_per_second' },
  time_per_output_token_ms: { value_type: 'number', unit: 'milliseconds_per_token' },
  decode_output_tokens_per_second: { value_type: 'number', unit: 'tokens_per_second' },
  server_prefill_tokens_per_second: { value_type: 'number', unit: 'tokens_per_second' },
  server_decode_tokens_per_second: { value_type: 'number', unit: 'tokens_per_second' },
  output_input_token_ratio: { value_type: 'number', unit: 'ratio' },
  exact_match: { value_type: 'boolean', unit: 'boolean' },
  normalized_exact_match: { value_type: 'boolean', unit: 'boolean' },
  required_terms_present: { value_type: 'boolean', unit: 'boolean' },
  forbidden_terms_absent: { value_type: 'boolean', unit: 'boolean' },
  json_syntax_valid: { value_type: 'boolean', unit: 'boolean' },
  json_schema_valid: { value_type: 'boolean', unit: 'boolean' },
  regex_match: { value_type: 'boolean', unit: 'boolean' },
  tool_call_assertion_pass: { value_type: 'boolean', unit: 'boolean' },
  tool_call_count: { value_type: 'number', unit: 'count' },
  tool_selection_exact_match: { value_type: 'boolean', unit: 'boolean' },
  tool_selection_precision: { value_type: 'number', unit: 'ratio' },
  tool_selection_recall: { value_type: 'number', unit: 'ratio' },
  tool_arguments_json_valid: { value_type: 'boolean', unit: 'boolean' },
  tool_arguments_schema_valid: { value_type: 'boolean', unit: 'boolean' },
  tool_arguments_match_expected: { value_type: 'boolean', unit: 'boolean' },
  missing_tool_call_count: { value_type: 'number', unit: 'count' },
  unexpected_tool_call_count: { value_type: 'number', unit: 'count' },
  duplicate_tool_call_count: { value_type: 'number', unit: 'count' }
};

const LEGACY_PERFORMANCE_ALIASES: Record<string, string> = {
  input_tokens: 'input_tokens',
  output_tokens: 'output_tokens',
  total_tokens: 'total_tokens',
  elapsed_ms: 'operation_elapsed_ms',
  first_token_ms: 'time_to_first_output_ms',
  tokens_per_second: 'per_request_output_tokens_per_second',
  decode_tokens_per_second: 'decode_output_tokens_per_second',
  prefill_tokens_per_second: 'server_prefill_tokens_per_second',
  output_input_token_ratio: 'output_input_token_ratio',
  load_duration_ms: 'model_load_time_ms',
  server_total_time_ms: 'server_total_time_ms',
  server_prompt_eval_ms: 'server_prefill_time_ms',
  server_eval_ms: 'server_decode_time_ms'
};

const EXECUTION_DEFAULTS = [
  'request_success',
  'response_normalization_success',
  'attempt_count',
  'timeout_occurred',
  'retry_overhead_ms',
  'operation_elapsed_ms',
  'successful_attempt_latency_ms'
];

const STREAMING_DEFAULTS = [
  'stream_completed',
  'time_to_first_chunk_ms',
  'time_to_first_output_ms',
  'time_per_output_token_ms',
  'decode_output_tokens_per_second'
];

const CANONICAL_TOOL_METRIC_SET = new Set<string>(CANONICAL_TOOL_CALL_METRICS);

export function planMetricObservationSamples(input: {
  stages: MetricObservationStagePlan[];
  streaming: boolean;
}): MetricObservationSample[] {
  return input.stages.flatMap((stage) => {
    if (!stage.record_metrics) return [];
    const itemCount = stage.stage_type === 'single_request'
      ? Math.min(stage.item_count, 1)
      : stage.item_count;
    const pairMembers = stage.stage_type === 'paired_request_loop'
      ? stage.pair_member_ids
      : [null];
    const samples: MetricObservationSample[] = [];
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      for (let iteration = 0; iteration < stage.iterations_per_item; iteration += 1) {
        for (const pairMemberId of pairMembers) {
          samples.push({
            stage_id: stage.stage_id,
            item_index: itemIndex,
            iteration,
            pair_member_id: pairMemberId,
            streaming: input.streaming,
            expected: true,
            attempted: false,
            completed: false,
            attempt_observations: [],
            terminal_observations: null
          });
        }
      }
    }
    return samples;
  });
}

function requestedMetricForContext(
  reference: string,
  pairMemberId: string | null
): string | null {
  const parts = reference.split('.');
  if (pairMemberId === null) {
    return parts.length === 1 ? parts[0] : null;
  }
  return parts.length === 3 && parts[0] === 'pair' && parts[1] === pairMemberId
    ? parts[2]
    : null;
}

function intent(
  context: CanonicalMetricIntentContext,
  metricId: string
): CanonicalMetricIntent {
  const definition = METRIC_DEFINITIONS[metricId];
  if (!definition) {
    throw new Error(`Canonical metric definition is missing: ${metricId}`);
  }
  return {
    stage_id: context.stage_id,
    pair_member_id: context.pair_member_id,
    metric_id: metricId,
    ...definition
  };
}

export function resolveCanonicalMetricIntents(
  context: CanonicalMetricIntentContext
): CanonicalMetricIntent[] {
  const metricIds = new Set(EXECUTION_DEFAULTS);
  if (context.streaming) {
    for (const metricId of STREAMING_DEFAULTS) metricIds.add(metricId);
  }

  const references = [
    ...context.requested_metrics,
    ...(context.derived_metric_references ?? [])
  ];
  const requestedCorrectnessMetrics: string[] = [];
  for (const reference of references) {
    const requestedMetric = requestedMetricForContext(reference, context.pair_member_id);
    if (!requestedMetric) continue;
    requestedCorrectnessMetrics.push(requestedMetric);
    const canonicalMetric = LEGACY_PERFORMANCE_ALIASES[requestedMetric];
    if (canonicalMetric) metricIds.add(canonicalMetric);
  }

  const correctnessMetrics = resolveCanonicalCorrectnessMetricIds(requestedCorrectnessMetrics);
  for (const metricId of correctnessMetrics) metricIds.add(metricId);
  const requestsToolMetrics = correctnessMetrics.some(
    (metricId) => CANONICAL_TOOL_METRIC_SET.has(metricId)
  );
  if (context.streaming && requestsToolMetrics) {
    metricIds.add('time_to_first_tool_call_ms');
    metricIds.add('time_to_tool_calls_ready_ms');
  }

  return [...metricIds].map((metricId) => intent(context, metricId));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

function provenanceSignature(observation: MetricObservation): CanonicalProvenanceSignature {
  return {
    source: observation.source,
    provider_id: observation.provider_id,
    provider_protocol: observation.provider_protocol,
    provider_version: observation.provider_version,
    native_field: observation.native_field,
    accounting_scope: observation.accounting_scope
      ? stableValue(observation.accounting_scope) as Record<string, unknown>
      : null
  };
}

function uniqueProvenanceSignatures(
  observations: MetricObservation[]
): CanonicalProvenanceSignature[] {
  const signatures = new Map<string, CanonicalProvenanceSignature>();
  for (const observation of observations) {
    const signature = provenanceSignature(observation);
    signatures.set(JSON.stringify(signature), signature);
  }
  return [...signatures.values()];
}

function computeStat(
  aggregation: CanonicalNumericAggregation,
  values: number[]
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  switch (aggregation) {
    case 'mean':
      return mean;
    case 'median':
    case 'p50':
      return interpolatedPercentile(sorted, 50);
    case 'min':
      return sorted[0];
    case 'max':
      return sorted[sorted.length - 1];
    case 'sum':
      return values.reduce((sum, value) => sum + value, 0);
    case 'stddev':
      return Math.sqrt(
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      );
    case 'variance':
      return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    case 'p90':
      return interpolatedPercentile(sorted, 90);
    case 'p95':
      return interpolatedPercentile(sorted, 95);
    case 'p99':
      return interpolatedPercentile(sorted, 99);
  }
}

function interpolatedPercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function percentileWarnings(
  aggregations: CanonicalNumericAggregation[],
  validSampleCount: number
): string[] {
  const warnings: string[] = [];
  const thresholds: Partial<Record<CanonicalNumericAggregation, number>> = {
    p90: 10,
    p95: 20,
    p99: 100
  };
  for (const aggregation of aggregations) {
    const threshold = thresholds[aggregation];
    if (threshold !== undefined && validSampleCount < threshold) {
      warnings.push(`insufficient_valid_samples_for_${aggregation}`);
    }
  }
  return warnings;
}

function observationForIntent(
  sample: MetricObservationSample,
  metricId: string
): MetricObservation | null {
  const matches = (sample.terminal_observations ?? []).filter(
    (observation) => observation.metric_id === metricId
  );
  if (matches.length > 1) {
    throw new Error(
      `Duplicate metric observation for ${sample.stage_id}/${sample.item_index}/${sample.iteration}/${String(sample.pair_member_id)}: ${metricId}`
    );
  }
  return matches[0] ?? null;
}

function validateObservation(
  observation: MetricObservation,
  intentValueType: CanonicalMetricValueType,
  unit: string
): void {
  if (observation.metric_version !== 'metrics-v2') {
    throw new Error(`Unexpected metric version for ${observation.metric_id}`);
  }
  if (observation.unit !== unit) {
    throw new Error(`Conflicting unit for ${observation.metric_id}`);
  }
  if (observation.status !== 'measured') return;
  if (intentValueType === 'boolean' && typeof observation.value !== 'boolean') {
    throw new Error(`Conflicting value type for ${observation.metric_id}`);
  }
  if (
    intentValueType === 'number'
    && (typeof observation.value !== 'number' || !Number.isFinite(observation.value))
  ) {
    throw new Error(`Conflicting value type for ${observation.metric_id}`);
  }
}

export function aggregateMetricObservations(input: {
  samples: MetricObservationSample[];
  intents: CanonicalMetricIntent[];
  requestedAggregations: string[];
}): CanonicalMetricAggregate[] {
  const requestedAggregations = [...new Set(input.requestedAggregations)]
    .filter((aggregation): aggregation is CanonicalNumericAggregation => (
      aggregation !== 'count'
      && [
        'mean',
        'median',
        'min',
        'max',
        'sum',
        'stddev',
        'variance',
        'p50',
        'p90',
        'p95',
        'p99'
      ].includes(aggregation)
    ));
  const uniqueIntents = new Map<string, CanonicalMetricIntent>();
  for (const candidate of input.intents) {
    const key = [
      candidate.stage_id,
      candidate.pair_member_id ?? '',
      candidate.metric_id
    ].join('\u0000');
    const existing = uniqueIntents.get(key);
    if (
      existing
      && (existing.unit !== candidate.unit || existing.value_type !== candidate.value_type)
    ) {
      throw new Error(`Conflicting intent definition for ${candidate.metric_id}`);
    }
    uniqueIntents.set(key, candidate);
  }

  return [...uniqueIntents.values()].map((metricIntent) => {
    const samples = input.samples.filter((sample) => (
      sample.stage_id === metricIntent.stage_id
      && sample.pair_member_id === metricIntent.pair_member_id
    ));
    const measuredObservations: MetricObservation[] = [];
    const numericValues: number[] = [];
    let attemptedSampleCount = 0;
    let completedSampleCount = 0;
    let validSampleCount = 0;
    let passedSampleCount = 0;
    let unavailableSampleCount = 0;
    let notApplicableSampleCount = 0;
    let executionErrorSampleCount = 0;

    for (const sample of samples) {
      if (!sample.attempted) continue;
      attemptedSampleCount += 1;
      if (sample.completed) completedSampleCount += 1;
      const observation = observationForIntent(sample, metricIntent.metric_id);
      if (!observation) {
        if (sample.completed) {
          unavailableSampleCount += 1;
        } else {
          executionErrorSampleCount += 1;
        }
        continue;
      }
      validateObservation(observation, metricIntent.value_type, metricIntent.unit);
      switch (observation.status) {
        case 'measured':
          validSampleCount += 1;
          measuredObservations.push(observation);
          if (metricIntent.value_type === 'boolean') {
            if (observation.value === true) passedSampleCount += 1;
          } else {
            numericValues.push(observation.value as number);
          }
          break;
        case 'unavailable':
          unavailableSampleCount += 1;
          break;
        case 'not_applicable':
          notApplicableSampleCount += 1;
          break;
        case 'execution_error':
          executionErrorSampleCount += 1;
          break;
      }
    }

    const provenanceSignatures = uniqueProvenanceSignatures(measuredObservations);
    const aggregationEligible = provenanceSignatures.length <= 1;
    const warnings = percentileWarnings(requestedAggregations, validSampleCount);
    if (!aggregationEligible) {
      warnings.push('incompatible_provenance_or_accounting_scope');
    }
    const statistics: Partial<Record<CanonicalNumericAggregation, number>> = {};
    if (metricIntent.value_type === 'number' && aggregationEligible) {
      for (const aggregation of requestedAggregations) {
        const value = computeStat(aggregation, numericValues);
        if (value !== null) statistics[aggregation] = value;
      }
    }
    const expectedSampleCount = samples.length;
    return {
      stage_id: metricIntent.stage_id,
      pair_member_id: metricIntent.pair_member_id,
      metric_id: metricIntent.metric_id,
      metric_version: 'metrics-v2',
      value_type: metricIntent.value_type,
      unit: metricIntent.unit,
      expected_sample_count: expectedSampleCount,
      attempted_sample_count: attemptedSampleCount,
      completed_sample_count: completedSampleCount,
      valid_sample_count: validSampleCount,
      passed_sample_count: passedSampleCount,
      unavailable_sample_count: unavailableSampleCount,
      not_applicable_sample_count: notApplicableSampleCount,
      execution_error_sample_count: executionErrorSampleCount,
      observed_pass_rate: metricIntent.value_type === 'boolean'
        ? (validSampleCount > 0 ? passedSampleCount / validSampleCount : null)
        : null,
      coverage_rate: expectedSampleCount > 0 ? validSampleCount / expectedSampleCount : 0,
      end_to_end_pass_rate: metricIntent.value_type === 'boolean'
        ? (expectedSampleCount > 0 ? passedSampleCount / expectedSampleCount : 0)
        : null,
      statistics,
      aggregation_eligible: aggregationEligible,
      provenance_signatures: provenanceSignatures,
      warnings
    };
  });
}
