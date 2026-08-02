import { Ajv2020 } from 'ajv/dist/2020.js';

import { BenchmarkValidationError } from './benchmark-foundation.js';
import type {
  MetricObservation,
  MetricObservationStatus
} from './benchmark-metric-observations.js';

const ajv = new Ajv2020({ allErrors: false, strict: false });
ajv.addFormat('date-time', true);

export const CANONICAL_FUNCTIONAL_CORRECTNESS_METRICS = [
  'exact_match',
  'normalized_exact_match',
  'required_terms_present',
  'forbidden_terms_absent',
  'json_syntax_valid',
  'json_schema_valid',
  'regex_match'
] as const;

export const CANONICAL_TOOL_CALL_METRICS = [
  'tool_call_assertion_pass',
  'tool_call_count',
  'tool_selection_exact_match',
  'tool_selection_precision',
  'tool_selection_recall',
  'tool_arguments_json_valid',
  'tool_arguments_schema_valid',
  'tool_arguments_match_expected',
  'missing_tool_call_count',
  'unexpected_tool_call_count',
  'duplicate_tool_call_count'
] as const;

const LEGACY_CORRECTNESS_ALIASES: Record<string, string> = {
  exact_match: 'exact_match',
  contains_required_terms: 'required_terms_present',
  json_valid: 'json_syntax_valid',
  schema_valid: 'json_schema_valid',
  regex_match: 'regex_match',
  tool_call_assertion_pass: 'tool_call_assertion_pass',
  tool_call_count: 'tool_call_count',
  tool_selected_correctly: 'tool_selection_exact_match',
  tool_arguments_valid: 'tool_arguments_match_expected',
  missing_tool_call: 'missing_tool_call_count',
  hallucinated_tool_call: 'unexpected_tool_call_count'
};

const FUNCTIONAL_METRIC_SET = new Set<string>(CANONICAL_FUNCTIONAL_CORRECTNESS_METRICS);
const TOOL_METRIC_SET = new Set<string>(CANONICAL_TOOL_CALL_METRICS);

export interface EvaluateCanonicalCorrectnessInput {
  requestedMetricIds: string[];
  answerText: string;
  toolCalls: unknown[] | null;
  item: Record<string, unknown>;
}

interface NormalizedToolCall {
  name: string | null;
  arguments: unknown;
  arguments_declared: boolean;
  arguments_valid_json_object: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function callName(call: unknown): string | null {
  const record = objectValue(call);
  const fn = objectValue(record?.function);
  const name = typeof fn?.name === 'string'
    ? fn.name
    : typeof record?.name === 'string' ? record.name : null;
  return name && name.trim().length > 0 ? name : null;
}

function callArguments(call: unknown): unknown {
  const record = objectValue(call);
  const fn = objectValue(record?.function);
  return fn?.arguments ?? record?.arguments;
}

function normalizeArguments(value: unknown): {
  value: unknown;
  validJsonObject: boolean;
} {
  if (value === undefined || value === null || value === '') {
    return { value: {}, validJsonObject: true };
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return { value, validJsonObject: false };
    }
  }
  return {
    value: parsed,
    validJsonObject: objectValue(parsed) !== null
  };
}

function normalizeToolCall(call: unknown): NormalizedToolCall {
  const rawArguments = callArguments(call);
  const args = normalizeArguments(rawArguments);
  return {
    name: callName(call),
    arguments: args.value,
    arguments_declared: rawArguments !== undefined,
    arguments_valid_json_object: args.validJsonObject
  };
}

function structuralEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structuralEqual(value, right[index]));
  }
  const leftRecord = objectValue(left);
  const rightRecord = objectValue(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && structuralEqual(leftRecord[key], rightRecord[key])
    ));
}

function observation(input: {
  metricId: string;
  unit: string;
  value?: number | boolean;
  status?: MetricObservationStatus;
  reason?: string;
  normalization: string;
  accountingScope?: Record<string, unknown>;
}): MetricObservation {
  return {
    metric_id: input.metricId,
    value: input.value ?? null,
    unit: input.unit,
    status: input.status ?? 'measured',
    reason: input.reason ?? null,
    source: 'derived',
    metric_version: 'metrics-v2',
    provider_id: null,
    provider_protocol: null,
    provider_version: null,
    native_field: null,
    native_value: null,
    native_unit: null,
    normalization: input.normalization,
    accounting_scope: input.accountingScope ?? null
  };
}

