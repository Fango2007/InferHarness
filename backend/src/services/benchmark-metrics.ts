import { Ajv2020 } from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ allErrors: false, strict: false });
ajv.addFormat('date-time', true);

const META_FIELDS = new Set(['stage_id', 'item_index', 'iteration']);

export interface ItemMetricInputs {
  requestedMetrics: string[];
  timing: {
    elapsed_ms: number | null;
    first_token_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    load_duration_ms: number | null;
    server_total_time_ms: number | null;
    server_prompt_eval_ms: number | null;
    server_eval_ms: number | null;
  };
  answerText: string;
  toolCalls: unknown[] | null;
  item: Record<string, unknown>;
}

export function computeItemMetrics(args: ItemMetricInputs): Record<string, number | boolean | null> {
  const { requestedMetrics, timing, answerText, toolCalls, item } = args;
  const result: Record<string, number | boolean | null> = {};

  for (const metric of requestedMetrics) {
    switch (metric) {
      case 'input_tokens':
        result.input_tokens = timing.input_tokens;
        break;
      case 'output_tokens':
        result.output_tokens = timing.output_tokens;
        break;
      case 'total_tokens':
        result.total_tokens = timing.total_tokens;
        break;
      case 'elapsed_ms':
        result.elapsed_ms = timing.elapsed_ms;
        break;
      case 'first_token_ms':
        result.first_token_ms = timing.first_token_ms;
        break;
      case 'load_duration_ms':
        result.load_duration_ms = timing.load_duration_ms;
        break;
      case 'server_total_time_ms':
        result.server_total_time_ms = timing.server_total_time_ms;
        break;
      case 'server_prompt_eval_ms':
        result.server_prompt_eval_ms = timing.server_prompt_eval_ms;
        break;
      case 'server_eval_ms':
        result.server_eval_ms = timing.server_eval_ms;
        break;
      case 'tokens_per_second': {
        const out = timing.output_tokens;
        const ms = timing.elapsed_ms;
        result.tokens_per_second = out !== null && ms !== null && ms > 0 ? out / (ms / 1000) : null;
        break;
      }
      case 'decode_tokens_per_second': {
        const out = timing.output_tokens;
        const ms = timing.elapsed_ms;
        const ttft = timing.first_token_ms;
        const decodeMs = ms !== null && ttft !== null ? ms - ttft : null;
        result.decode_tokens_per_second = out !== null && decodeMs !== null && decodeMs > 0
          ? out / (decodeMs / 1000)
          : null;
        break;
      }
      case 'prefill_tokens_per_second': {
        const inp = timing.input_tokens;
        const ttft = timing.first_token_ms;
        result.prefill_tokens_per_second = inp !== null && ttft !== null && ttft > 0
          ? inp / (ttft / 1000)
          : null;
        break;
      }
      case 'output_input_token_ratio': {
        const out = timing.output_tokens;
        const inp = timing.input_tokens;
        result.output_input_token_ratio = out !== null && inp !== null && inp > 0 ? out / inp : null;
        break;
      }
      case 'exact_match': {
        const expected = item.expected_answer;
        result.exact_match = typeof expected === 'string'
          ? answerText.trim() === expected.trim()
          : null;
        break;
      }
      case 'contains_required_terms': {
        const expected = item.expected_answer;
        if (Array.isArray(expected)) {
          result.contains_required_terms = (expected as unknown[]).every(
            (term) => typeof term === 'string' && answerText.toLowerCase().includes(term.toLowerCase())
          );
        } else if (typeof expected === 'string') {
          result.contains_required_terms = answerText.toLowerCase().includes(expected.toLowerCase());
        } else {
          result.contains_required_terms = null;
        }
        break;
      }
      case 'json_valid': {
        if (answerText.trim().length === 0) {
          result.json_valid = null;
        } else {
          try {
            JSON.parse(answerText);
            result.json_valid = true;
          } catch {
            result.json_valid = false;
          }
        }
        break;
      }
      case 'schema_valid': {
        const schema = item.expected_schema;
        if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
          try {
            const parsed = JSON.parse(answerText);
            const validate = ajv.compile(schema as Record<string, unknown>);
            result.schema_valid = validate(parsed) as boolean;
          } catch {
            result.schema_valid = false;
          }
        } else {
          result.schema_valid = null;
        }
        break;
      }
      case 'regex_match': {
        const fmt = item.expected_format;
        const pattern = item.expected_answer;
        if (fmt === 'regex' && typeof pattern === 'string') {
          try {
            result.regex_match = new RegExp(pattern).test(answerText);
          } catch {
            result.regex_match = null;
          }
        } else {
          result.regex_match = null;
        }
        break;
      }
      case 'tool_call_count':
        result.tool_call_count = toolCalls !== null ? toolCalls.length : null;
        break;
      case 'tool_selected_correctly':
        result.tool_selected_correctly = computeToolSelectedCorrectly(toolCalls, item.expected_tool_calls);
        break;
      case 'tool_arguments_valid':
        result.tool_arguments_valid = computeToolArgumentsValid(toolCalls, item.expected_tool_calls);
        break;
      case 'tool_call_assertion_pass':
        result.tool_call_assertion_pass = computeToolCallAssertionPass(toolCalls, item.expected_tool_calls);
        break;
      case 'missing_tool_call':
        result.missing_tool_call = computeMissingToolCall(toolCalls, item.expected_tool_calls);
        break;
      case 'hallucinated_tool_call':
        result.hallucinated_tool_call = computeHallucinatedToolCall(toolCalls, item.expected_tool_calls);
        break;
    }
  }

  return result;
}

