export type BenchmarkMetricGroup = 'performance' | 'tool_calling' | 'structured_output' | 'answer_checks';

export interface BenchmarkMetricMetadata {
  id: string;
  label: string;
  group: BenchmarkMetricGroup;
}

export interface CorrectnessMetricTile {
  id: string;
  label: string;
  displayLabel: string;
  successRate: number;
  count: number;
  state: 'pass' | 'fail' | 'neutral';
}

export const TOOL_CALL_ASSERTION_METRIC = 'tool_call_assertion_pass';

export const BENCHMARK_METRIC_METADATA: BenchmarkMetricMetadata[] = [
  { id: 'elapsed_ms', label: 'Duration', group: 'performance' },
  { id: 'first_token_ms', label: 'TTFT', group: 'performance' },
  { id: 'input_tokens', label: 'Input tokens', group: 'performance' },
  { id: 'output_tokens', label: 'Output tokens', group: 'performance' },
  { id: 'total_tokens', label: 'Total tokens', group: 'performance' },
  { id: 'tokens_per_second', label: 'Tokens per second', group: 'performance' },
  { id: 'decode_tokens_per_second', label: 'Decode tokens per second', group: 'performance' },
  { id: 'prefill_tokens_per_second', label: 'Prefill tokens per second', group: 'performance' },
  { id: 'output_input_token_ratio', label: 'Output/input ratio', group: 'performance' },
  { id: TOOL_CALL_ASSERTION_METRIC, label: 'Tool-call assertion pass', group: 'tool_calling' },
  { id: 'tool_call_count', label: 'Tool call count', group: 'tool_calling' },
  { id: 'tool_selected_correctly', label: 'Tool selected', group: 'tool_calling' },
  { id: 'tool_arguments_valid', label: 'Tool arguments valid', group: 'tool_calling' },
  { id: 'missing_tool_call', label: 'Missing tool call', group: 'tool_calling' },
  { id: 'hallucinated_tool_call', label: 'Hallucinated tool call', group: 'tool_calling' },
  { id: 'json_valid', label: 'JSON valid', group: 'structured_output' },
  { id: 'schema_valid', label: 'Schema valid', group: 'structured_output' },
  { id: 'regex_match', label: 'Regex match', group: 'answer_checks' },
  { id: 'exact_match', label: 'Exact match', group: 'answer_checks' },
  { id: 'contains_required_terms', label: 'Required terms found', group: 'answer_checks' }
];

export const BENCHMARK_METRICS = BENCHMARK_METRIC_METADATA.map((metric) => metric.id);

export const METRIC_GROUP_LABELS: Record<BenchmarkMetricGroup, string> = {
  performance: 'Performance',
  tool_calling: 'Tool calling',
  structured_output: 'Structured output',
  answer_checks: 'Answer checks'
};

export const METRIC_GROUP_ORDER: BenchmarkMetricGroup[] = [
  'performance',
  'tool_calling',
  'structured_output',
  'answer_checks'
];

export function benchmarkMetricLabel(metric: string): string {
  return BENCHMARK_METRIC_METADATA.find((entry) => entry.id === metric)?.label ?? metric;
}

export function groupedBenchmarkMetrics(): Array<{ group: BenchmarkMetricGroup; metrics: BenchmarkMetricMetadata[] }> {
  return METRIC_GROUP_ORDER.map((group) => ({
    group,
    metrics: BENCHMARK_METRIC_METADATA.filter((metric) => metric.group === group)
  }));
}

export function ensureToolCallAssertionMetric(metrics: string[], toolCallingEnabled: boolean): string[] {
  if (!toolCallingEnabled || metrics.includes(TOOL_CALL_ASSERTION_METRIC)) {
    return metrics;
  }
  return [...metrics, TOOL_CALL_ASSERTION_METRIC];
}

const CORRECTNESS_METRIC_IDS = new Set([
  'exact_match',
  'json_valid',
  'schema_valid',
  'regex_match',
  'contains_required_terms',
  TOOL_CALL_ASSERTION_METRIC,
  'tool_selected_correctly',
  'tool_arguments_valid',
  'missing_tool_call',
  'hallucinated_tool_call'
]);

export function correctnessMetricTiles(
  aggregatedMetrics: Record<string, Record<string, unknown>> | null | undefined
): CorrectnessMetricTile[] {
  if (!aggregatedMetrics) return [];
  return BENCHMARK_METRIC_METADATA
    .filter((metric) => CORRECTNESS_METRIC_IDS.has(metric.id))
    .flatMap((metric) => {
      const entry = aggregatedMetrics[metric.id];
      if (typeof entry?.success_rate !== 'number') return [];
      const successRate = entry.success_rate;
      const isAssertion = metric.id === TOOL_CALL_ASSERTION_METRIC;
      return [{
        id: metric.id,
        label: metric.label,
        displayLabel: isAssertion
          ? successRate >= 1 ? 'Tool call pass' : 'Tool call fail'
          : metric.label,
        successRate,
        count: typeof entry.count === 'number' ? entry.count : 0,
        state: isAssertion ? successRate >= 1 ? 'pass' : 'fail' : 'neutral'
      }];
    });
}
