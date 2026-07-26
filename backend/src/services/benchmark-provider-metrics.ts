import {
  measuredMetricValue,
  type MetricObservation,
  type ProviderProtocol
} from './benchmark-metric-observations.js';

export type {
  MetricObservation,
  MetricObservationSource,
  MetricObservationStatus,
  ProviderProtocol
} from './benchmark-metric-observations.js';

export interface ProviderMetricContext {
  protocol: ProviderProtocol;
  provider_id: string | null;
  provider_name: string | null;
  provider_version: string | null;
}

type NumericKind = 'count' | 'duration';

interface NativeMetricDefinition {
  metricId: string;
  path: string;
  unit: string;
  nativeUnit: string;
  normalization: string;
  numericKind: NumericKind;
  convert?: (value: number) => number;
  accountingScope?: Record<string, unknown>;
}

interface NativeValue {
  status: 'missing' | 'measured' | 'invalid';
  value: number | null;
}

const PROVIDER_NAMES: Record<ProviderProtocol, string[]> = {
  ollama_chat: [],
  openai_chat: ['openai', 'openai api'],
  anthropic_messages: ['anthropic', 'anthropic api'],
  gemini_generate_content: ['gemini', 'gemini api', 'google', 'google gemini']
};

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function nativeValue(
  metadata: Record<string, unknown>,
  path: string,
  numericKind: NumericKind
): NativeValue {
  const raw = valueAtPath(metadata, path);
  if (raw === undefined || raw === null) {
    return { status: 'missing', value: null };
  }
  if (
    typeof raw !== 'number'
    || !Number.isFinite(raw)
    || raw < 0
    || (numericKind === 'count' && !Number.isInteger(raw))
  ) {
    return { status: 'invalid', value: null };
  }
  return { status: 'measured', value: raw };
}

function observationSource(context: ProviderMetricContext): 'provider_reported' | 'server_reported' {
  const providerName = context.provider_name?.trim().toLowerCase() ?? '';
  return PROVIDER_NAMES[context.protocol].includes(providerName)
    ? 'provider_reported'
    : 'server_reported';
}

function nativeObservation(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>,
  definition: NativeMetricDefinition
): MetricObservation | null {
  const native = nativeValue(metadata, definition.path, definition.numericKind);
  if (native.status === 'missing') {
    return null;
  }
  if (native.status === 'invalid') {
    return {
      metric_id: definition.metricId,
      value: null,
      unit: definition.unit,
      status: 'unavailable',
      reason: `Invalid native value at ${definition.path}: expected a finite non-negative ${definition.numericKind === 'count' ? 'integer' : 'number'}.`,
      source: observationSource(context),
      metric_version: 'metrics-v2',
      provider_id: context.provider_id,
      provider_protocol: context.protocol,
      provider_version: context.provider_version,
      native_field: definition.path,
      native_value: null,
      native_unit: definition.nativeUnit,
      normalization: definition.normalization,
      accounting_scope: definition.accountingScope ?? null
    };
  }

  return {
    metric_id: definition.metricId,
    value: definition.convert ? definition.convert(native.value as number) : native.value,
    unit: definition.unit,
    status: 'measured',
    reason: null,
    source: observationSource(context),
    metric_version: 'metrics-v2',
    provider_id: context.provider_id,
    provider_protocol: context.protocol,
    provider_version: context.provider_version,
    native_field: definition.path,
    native_value: native.value,
    native_unit: definition.nativeUnit,
    normalization: definition.normalization,
    accounting_scope: definition.accountingScope ?? null
  };
}

function measuredValue(observations: MetricObservation[], metricId: string): number | null {
  return measuredMetricValue(observations, metricId);
}

function derivedObservation(
  context: ProviderMetricContext,
  metricId: string,
  unit: string,
  value: number,
  formula: string,
  accountingScope: Record<string, unknown>
): MetricObservation {
  return {
    metric_id: metricId,
    value,
    unit,
    status: 'measured',
    reason: null,
    source: 'derived',
    metric_version: 'metrics-v2',
    provider_id: context.provider_id,
    provider_protocol: context.protocol,
    provider_version: context.provider_version,
    native_field: null,
    native_value: null,
    native_unit: null,
    normalization: formula,
    accounting_scope: accountingScope
  };
}

function collectNativeObservations(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>,
  definitions: NativeMetricDefinition[]
): MetricObservation[] {
  return definitions.flatMap((definition) => {
    const observation = nativeObservation(context, metadata, definition);
    return observation ? [observation] : [];
  });
}

function normalizeOllama(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>
): MetricObservation[] {
  return collectNativeObservations(context, metadata, [
    {
      metricId: 'input_tokens',
      path: 'prompt_eval_count',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count'
    },
    {
      metricId: 'output_tokens',
      path: 'eval_count',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count'
    },
    {
      metricId: 'server_total_time_ms',
      path: 'total_duration',
      unit: 'milliseconds',
      nativeUnit: 'nanoseconds',
      normalization: 'divide_by_1000000',
      numericKind: 'duration',
      convert: (value) => value / 1_000_000
    },
    {
      metricId: 'model_load_time_ms',
      path: 'load_duration',
      unit: 'milliseconds',
      nativeUnit: 'nanoseconds',
      normalization: 'divide_by_1000000',
      numericKind: 'duration',
      convert: (value) => value / 1_000_000
    },
    {
      metricId: 'server_prefill_time_ms',
      path: 'prompt_eval_duration',
      unit: 'milliseconds',
      nativeUnit: 'nanoseconds',
      normalization: 'divide_by_1000000',
      numericKind: 'duration',
      convert: (value) => value / 1_000_000
    },
    {
      metricId: 'server_decode_time_ms',
      path: 'eval_duration',
      unit: 'milliseconds',
      nativeUnit: 'nanoseconds',
      normalization: 'divide_by_1000000',
      numericKind: 'duration',
      convert: (value) => value / 1_000_000
    }
  ]);
}