export function aggregateMetrics(
  metricResults: Record<string, unknown>[],
  requestedAggregations: string[],
  expectedSampleCount: number
): Record<string, Record<string, unknown>> {
  const numericValues = new Map<string, number[]>();
  const booleanValues = new Map<string, boolean[]>();
  const totalSamples = metricResults.length;

  for (const m of metricResults) {
    for (const [key, val] of Object.entries(m)) {
      if (META_FIELDS.has(key)) continue;
      if (typeof val === 'number') {
        const list = numericValues.get(key) ?? [];
        list.push(val);
        numericValues.set(key, list);
      } else if (typeof val === 'boolean') {
        const list = booleanValues.get(key) ?? [];
        list.push(val);
        booleanValues.set(key, list);
      }
    }
  }

  const result: Record<string, Record<string, unknown>> = {};

  for (const [key, values] of numericValues) {
    const agg: Record<string, unknown> = {};
    for (const stat of requestedAggregations) {
      const v = computeStat(stat, values);
      if (v !== null) agg[stat] = v;
    }
    const validCount = values.length;
    agg.count = totalSamples;
    agg.valid_sample_count = validCount;
    if (validCount < expectedSampleCount) {
      agg.expected_sample_count = expectedSampleCount;
      agg.missing_sample_count = expectedSampleCount - validCount;
      agg.partial_execution = true;
    }
    result[key] = agg;
  }

  for (const [key, values] of booleanValues) {
    const validCount = values.length;
    const trueCount = values.filter(Boolean).length;
    const agg: Record<string, unknown> = {
      success_rate: validCount > 0 ? trueCount / validCount : null,
      count: totalSamples,
      valid_sample_count: validCount
    };
    if (validCount < expectedSampleCount) {
      agg.expected_sample_count = expectedSampleCount;
      agg.missing_sample_count = expectedSampleCount - validCount;
      agg.partial_execution = true;
    }
    result[key] = agg;
  }

  return result;
}

function computeStat(stat: string, values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;

  switch (stat) {
    case 'mean':
      return values.reduce((s, v) => s + v, 0) / n;
    case 'min':
      return sorted[0];
    case 'max':
      return sorted[n - 1];
    case 'sum':
      return values.reduce((s, v) => s + v, 0);
    case 'count':
      return n;
    case 'median':
      return interpolatedPercentile(sorted, 50);
    case 'p50':
      return interpolatedPercentile(sorted, 50);
    case 'p90':
      return interpolatedPercentile(sorted, 90);
    case 'p95':
      return interpolatedPercentile(sorted, 95);
    case 'p99':
      return interpolatedPercentile(sorted, 99);
    case 'stddev': {
      const mean = values.reduce((s, v) => s + v, 0) / n;
      return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    }
    case 'variance': {
      const mean = values.reduce((s, v) => s + v, 0) / n;
      return values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    }
    default:
      return null;
  }
}

function interpolatedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface LoadEstimate {
  basis: 'first_token_ms' | 'elapsed_ms';
  cold_ms: number;
  warm_baseline_ms: number;
  warm_sample_count: number;
  estimated_load_ms: number;
  model_load_detected: boolean;
}