function notApplicable(
  metricId: string,
  unit: string,
  reason: string,
  normalization: string
): MetricObservation {
  return observation({
    metricId,
    unit,
    status: 'not_applicable',
    reason,
    normalization
  });
}

function unavailable(
  metricId: string,
  unit: string,
  reason: string,
  normalization: string
): MetricObservation {
  return observation({
    metricId,
    unit,
    status: 'unavailable',
    reason,
    normalization
  });
}

export function resolveCanonicalCorrectnessMetricIds(
  requestedMetricIds: string[]
): string[] {
  const resolved = new Set<string>();
  let toolMetricRequested = false;
  for (const requested of requestedMetricIds) {
    const canonical = LEGACY_CORRECTNESS_ALIASES[requested]
      ?? (FUNCTIONAL_METRIC_SET.has(requested) || TOOL_METRIC_SET.has(requested)
        ? requested
        : null);
    if (!canonical) continue;
    if (TOOL_METRIC_SET.has(canonical)) {
      toolMetricRequested = true;
    } else {
      resolved.add(canonical);
    }
  }
  if (toolMetricRequested) {
    for (const metricId of CANONICAL_TOOL_CALL_METRICS) resolved.add(metricId);
  }
  return [...resolved];
}

function validateSchema(
  schema: unknown,
  description: string
): void {
  if (!objectValue(schema)) {
    throw new BenchmarkValidationError(`${description} must be a JSON Schema object.`);
  }
  try {
    ajv.compile(schema as Record<string, unknown>);
  } catch (error) {
    throw new BenchmarkValidationError(`${description} is invalid: ${(error as Error).message}`);
  }
}

export function validateDatasetComparatorConfiguration(
  items: Record<string, unknown>[]
): void {
  items.forEach((item, itemIndex) => {
    if (item.expected_format === 'regex') {
      if (typeof item.expected_answer !== 'string') {
        throw new BenchmarkValidationError(
          `Benchmark dataset item ${itemIndex} requires a string expected_answer for regex matching.`
        );
      }
      try {
        new RegExp(item.expected_answer);
      } catch (error) {
        throw new BenchmarkValidationError(
          `Benchmark dataset item ${itemIndex} has an invalid expected regular expression: ${(error as Error).message}`
        );
      }
    }
    if (item.expected_schema !== undefined && item.expected_schema !== null) {
      validateSchema(item.expected_schema, `Benchmark dataset item ${itemIndex} expected_schema`);
    }
    if (item.expected_tool_calls !== undefined) {
      if (!Array.isArray(item.expected_tool_calls)) {
        throw new BenchmarkValidationError(
          `Benchmark dataset item ${itemIndex} expected_tool_calls must be an array.`
        );
      }
      item.expected_tool_calls.forEach((call, callIndex) => {
        if (!callName(call)) {
          throw new BenchmarkValidationError(
            `Benchmark dataset item ${itemIndex} expected tool call ${callIndex} requires a function name.`
          );
        }
        const args = callArguments(call);
        if (args !== undefined && !objectValue(args)) {
          throw new BenchmarkValidationError(
            `Benchmark dataset item ${itemIndex} expected tool call ${callIndex} arguments must be an object.`
          );
        }
      });
    }
    if (Array.isArray(item.tools)) {
      item.tools.forEach((tool, toolIndex) => {
        const fn = objectValue(objectValue(tool)?.function);
        if (fn?.parameters !== undefined) {
          validateSchema(
            fn.parameters,
            `Benchmark dataset item ${itemIndex} tool ${toolIndex} parameters`
          );
        }
      });
    }
  });
}