function normalizeOpenAiChat(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>
): MetricObservation[] {
  const observations = collectNativeObservations(context, metadata, [
    {
      metricId: 'input_tokens',
      path: 'usage.prompt_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count'
    },
    {
      metricId: 'cached_input_tokens',
      path: 'usage.prompt_tokens_details.cached_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'subset_of', parent_metric_id: 'input_tokens' }
    },
    {
      metricId: 'output_tokens',
      path: 'usage.completion_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count'
    }
  ]);
  const inputTokens = measuredValue(observations, 'input_tokens');
  const cachedInputTokens = measuredValue(observations, 'cached_input_tokens');
  if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens <= inputTokens) {
    observations.push(derivedObservation(
      context,
      'uncached_input_tokens',
      'tokens',
      inputTokens - cachedInputTokens,
      'usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens',
      { relationship: 'remainder_of', parent_metric_id: 'input_tokens' }
    ));
  }
  return observations;
}

function normalizeAnthropic(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>
): MetricObservation[] {
  const observations = collectNativeObservations(context, metadata, [
    {
      metricId: 'uncached_input_tokens',
      path: 'usage.input_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'additive_component_of', parent_metric_id: 'input_tokens' }
    },
    {
      metricId: 'cached_input_tokens',
      path: 'usage.cache_read_input_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'additive_component_of', parent_metric_id: 'input_tokens' }
    },
    {
      metricId: 'cache_write_input_tokens',
      path: 'usage.cache_creation_input_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'additive_component_of', parent_metric_id: 'input_tokens' }
    },
    {
      metricId: 'output_tokens',
      path: 'usage.output_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count'
    },
    {
      metricId: 'reasoning_tokens',
      path: 'usage.output_tokens_details.thinking_tokens',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'subset_of', parent_metric_id: 'output_tokens' }
    }
  ]);
  const uncached = measuredValue(observations, 'uncached_input_tokens');
  const cached = measuredValue(observations, 'cached_input_tokens');
  const cacheWrite = measuredValue(observations, 'cache_write_input_tokens');
  if (uncached !== null && cached !== null && cacheWrite !== null) {
    observations.push(derivedObservation(
      context,
      'input_tokens',
      'tokens',
      uncached + cached + cacheWrite,
      'usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens',
      {
        relationship: 'sum_of_non_overlapping_components',
        component_metric_ids: ['uncached_input_tokens', 'cached_input_tokens', 'cache_write_input_tokens']
      }
    ));
  }
  return observations;
}

function normalizeGemini(
  context: ProviderMetricContext,
  metadata: Record<string, unknown>
): MetricObservation[] {
  const observations = collectNativeObservations(context, metadata, [
    {
      metricId: 'input_tokens',
      path: 'usageMetadata.promptTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { candidate_scope: 'effective_prompt', cache_relationship: 'includes_cached_input_tokens' }
    },
    {
      metricId: 'cached_input_tokens',
      path: 'usageMetadata.cachedContentTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'subset_of', parent_metric_id: 'input_tokens' }
    },
    {
      metricId: 'output_tokens',
      path: 'usageMetadata.candidatesTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: {
        mapping_classification: 'qualified',
        candidate_scope: 'all_candidates',
        comparison_requires_equivalent_candidate_scope: true
      }
    },
    {
      metricId: 'reasoning_tokens',
      path: 'usageMetadata.thoughtsTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { relationship: 'subset_of', parent_metric_id: 'total_tokens' }
    },
    {
      metricId: 'tool_input_tokens',
      path: 'usageMetadata.toolUsePromptTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: {
        relationship: 'provider_reported_component',
        inclusion_in_input_tokens: 'unknown',
        inclusion_in_total_tokens: 'unknown'
      }
    },
    {
      metricId: 'total_tokens',
      path: 'usageMetadata.totalTokenCount',
      unit: 'tokens',
      nativeUnit: 'tokens',
      normalization: 'identity',
      numericKind: 'count',
      accountingScope: { includes: ['prompt', 'thoughts', 'response_candidates'] }
    }
  ]);
  const inputTokens = measuredValue(observations, 'input_tokens');
  const cachedInputTokens = measuredValue(observations, 'cached_input_tokens');
  if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens <= inputTokens) {
    observations.push(derivedObservation(
      context,
      'uncached_input_tokens',
      'tokens',
      inputTokens - cachedInputTokens,
      'usageMetadata.promptTokenCount - usageMetadata.cachedContentTokenCount',
      { relationship: 'remainder_of', parent_metric_id: 'input_tokens' }
    ));
  }
  return observations;
}

export function normalizeProviderMetricObservations(
  context: ProviderMetricContext,
  metadata: Record<string, unknown> | null
): MetricObservation[] {
  if (!metadata) {
    return [];
  }
  switch (context.protocol) {
    case 'ollama_chat':
      return normalizeOllama(context, metadata);
    case 'openai_chat':
      return normalizeOpenAiChat(context, metadata);
    case 'anthropic_messages':
      return normalizeAnthropic(context, metadata);
    case 'gemini_generate_content':
      return normalizeGemini(context, metadata);
    default:
      return [];
  }
}

export function measuredProviderMetric(
  observations: MetricObservation[],
  metricId: string
): number | null {
  return measuredValue(observations, metricId);
}
