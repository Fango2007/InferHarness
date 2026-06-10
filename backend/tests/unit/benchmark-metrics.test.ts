import { describe, expect, it } from 'vitest';

import { aggregateMetrics, computeItemMetrics } from '../../src/services/benchmark-metrics.js';

const BASE_TIMING = {
  elapsed_ms: 1000,
  first_token_ms: 100,
  input_tokens: 10,
  output_tokens: 20,
  total_tokens: 30
};

describe('computeItemMetrics', () => {
  describe('timing metrics — passthrough', () => {
    it('returns timing values when requested', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['elapsed_ms', 'first_token_ms', 'input_tokens', 'output_tokens', 'total_tokens'],
        timing: BASE_TIMING,
        answerText: 'hello',
        toolCalls: null,
        item: {}
      });
      expect(result.elapsed_ms).toBe(1000);
      expect(result.first_token_ms).toBe(100);
      expect(result.input_tokens).toBe(10);
      expect(result.output_tokens).toBe(20);
      expect(result.total_tokens).toBe(30);
    });

    it('returns null when timing values are null', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['first_token_ms'],
        timing: { ...BASE_TIMING, first_token_ms: null },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.first_token_ms).toBeNull();
    });

    it('only computes requested metrics', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['elapsed_ms'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.elapsed_ms).toBe(1000);
      expect(result.input_tokens).toBeUndefined();
    });
  });

  describe('derived numeric metrics', () => {
    it('computes tokens_per_second', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tokens_per_second'],
        timing: { ...BASE_TIMING, output_tokens: 60, elapsed_ms: 2000 },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.tokens_per_second).toBeCloseTo(30);
    });

    it('tokens_per_second is null when elapsed_ms is 0', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tokens_per_second'],
        timing: { ...BASE_TIMING, elapsed_ms: 0 },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.tokens_per_second).toBeNull();
    });

    it('tokens_per_second is null when output_tokens is null', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tokens_per_second'],
        timing: { ...BASE_TIMING, output_tokens: null },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.tokens_per_second).toBeNull();
    });

    it('computes output_input_token_ratio', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['output_input_token_ratio'],
        timing: { ...BASE_TIMING, output_tokens: 20, input_tokens: 10 },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.output_input_token_ratio).toBeCloseTo(2);
    });

    it('output_input_token_ratio is null when input_tokens is 0', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['output_input_token_ratio'],
        timing: { ...BASE_TIMING, input_tokens: 0 },
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.output_input_token_ratio).toBeNull();
    });
  });

  describe('correctness metrics', () => {
    it('exact_match: true when trimmed strings match', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['exact_match'],
        timing: BASE_TIMING,
        answerText: '  hello  ',
        toolCalls: null,
        item: { expected_answer: 'hello' }
      });
      expect(result.exact_match).toBe(true);
    });

    it('exact_match: false when strings differ', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['exact_match'],
        timing: BASE_TIMING,
        answerText: 'hello',
        toolCalls: null,
        item: { expected_answer: 'world' }
      });
      expect(result.exact_match).toBe(false);
    });

    it('exact_match: null when expected_answer is not a string', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['exact_match'],
        timing: BASE_TIMING,
        answerText: 'hello',
        toolCalls: null,
        item: {}
      });
      expect(result.exact_match).toBeNull();
    });

    it('contains_required_terms: true for string substring match', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['contains_required_terms'],
        timing: BASE_TIMING,
        answerText: 'The quick brown fox',
        toolCalls: null,
        item: { expected_answer: 'brown' }
      });
      expect(result.contains_required_terms).toBe(true);
    });

    it('contains_required_terms: case-insensitive', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['contains_required_terms'],
        timing: BASE_TIMING,
        answerText: 'The Quick Brown Fox',
        toolCalls: null,
        item: { expected_answer: 'quick brown' }
      });
      expect(result.contains_required_terms).toBe(true);
    });

    it('contains_required_terms: all array terms must be present', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['contains_required_terms'],
        timing: BASE_TIMING,
        answerText: 'alpha beta gamma',
        toolCalls: null,
        item: { expected_answer: ['alpha', 'beta', 'delta'] }
      });
      expect(result.contains_required_terms).toBe(false);
    });

    it('contains_required_terms: null when expected_answer absent', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['contains_required_terms'],
        timing: BASE_TIMING,
        answerText: 'hello',
        toolCalls: null,
        item: {}
      });
      expect(result.contains_required_terms).toBeNull();
    });

    it('json_valid: true for valid JSON', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['json_valid'],
        timing: BASE_TIMING,
        answerText: '{"key": "value"}',
        toolCalls: null,
        item: {}
      });
      expect(result.json_valid).toBe(true);
    });

    it('json_valid: false for invalid JSON', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['json_valid'],
        timing: BASE_TIMING,
        answerText: 'not json',
        toolCalls: null,
        item: {}
      });
      expect(result.json_valid).toBe(false);
    });

    it('json_valid: null for empty answer', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['json_valid'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.json_valid).toBeNull();
    });

    it('schema_valid: true when answer matches expected_schema', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['schema_valid'],
        timing: BASE_TIMING,
        answerText: '{"name": "Alice", "age": 30}',
        toolCalls: null,
        item: {
          expected_schema: {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } },
            required: ['name', 'age']
          }
        }
      });
      expect(result.schema_valid).toBe(true);
    });

    it('schema_valid: false when answer fails schema', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['schema_valid'],
        timing: BASE_TIMING,
        answerText: '{"name": "Alice"}',
        toolCalls: null,
        item: {
          expected_schema: {
            type: 'object',
            required: ['name', 'age']
          }
        }
      });
      expect(result.schema_valid).toBe(false);
    });

    it('schema_valid: null when no expected_schema', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['schema_valid'],
        timing: BASE_TIMING,
        answerText: '{}',
        toolCalls: null,
        item: {}
      });
      expect(result.schema_valid).toBeNull();
    });

    it('regex_match: true when answer matches regex', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['regex_match'],
        timing: BASE_TIMING,
        answerText: 'hello world',
        toolCalls: null,
        item: { expected_format: 'regex', expected_answer: '^hello' }
      });
      expect(result.regex_match).toBe(true);
    });

    it('regex_match: false when answer does not match regex', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['regex_match'],
        timing: BASE_TIMING,
        answerText: 'goodbye world',
        toolCalls: null,
        item: { expected_format: 'regex', expected_answer: '^hello' }
      });
      expect(result.regex_match).toBe(false);
    });

    it('regex_match: null when expected_format is not regex', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['regex_match'],
        timing: BASE_TIMING,
        answerText: 'hello',
        toolCalls: null,
        item: { expected_format: 'free_text', expected_answer: 'hello' }
      });
      expect(result.regex_match).toBeNull();
    });
  });

  describe('tool-call metrics', () => {
    const toolCalls = [
      { function: { name: 'get_weather', arguments: '{"city": "Paris"}' } }
    ];
    const expectedCalls = [{ name: 'get_weather', arguments: { city: 'Paris' } }];

    it('tool_call_count', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tool_call_count'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls,
        item: {}
      });
      expect(result.tool_call_count).toBe(1);
    });

    it('tool_call_count is null when tool_calls is null', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tool_call_count'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: null,
        item: {}
      });
      expect(result.tool_call_count).toBeNull();
    });

    it('tool_selected_correctly: true when expected name is in actual calls', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tool_selected_correctly'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls,
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.tool_selected_correctly).toBe(true);
    });

    it('tool_selected_correctly: false when wrong tool called', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tool_selected_correctly'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: [{ function: { name: 'wrong_tool', arguments: '{}' } }],
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.tool_selected_correctly).toBe(false);
    });

    it('tool_selected_correctly: null when no expected_tool_calls', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['tool_selected_correctly'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls,
        item: {}
      });
      expect(result.tool_selected_correctly).toBeNull();
    });

    it('missing_tool_call: true when expected call not made', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['missing_tool_call'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: [],
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.missing_tool_call).toBe(true);
    });

    it('missing_tool_call: false when all expected calls made', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['missing_tool_call'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls,
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.missing_tool_call).toBe(false);
    });

    it('hallucinated_tool_call: true when extra call not in expected', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['hallucinated_tool_call'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls: [
          { function: { name: 'get_weather', arguments: '{}' } },
          { function: { name: 'extra_tool', arguments: '{}' } }
        ],
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.hallucinated_tool_call).toBe(true);
    });

    it('hallucinated_tool_call: false when all calls are expected', () => {
      const result = computeItemMetrics({
        requestedMetrics: ['hallucinated_tool_call'],
        timing: BASE_TIMING,
        answerText: '',
        toolCalls,
        item: { expected_tool_calls: expectedCalls }
      });
      expect(result.hallucinated_tool_call).toBe(false);
    });
  });
});