function functionalObservations(
  requested: Set<string>,
  answerText: string,
  item: Record<string, unknown>
): MetricObservation[] {
  const observations: MetricObservation[] = [];
  if (requested.has('exact_match')) {
    observations.push(typeof item.expected_answer === 'string'
      ? observation({
          metricId: 'exact_match',
          unit: 'boolean',
          value: answerText.trim() === item.expected_answer.trim(),
          normalization: 'trim(answer_text) === trim(expected_answer)',
          accountingScope: { comparator: 'trimmed_exact_string' }
        })
      : notApplicable(
          'exact_match',
          'boolean',
          'The dataset item does not declare a string expected_answer.',
          'trim(answer_text) === trim(expected_answer)'
        ));
  }
  if (requested.has('normalized_exact_match')) {
    observations.push(notApplicable(
      'normalized_exact_match',
      'boolean',
      'The dataset item does not declare a canonical normalization profile.',
      'declared_normalization_profile'
    ));
  }
  if (requested.has('required_terms_present')) {
    const terms = typeof item.expected_answer === 'string'
      ? [item.expected_answer]
      : Array.isArray(item.expected_answer)
        ? item.expected_answer.filter((term): term is string => typeof term === 'string')
        : [];
    observations.push(terms.length > 0
      ? observation({
          metricId: 'required_terms_present',
          unit: 'boolean',
          value: terms.every((term) => answerText.toLowerCase().includes(term.toLowerCase())),
          normalization: 'case_insensitive_literal_substring_all',
          accountingScope: {
            comparator: 'literal_substring',
            case_sensitive: false,
            required_term_count: terms.length,
            source_field: 'expected_answer'
          }
        })
      : notApplicable(
          'required_terms_present',
          'boolean',
          'The dataset item does not declare string required terms.',
          'case_insensitive_literal_substring_all'
        ));
  }
  if (requested.has('forbidden_terms_absent')) {
    observations.push(notApplicable(
      'forbidden_terms_absent',
      'boolean',
      'The dataset item does not declare a canonical forbidden-term comparator.',
      'declared_forbidden_term_comparator'
    ));
  }
  if (requested.has('json_syntax_valid')) {
    let valid = true;
    try {
      JSON.parse(answerText);
    } catch {
      valid = false;
    }
    observations.push(observation({
      metricId: 'json_syntax_valid',
      unit: 'boolean',
      value: valid,
      normalization: 'JSON.parse(answer_text)',
      accountingScope: { parsing_scope: 'entire_answer' }
    }));
  }
  if (requested.has('json_schema_valid')) {
    const schema = objectValue(item.expected_schema);
    if (!schema) {
      observations.push(notApplicable(
        'json_schema_valid',
        'boolean',
        'The dataset item does not declare expected_schema.',
        'JSON.parse(answer_text); AJV2020(expected_schema)'
      ));
    } else {
      let valid = false;
      try {
        const parsed = JSON.parse(answerText) as unknown;
        valid = ajv.compile(schema)(parsed) as boolean;
      } catch {
        valid = false;
      }
      observations.push(observation({
        metricId: 'json_schema_valid',
        unit: 'boolean',
        value: valid,
        normalization: 'JSON.parse(answer_text); AJV2020(expected_schema)',
        accountingScope: { parsing_scope: 'entire_answer', schema_draft: '2020-12' }
      }));
    }
  }
  if (requested.has('regex_match')) {
    const pattern = item.expected_format === 'regex' && typeof item.expected_answer === 'string'
      ? item.expected_answer
      : null;
    observations.push(pattern === null
      ? notApplicable(
          'regex_match',
          'boolean',
          'The dataset item does not declare a regex expected_answer.',
          'RegExp(expected_answer).test(answer_text)'
        )
      : observation({
          metricId: 'regex_match',
          unit: 'boolean',
          value: new RegExp(pattern).test(answerText),
          normalization: 'RegExp(expected_answer).test(answer_text)',
          accountingScope: { flags: '', parsing_scope: 'entire_answer' }
        }));
  }
  return observations;
}

