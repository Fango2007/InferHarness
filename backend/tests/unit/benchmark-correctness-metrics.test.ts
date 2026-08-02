import { describe, expect, it } from 'vitest';

import {
  CANONICAL_TOOL_CALL_METRICS,
  evaluateCanonicalCorrectnessObservations,
  resolveCanonicalCorrectnessMetricIds,
  validateDatasetComparatorConfiguration
} from '../../src/services/benchmark-correctness-metrics.js';

function byId(
  observations: ReturnType<typeof evaluateCanonicalCorrectnessObservations>,
  metricId: string
) {
  const result = observations.find((observation) => observation.metric_id === metricId);
  expect(result, `Missing observation: ${metricId}`).toBeDefined();
  return result!;
}

const expectedTool = {
  type: 'function',
  function: {
    name: 'lookup',
    arguments: { query: 'status' }
  }
};

const toolDeclaration = {
  type: 'function',
  function: {
    name: 'lookup',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
};

describe('resolveCanonicalCorrectnessMetricIds', () => {
  it('maps legacy functional aliases and expands any tool request', () => {
    const resolved = resolveCanonicalCorrectnessMetricIds([
      'json_valid',
      'schema_valid',
      'contains_required_terms',
      'tool_selected_correctly'
    ]);

    expect(resolved).toEqual(expect.arrayContaining([
      'json_syntax_valid',
      'json_schema_valid',
      'required_terms_present',
      ...CANONICAL_TOOL_CALL_METRICS
    ]));
    expect(resolved).not.toContain('json_valid');
    expect(resolved).not.toContain('tool_selected_correctly');
  });
});

describe('validateDatasetComparatorConfiguration', () => {
  it('accepts valid answer and tool comparator configuration', () => {
    expect(() => validateDatasetComparatorConfiguration([{
      id: 'valid',
      prompt: 'prompt',
      expected_format: 'regex',
      expected_answer: '^ok$',
      expected_schema: { type: 'object' },
      expected_tool_calls: [expectedTool],
      tools: [toolDeclaration]
    }])).not.toThrow();
  });

  it.each([
    [
      'invalid regex',
      { expected_format: 'regex', expected_answer: '[' },
      /invalid expected regular expression/
    ],
    [
      'non-string regex',
      { expected_format: 'regex', expected_answer: 4 },
      /requires a string expected_answer/
    ],
    [
      'invalid answer schema',
      { expected_schema: { type: 'unknown-type' } },
      /expected_schema is invalid/
    ],
    [
      'missing expected tool name',
      { expected_tool_calls: [{ function: { arguments: {} } }] },
      /requires a function name/
    ],
    [
      'invalid expected arguments',
      { expected_tool_calls: [{ function: { name: 'lookup', arguments: 'not-an-object' } }] },
      /arguments must be an object/
    ],
    [
      'invalid tool schema',
      {
        tools: [{
          function: {
            name: 'lookup',
            parameters: { type: 'unknown-type' }
          }
        }]
      },
      /tool 0 parameters is invalid/
    ]
  ])('rejects %s before execution', (_name, fields, message) => {
    expect(() => validateDatasetComparatorConfiguration([{
      id: 'invalid',
      prompt: 'prompt',
      ...fields
    }])).toThrow(message as RegExp);
  });
});

describe('evaluateCanonicalCorrectnessObservations', () => {
  it('emits measured functional observations with canonical semantics', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: [
        'exact_match',
        'contains_required_terms',
        'json_valid',
        'schema_valid',
        'regex_match'
      ],
      answerText: '  {"status":"OK"}  ',
      toolCalls: [],
      item: {
        expected_answer: ['"status"', 'ok'],
        expected_schema: {
          type: 'object',
          properties: { status: { const: 'OK' } },
          required: ['status']
        }
      }
    });

    expect(byId(observations, 'exact_match').status).toBe('not_applicable');
    expect(byId(observations, 'required_terms_present')).toMatchObject({
      status: 'measured',
      value: true,
      normalization: 'case_insensitive_literal_substring_all'
    });
    expect(byId(observations, 'json_syntax_valid').value).toBe(true);
    expect(byId(observations, 'json_schema_valid').value).toBe(true);
    expect(byId(observations, 'regex_match').status).toBe('not_applicable');
  });

  it('uses trimming only for exact match and treats invalid whole-answer JSON as false', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['exact_match', 'json_syntax_valid'],
      answerText: '  Value  \nextra',
      toolCalls: [],
      item: { expected_answer: 'Value' }
    });

    expect(byId(observations, 'exact_match').value).toBe(false);
    expect(byId(observations, 'json_syntax_valid').value).toBe(false);
  });

  it('measures regex and reports deferred comparator contracts as not applicable', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: [
        'regex_match',
        'normalized_exact_match',
        'forbidden_terms_absent'
      ],
      answerText: 'ticket-42',
      toolCalls: [],
      item: {
        expected_format: 'regex',
        expected_answer: '^ticket-\\d+$'
      }
    });

    expect(byId(observations, 'regex_match').value).toBe(true);
    expect(byId(observations, 'normalized_exact_match').status).toBe('not_applicable');
    expect(byId(observations, 'forbidden_terms_absent').status).toBe('not_applicable');
  });

  it('scores order-independent tool calls and validates argument schemas', () => {
    const secondExpected = {
      function: { name: 'notify', arguments: { channel: 'ops' } }
    };
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_call_assertion_pass'],
      answerText: '',
      toolCalls: [
        { function: { name: 'notify', arguments: '{"channel":"ops"}' } },
        expectedTool
      ],
      item: {
        expected_tool_calls: [expectedTool, secondExpected],
        tools: [
          toolDeclaration,
          {
            function: {
              name: 'notify',
              parameters: {
                type: 'object',
                properties: { channel: { type: 'string' } },
                required: ['channel']
              }
            }
          }
        ]
      }
    });

    expect(observations).toHaveLength(CANONICAL_TOOL_CALL_METRICS.length);
    expect(byId(observations, 'tool_call_assertion_pass').value).toBe(true);
    expect(byId(observations, 'tool_selection_exact_match').value).toBe(true);
    expect(byId(observations, 'tool_selection_precision').value).toBe(1);
    expect(byId(observations, 'tool_selection_recall').value).toBe(1);
    expect(byId(observations, 'tool_arguments_json_valid').value).toBe(true);
    expect(byId(observations, 'tool_arguments_schema_valid').value).toBe(true);
    expect(byId(observations, 'tool_arguments_match_expected').value).toBe(true);
  });

  it('uses multiset counts for missing, unexpected, and duplicate calls', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_call_count'],
      answerText: '',
      toolCalls: [
        expectedTool,
        expectedTool,
        { function: { name: 'other', arguments: {} } }
      ],
      item: {
        expected_tool_calls: [expectedTool],
        tools: [toolDeclaration]
      }
    });

    expect(byId(observations, 'tool_call_count').value).toBe(3);
    expect(byId(observations, 'tool_selection_precision').value).toBe(1 / 3);
    expect(byId(observations, 'tool_selection_recall').value).toBe(1);
    expect(byId(observations, 'missing_tool_call_count').value).toBe(0);
    expect(byId(observations, 'unexpected_tool_call_count').value).toBe(2);
    expect(byId(observations, 'duplicate_tool_call_count').value).toBe(1);
    expect(byId(observations, 'tool_call_assertion_pass').value).toBe(false);
  });

  it('distinguishes known-empty and unavailable tool-call data', () => {
    const knownEmpty = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_call_assertion_pass'],
      answerText: '',
      toolCalls: [],
      item: { expected_tool_calls: [] }
    });
    const unavailable = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_call_assertion_pass'],
      answerText: '',
      toolCalls: null,
      item: { expected_tool_calls: [] }
    });

    expect(byId(knownEmpty, 'tool_call_assertion_pass').value).toBe(true);
    expect(byId(knownEmpty, 'tool_call_count').value).toBe(0);
    expect(byId(knownEmpty, 'tool_selection_precision').status).toBe('not_applicable');
    expect(byId(knownEmpty, 'tool_selection_recall').status).toBe('not_applicable');
    expect(byId(unavailable, 'tool_call_assertion_pass').status).toBe('unavailable');
    expect(byId(unavailable, 'tool_call_count').status).toBe('unavailable');
  });

  it('separates malformed arguments, schema validity, and expected matching', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_arguments_valid'],
      answerText: '',
      toolCalls: [{
        function: { name: 'lookup', arguments: '{"query":4}' }
      }],
      item: {
        expected_tool_calls: [expectedTool],
        tools: [toolDeclaration]
      }
    });

    expect(byId(observations, 'tool_arguments_json_valid').value).toBe(true);
    expect(byId(observations, 'tool_arguments_schema_valid').value).toBe(false);
    expect(byId(observations, 'tool_arguments_match_expected').value).toBe(false);
  });

  it('records malformed JSON tool arguments as a measured false diagnostic', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_arguments_valid'],
      answerText: '',
      toolCalls: [{
        function: { name: 'lookup', arguments: '{"query":' }
      }],
      item: {
        expected_tool_calls: [expectedTool],
        tools: [toolDeclaration]
      }
    });

    expect(byId(observations, 'tool_arguments_json_valid').value).toBe(false);
    expect(byId(observations, 'tool_arguments_schema_valid').value).toBe(false);
    expect(byId(observations, 'tool_arguments_match_expected').value).toBe(false);
  });

  it('marks missing expectations and schemas as not applicable', () => {
    const observations = evaluateCanonicalCorrectnessObservations({
      requestedMetricIds: ['tool_call_assertion_pass'],
      answerText: '',
      toolCalls: [expectedTool],
      item: {}
    });

    expect(byId(observations, 'tool_call_count').status).toBe('measured');
    expect(byId(observations, 'tool_call_assertion_pass').status).toBe('not_applicable');
    expect(byId(observations, 'tool_arguments_schema_valid').status).toBe('not_applicable');
  });
});