describe('aggregateMetrics', () => {
  it('computes all numeric stats for a single metric', () => {
    const results = [
      { elapsed_ms: 100 },
      { elapsed_ms: 200 },
      { elapsed_ms: 300 }
    ];
    const agg = aggregateMetrics(results, ['mean', 'min', 'max', 'sum', 'count', 'stddev'], 3);
    expect(agg.elapsed_ms.mean).toBeCloseTo(200);
    expect(agg.elapsed_ms.min).toBe(100);
    expect(agg.elapsed_ms.max).toBe(300);
    expect(agg.elapsed_ms.sum).toBe(600);
    expect(agg.elapsed_ms.count).toBe(3);
    expect(agg.elapsed_ms.valid_sample_count).toBe(3);
  });

  it('computes percentiles via linear interpolation', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const results = values.map((v) => ({ elapsed_ms: v }));
    const agg = aggregateMetrics(results, ['p50', 'p90', 'p95', 'p99', 'median'], 10);
    expect(agg.elapsed_ms.p50).toBeCloseTo(5.5);
    expect(agg.elapsed_ms.p90).toBeCloseTo(9.1);
    expect(agg.elapsed_ms.p95).toBeCloseTo(9.55);
    expect(agg.elapsed_ms.p99).toBeCloseTo(9.91);
    expect(agg.elapsed_ms.median).toBeCloseTo(5.5);
  });

  it('p50 on single value returns that value', () => {
    const agg = aggregateMetrics([{ elapsed_ms: 42 }], ['p50'], 1);
    expect(agg.elapsed_ms.p50).toBe(42);
  });

  it('computes variance', () => {
    const results = [{ v: 2 }, { v: 4 }, { v: 4 }, { v: 4 }, { v: 5 }, { v: 5 }, { v: 7 }, { v: 9 }];
    const agg = aggregateMetrics(results, ['variance', 'stddev'], 8);
    expect(agg.v.variance).toBeCloseTo(4);
    expect(agg.v.stddev).toBeCloseTo(2);
  });

  it('converts boolean metrics to success_rate', () => {
    const results = [
      { exact_match: true },
      { exact_match: true },
      { exact_match: false }
    ];
    const agg = aggregateMetrics(results, ['mean'], 3);
    expect(agg.exact_match.success_rate).toBeCloseTo(2 / 3);
    expect(agg.exact_match.count).toBe(3);
    expect(agg.exact_match.valid_sample_count).toBe(3);
  });

  it('excludes meta fields (stage_id, item_index, iteration)', () => {
    const results = [
      { stage_id: 'chat', item_index: 0, iteration: 0, elapsed_ms: 100 }
    ];
    const agg = aggregateMetrics(results, ['mean'], 1);
    expect(agg.stage_id).toBeUndefined();
    expect(agg.item_index).toBeUndefined();
    expect(agg.iteration).toBeUndefined();
    expect(agg.elapsed_ms).toBeDefined();
  });

  it('adds partial_execution fields when valid_sample_count < expectedSampleCount', () => {
    const results = [{ elapsed_ms: 100 }];
    const agg = aggregateMetrics(results, ['mean'], 5);
    expect(agg.elapsed_ms.partial_execution).toBe(true);
    expect(agg.elapsed_ms.expected_sample_count).toBe(5);
    expect(agg.elapsed_ms.missing_sample_count).toBe(4);
  });

  it('no partial_execution fields when counts match', () => {
    const results = [{ elapsed_ms: 100 }, { elapsed_ms: 200 }];
    const agg = aggregateMetrics(results, ['mean'], 2);
    expect(agg.elapsed_ms.partial_execution).toBeUndefined();
  });

  it('null metric values are excluded from valid_sample_count', () => {
    const results = [
      { tokens_per_second: 50 },
      { tokens_per_second: null as unknown as number },
      { tokens_per_second: 100 }
    ];
    const agg = aggregateMetrics(results, ['mean'], 3);
    expect(agg.tokens_per_second.valid_sample_count).toBe(2);
    expect(agg.tokens_per_second.count).toBe(3);
    expect(agg.tokens_per_second.mean).toBeCloseTo(75);
  });

  it('returns empty object for empty metric results', () => {
    const agg = aggregateMetrics([], ['mean'], 0);
    expect(Object.keys(agg)).toHaveLength(0);
  });

  it('handles multiple metrics in same result set', () => {
    const results = [
      { elapsed_ms: 100, output_tokens: 10 },
      { elapsed_ms: 200, output_tokens: 20 }
    ];
    const agg = aggregateMetrics(results, ['mean', 'sum'], 2);
    expect(agg.elapsed_ms.mean).toBeCloseTo(150);
    expect(agg.output_tokens.sum).toBe(30);
  });
});