export function estimateRequestTriggeredLoad(
  metricResults: Record<string, unknown>[]
): LoadEstimate | null {
  if (metricResults.length < 3) return null;

  const useFirstToken = metricResults.every(
    (r) => typeof r.first_token_ms === 'number' && r.first_token_ms !== null
  );
  const basis: 'first_token_ms' | 'elapsed_ms' = useFirstToken ? 'first_token_ms' : 'elapsed_ms';

  const first = metricResults[0];
  const coldMs = typeof first[basis] === 'number' ? (first[basis] as number) : null;
  if (coldMs === null) return null;

  const warmValues = metricResults.slice(1).map((r) => r[basis]).filter((v): v is number => typeof v === 'number');
  if (warmValues.length < 2) return null;

  const sortedWarm = [...warmValues].sort((a, b) => a - b);
  const warmBaseline = interpolatedPercentile(sortedWarm, 50);
  const warmMean = warmValues.reduce((s, v) => s + v, 0) / warmValues.length;
  const warmStddev = Math.sqrt(warmValues.reduce((s, v) => s + (v - warmMean) ** 2, 0) / warmValues.length);

  const estimatedLoadMs = Math.max(0, coldMs - warmBaseline);
  const threshold = Math.max(warmBaseline * 0.5, 3 * warmStddev);
  const modelLoadDetected = (coldMs - warmBaseline) > threshold;

  return {
    basis,
    cold_ms: coldMs,
    warm_baseline_ms: warmBaseline,
    warm_sample_count: warmValues.length,
    estimated_load_ms: estimatedLoadMs,
    model_load_detected: modelLoadDetected
  };
}

function callName(call: unknown): string | null {
  if (!call || typeof call !== 'object') return null;
  const r = call as Record<string, unknown>;
  const fn = r.function as Record<string, unknown> | undefined;
  const name = typeof fn?.name === 'string' ? fn.name : typeof r.name === 'string' ? r.name : null;
  return name;
}

function callArguments(call: unknown): unknown {
  if (!call || typeof call !== 'object') return undefined;
  const r = call as Record<string, unknown>;
  const fn = r.function as Record<string, unknown> | undefined;
  return fn?.arguments ?? r.arguments;
}

function normalizedArguments(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function structuralEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structuralEqual(value, right[index]));
  }
  if (
    left && right
    && typeof left === 'object'
    && typeof right === 'object'
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => (
      key === rightKeys[index] && structuralEqual(leftRecord[key], rightRecord[key])
    ));
  }
  return false;
}

function expectedCallNames(expected: unknown): string[] {
  if (!Array.isArray(expected)) return [];
  return (expected as unknown[]).flatMap((e) => {
    const name = callName(e);
    return name ? [name] : [];
  });
}

function computeToolSelectedCorrectly(actual: unknown[] | null, expected: unknown): boolean | null {
  if (!Array.isArray(expected) || expected.length === 0) return null;
  const actualNames = (actual ?? []).flatMap((c) => { const n = callName(c); return n ? [n] : []; });
  return expectedCallNames(expected).every((name) => actualNames.includes(name));
}

function computeToolArgumentsValid(actual: unknown[] | null, expected: unknown): boolean | null {
  if (!Array.isArray(expected) || expected.length === 0 || actual === null) return null;
  return (expected as unknown[]).every((exp) => {
    if (!exp || typeof exp !== 'object') return false;
    const e = exp as Record<string, unknown>;
    const name = callName(e);
    if (!name) return false;
    const match = actual.find((a) => callName(a) === name);
    if (!match) return false;
    const expectedArgs = callArguments(e);
    if (expectedArgs === undefined) return true;
    return structuralEqual(normalizedArguments(callArguments(match)), normalizedArguments(expectedArgs));
  });
}

function computeToolCallAssertionPass(actual: unknown[] | null, expected: unknown): boolean | null {
  if (!Array.isArray(expected)) return null;
  const actualCalls = actual ?? [];
  if (expected.length === 0) return actualCalls.length === 0;
  if (actualCalls.length !== expected.length) return false;

  const unmatchedActual = [...actualCalls];
  return (expected as unknown[]).every((exp) => {
    const name = callName(exp);
    if (!name) return false;
    const expectedArgs = callArguments(exp);
    const index = unmatchedActual.findIndex((candidate) => {
      if (callName(candidate) !== name) return false;
      if (expectedArgs === undefined) return true;
      return structuralEqual(normalizedArguments(callArguments(candidate)), normalizedArguments(expectedArgs));
    });
    if (index < 0) return false;
    unmatchedActual.splice(index, 1);
    return true;
  }) && unmatchedActual.length === 0;
}

function computeMissingToolCall(actual: unknown[] | null, expected: unknown): boolean | null {
  if (!Array.isArray(expected) || expected.length === 0) return null;
  const actualNames = (actual ?? []).flatMap((c) => { const n = callName(c); return n ? [n] : []; });
  return expectedCallNames(expected).some((name) => !actualNames.includes(name));
}

function computeHallucinatedToolCall(actual: unknown[] | null, expected: unknown): boolean | null {
  if (!Array.isArray(expected) || actual === null) return null;
  const actualNames = actual.flatMap((c) => { const n = callName(c); return n ? [n] : []; });
  const expectedNames = expectedCallNames(expected);
  return actualNames.some((name) => !expectedNames.includes(name));
}