function nameCounts(calls: NormalizedToolCall[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (!call.name) continue;
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return counts;
}

function matchedNameCount(
  actual: Map<string, number>,
  expected: Map<string, number>
): number {
  let matched = 0;
  for (const [name, count] of actual) {
    matched += Math.min(count, expected.get(name) ?? 0);
  }
  return matched;
}

function argumentsMatchExpected(
  actual: NormalizedToolCall[],
  expected: NormalizedToolCall[]
): boolean {
  const unmatched = [...actual];
  return expected.every((expectedCall) => {
    const index = unmatched.findIndex((candidate) => (
      candidate.name === expectedCall.name
      && (
        callArgumentsPresent(expectedCall)
          ? structuralEqual(candidate.arguments, expectedCall.arguments)
          : true
      )
    ));
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
}

function callArgumentsPresent(call: NormalizedToolCall): boolean {
  return call.arguments_declared;
}

function toolSchemaByName(item: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of Array.isArray(item.tools) ? item.tools : []) {
    const record = objectValue(tool);
    const fn = objectValue(record?.function);
    const name = typeof fn?.name === 'string' ? fn.name : null;
    const parameters = objectValue(fn?.parameters);
    if (name && parameters) schemas.set(name, parameters);
  }
  return schemas;
}

function toolObservations(
  requested: Set<string>,
  toolCalls: unknown[] | null,
  item: Record<string, unknown>
): MetricObservation[] {
  if (![...requested].some((metricId) => TOOL_METRIC_SET.has(metricId))) return [];
  const expectedRaw = item.expected_tool_calls;
  const expectedDeclared = Array.isArray(expectedRaw);
  const expected = expectedDeclared ? expectedRaw.map(normalizeToolCall) : [];
  const normalization = 'order_independent_tool_call_multiset';
  const scope = { matching: 'multiset', order: 'independent' };
  const observations: MetricObservation[] = [];

  if (toolCalls === null) {
    for (const metricId of CANONICAL_TOOL_CALL_METRICS) {
      if (!requested.has(metricId)) continue;
      observations.push(metricId === 'tool_call_count'
        ? unavailable(metricId, 'count', 'Normalized tool-call data is unavailable.', normalization)
        : expectedDeclared
          ? unavailable(
              metricId,
              metricId.endsWith('_count') ? 'count' : metricId.endsWith('_precision') || metricId.endsWith('_recall') ? 'ratio' : 'boolean',
              'Normalized tool-call data is unavailable.',
              normalization
            )
          : notApplicable(
              metricId,
              metricId.endsWith('_count') ? 'count' : metricId.endsWith('_precision') || metricId.endsWith('_recall') ? 'ratio' : 'boolean',
              'The dataset item does not declare expected_tool_calls.',
              normalization
            ));
    }
    return observations;
  }

  const actual = toolCalls.map(normalizeToolCall);
  const actualCounts = nameCounts(actual);
  const expectedCounts = nameCounts(expected);
  const matched = matchedNameCount(actualCounts, expectedCounts);
  const expectedArgumentsDeclared = expected.some((call) => callArgumentsPresent(call));

  const pushExpectedMetric = (
    metricId: string,
    unit: string,
    value: number | boolean,
    metricNormalization = normalization,
    accountingScope: Record<string, unknown> = scope
  ) => {
    if (!requested.has(metricId)) return;
    observations.push(expectedDeclared
      ? observation({
          metricId,
          unit,
          value,
          normalization: metricNormalization,
          accountingScope
        })
      : notApplicable(
          metricId,
          unit,
          'The dataset item does not declare expected_tool_calls.',
          metricNormalization
        ));
  };

  if (requested.has('tool_call_count')) {
    observations.push(observation({
      metricId: 'tool_call_count',
      unit: 'count',
      value: actual.length,
      normalization: 'normalized_tool_calls.length',
      accountingScope: { call_type: 'function' }
    }));
  }
  pushExpectedMetric(
    'tool_selection_exact_match',
    'boolean',
    actual.length === expected.length && matched === expected.length
  );
  if (requested.has('tool_selection_precision')) {
    observations.push(!expectedDeclared
      ? notApplicable(
          'tool_selection_precision',
          'ratio',
          'The dataset item does not declare expected_tool_calls.',
          'matched_tool_name_count / actual_tool_call_count'
        )
      : actual.length === 0
        ? notApplicable(
            'tool_selection_precision',
            'ratio',
            'Tool selection precision requires at least one actual tool call.',
            'matched_tool_name_count / actual_tool_call_count'
          )
        : observation({
            metricId: 'tool_selection_precision',
            unit: 'ratio',
            value: matched / actual.length,
            normalization: 'matched_tool_name_count / actual_tool_call_count',
            accountingScope: scope
          }));
  }
  if (requested.has('tool_selection_recall')) {
    observations.push(!expectedDeclared
      ? notApplicable(
          'tool_selection_recall',
          'ratio',
          'The dataset item does not declare expected_tool_calls.',
          'matched_tool_name_count / expected_tool_call_count'
        )
      : expected.length === 0
        ? notApplicable(
            'tool_selection_recall',
            'ratio',
            'Tool selection recall requires at least one expected tool call.',
            'matched_tool_name_count / expected_tool_call_count'
          )
        : observation({
            metricId: 'tool_selection_recall',
            unit: 'ratio',
            value: matched / expected.length,
            normalization: 'matched_tool_name_count / expected_tool_call_count',
            accountingScope: scope
          }));
  }
  if (requested.has('tool_arguments_json_valid')) {
    observations.push(actual.length === 0
      ? notApplicable(
          'tool_arguments_json_valid',
          'boolean',
          'No actual tool-call arguments were available to validate.',
          'every(actual_arguments is parsed JSON object)'
        )
      : observation({
          metricId: 'tool_arguments_json_valid',
          unit: 'boolean',
          value: actual.every((call) => call.arguments_valid_json_object),
          normalization: 'every(actual_arguments is parsed JSON object)',
          accountingScope: { argument_shape: 'json_object' }
        }));
  }
  if (requested.has('tool_arguments_schema_valid')) {
    const schemas = toolSchemaByName(item);
    const schemasAvailable = actual.length > 0
      && actual.every((call) => call.name !== null && schemas.has(call.name));
    observations.push(actual.length === 0
      ? notApplicable(
          'tool_arguments_schema_valid',
          'boolean',
          'No actual tool-call arguments were available to validate.',
          'AJV2020(tool.function.parameters)'
        )
      : !schemasAvailable
        ? notApplicable(
            'tool_arguments_schema_valid',
            'boolean',
            'A matching tool input schema is not declared for every actual call.',
            'AJV2020(tool.function.parameters)'
          )
        : observation({
            metricId: 'tool_arguments_schema_valid',
            unit: 'boolean',
            value: actual.every((call) => (
              call.arguments_valid_json_object
              && ajv.compile(schemas.get(call.name as string) as Record<string, unknown>)(call.arguments) as boolean
            )),
            normalization: 'AJV2020(tool.function.parameters)',
            accountingScope: { schema_draft: '2020-12', matching: 'function_name' }
          }));
  }
  if (requested.has('tool_arguments_match_expected')) {
    observations.push(!expectedDeclared
      ? notApplicable(
          'tool_arguments_match_expected',
          'boolean',
          'The dataset item does not declare expected_tool_calls.',
          'distinct_structural_argument_match'
        )
      : !expectedArgumentsDeclared
        ? notApplicable(
            'tool_arguments_match_expected',
            'boolean',
            'The expected tool calls do not declare argument comparators.',
            'distinct_structural_argument_match'
          )
        : observation({
            metricId: 'tool_arguments_match_expected',
            unit: 'boolean',
            value: argumentsMatchExpected(actual, expected),
            normalization: 'distinct_structural_argument_match',
            accountingScope: scope
          }));
  }
  const assertionPass = expectedDeclared
    && actual.length === expected.length
    && matched === expected.length
    && argumentsMatchExpected(actual, expected);
  pushExpectedMetric(
    'tool_call_assertion_pass',
    'boolean',
    assertionPass,
    'exact_count_and_distinct_name_argument_match'
  );
  pushExpectedMetric(
    'missing_tool_call_count',
    'count',
    Math.max(0, expected.length - matched),
    'expected_tool_call_count - matched_tool_call_count'
  );
  pushExpectedMetric(
    'unexpected_tool_call_count',
    'count',
    Math.max(0, actual.length - matched),
    'actual_tool_call_count - matched_tool_call_count'
  );
  let duplicates = 0;
  for (const [name, count] of actualCounts) {
    duplicates += Math.max(0, count - Math.max(expectedCounts.get(name) ?? 0, 1));
  }
  pushExpectedMetric(
    'duplicate_tool_call_count',
    'count',
    duplicates,
    'actual_name_multiplicity_beyond_expected_or_first_call'
  );
  return observations;
}

export function evaluateCanonicalCorrectnessObservations(
  input: EvaluateCanonicalCorrectnessInput
): MetricObservation[] {
  const requested = new Set(resolveCanonicalCorrectnessMetricIds(input.requestedMetricIds));
  return [
    ...functionalObservations(requested, input.answerText, input.item),
    ...toolObservations(requested, input.toolCalls, input.item)
  ];
}
