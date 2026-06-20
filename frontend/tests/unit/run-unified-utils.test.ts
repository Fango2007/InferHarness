import { expect, test } from 'vitest';

import {
  assignRunAccents,
  evaluateTemplateCompatibility,
  findLinkedDatasetManifest,
  mergeRunModelOptions,
  parseRunTargets,
  selectCompatibleTemplateId,
  serializeRunTargets,
  summarizeBenchmarkMetricFailures
} from '../../src/services/run-unified-utils.js';

test('run target query params parse legacy and repeated target params', () => {
  const search = new URLSearchParams(
    'serverId=legacy-server&modelId=legacy%2Fmodel&target=s1:model-a&target=s2:model%2Fb'
  );
  expect(parseRunTargets(search)).toEqual([
    { inference_server_id: 'legacy-server', model_id: 'legacy/model' },
    { inference_server_id: 's1', model_id: 'model-a' },
    { inference_server_id: 's2', model_id: 'model/b' }
  ]);
});

test('run target serialization preserves slash-bearing model ids', () => {
  const serialized = serializeRunTargets([
    { inference_server_id: 's1', model_id: 'org/model' },
    { inference_server_id: 's2', model_id: 'plain' }
  ]);
  expect(parseRunTargets(serialized)).toEqual([
    { inference_server_id: 's1', model_id: 'org/model' },
    { inference_server_id: 's2', model_id: 'plain' }
  ]);
});

test('accent assignment is stable by selection order', () => {
  const accented = assignRunAccents([
    { inference_server_id: 's1', model_id: 'a' },
    { inference_server_id: 's1', model_id: 'b' }
  ]);
  expect(accented.map((target) => [target.stable_letter, target.accent_index])).toEqual([
    ['A', 0],
    ['B', 1]
  ]);
});

test('model options merge discovery with persisted model metadata', () => {
  const servers = [
    {
      inference_server: { server_id: 's1', display_name: 'Local', active: true, archived: false },
      discovery: {
        model_list: {
          normalised: [
            {
              model_id: 'model-a',
              display_name: 'Model A',
              context_window_tokens: 4096,
              quantisation: { method: 'gguf', bits: 4 }
            }
          ]
        }
      }
    }
  ] as any;
  const models = [
    {
      model: {
        server_id: 's1',
        model_id: 'model-a',
        display_name: 'Persisted A',
        active: true,
        archived: false
      },
      architecture: { quantisation: { method: 'mlx', bits: 8 } },
      limits: { context_window_tokens: 8192 }
    },
    {
      model: {
        server_id: 's1',
        model_id: 'model-b',
        display_name: 'Persisted B',
        active: true,
        archived: false
      },
      discovery: { discovery_status: 'absent' },
      architecture: { quantisation: { method: 'none', bits: null } },
      limits: { context_window_tokens: null }
    }
  ] as any;

  const options = mergeRunModelOptions(servers, models);
  expect(options).toHaveLength(1);
  expect(options.find((option) => option.model_id === 'model-a')).toMatchObject({
    display_name: 'Persisted A',
    quantisation: 'mlx 8b',
    context_window_tokens: 8192,
    tool_calling_supported: false,
    source: 'merged'
  });
  expect(options.find((option) => option.model_id === 'model-b')).toBeUndefined();
});

test('model options mark tool calling supported when only the server declares tools', () => {
  const servers = [
    {
      inference_server: { server_id: 's1', display_name: 'Local', active: true, archived: false },
      capabilities: { generation: { tools: true } },
      discovery: { model_list: { normalised: [] } }
    }
  ] as any;
  const models = [
    {
      model: {
        server_id: 's1',
        model_id: 'model-a',
        display_name: 'Persisted A',
        active: true,
        archived: false
      },
      capabilities: { generation: { tools: false } },
      architecture: { quantisation: { method: 'none', bits: null } },
      limits: { context_window_tokens: null }
    }
  ] as any;

  expect(mergeRunModelOptions(servers, models)[0]).toMatchObject({
    model_id: 'model-a',
    tool_calling_supported: true
  });
});

function runOption(input: {
  server?: string;
  model?: string;
  context?: number | null;
  tools?: boolean;
}) {
  return {
    inference_server_id: input.server ?? 's1',
    model_id: input.model ?? 'model-a',
    display_name: input.model ?? 'model-a',
    server_name: input.server ?? 's1',
    quantisation: null,
    context_window_tokens: input.context ?? null,
    tool_calling_supported: input.tools ?? false,
    source: 'persisted' as const
  };
}

function contextTemplate(size: string, tokens: number) {
  return {
    id: `model-context-needle-${size}-v1`,
    document: {
      template_id: `model-context-needle-${size}-v1`,
      metadata: {
        benchmark_family: 'context_window',
        context_window_tokens: tokens
      },
      required_capabilities: { tool_calling: false }
    }
  };
}

function toolTemplate() {
  return {
    id: 'server-tool-choice-required-v1',
    document: {
      template_id: 'server-tool-choice-required-v1',
      required_capabilities: { tool_calling: true }
    }
  };
}

test('template compatibility disables context templates above the selected model window', () => {
  const result = evaluateTemplateCompatibility(
    contextTemplate('64k', 64000),
    [{ inference_server_id: 's1', model_id: 'model-a' }],
    [runOption({ context: 32000 })]
  );

  expect(result).toEqual({
    compatible: false,
    reasons: ['requires 64k, model declares 32k']
  });
});

test('template compatibility keeps context templates enabled when model window is unknown', () => {
  expect(evaluateTemplateCompatibility(
    contextTemplate('256k', 256000),
    [{ inference_server_id: 's1', model_id: 'model-a' }],
    [runOption({ context: null })]
  ).compatible).toBe(true);
});

test('template compatibility disables tool-calling templates without model or server tool support', () => {
  expect(evaluateTemplateCompatibility(
    toolTemplate(),
    [{ inference_server_id: 's1', model_id: 'model-a' }],
    [runOption({ tools: false })]
  )).toEqual({
    compatible: false,
    reasons: ['requires tool calling']
  });
});

test('template compatibility keeps tool-calling templates enabled when tools are supported', () => {
  expect(evaluateTemplateCompatibility(
    toolTemplate(),
    [{ inference_server_id: 's1', model_id: 'model-a' }],
    [runOption({ tools: true })]
  ).compatible).toBe(true);
});

test('selectCompatibleTemplateId moves a disabled context template to the largest compatible same-family template', () => {
  const templates = [
    contextTemplate('4k', 4000),
    contextTemplate('8k', 8000),
    contextTemplate('16k', 16000),
    contextTemplate('32k', 32000),
    contextTemplate('64k', 64000)
  ];

  expect(selectCompatibleTemplateId(
    'model-context-needle-64k-v1',
    templates,
    [{ inference_server_id: 's1', model_id: 'model-a' }],
    [runOption({ context: 32000 })]
  )).toBe('model-context-needle-32k-v1');
});

test('findLinkedDatasetManifest returns the unique dataset linked by template record id', () => {
  const template = {
    id: 'template-record-id',
    document: { template_id: 'template-document-id' }
  };
  const datasets = [
    { id: 'dataset-a', document: { metadata: { template_id: 'other-template' } } },
    { id: 'dataset-b', document: { metadata: { template_id: 'template-record-id' } } }
  ];

  expect(findLinkedDatasetManifest(template, datasets)).toBe(datasets[1]);
});

test('findLinkedDatasetManifest also matches the template document id', () => {
  const template = {
    id: 'template-record-id',
    document: { template_id: 'template-document-id' }
  };
  const datasets = [
    { id: 'dataset-a', document: { metadata: { template_id: 'template-document-id' } } }
  ];

  expect(findLinkedDatasetManifest(template, datasets)).toBe(datasets[0]);
});

test('findLinkedDatasetManifest returns null without a unique linked dataset', () => {
  const template = {
    id: 'template-record-id',
    document: { template_id: 'template-document-id' }
  };

  expect(findLinkedDatasetManifest(template, [])).toBeNull();
  expect(findLinkedDatasetManifest(template, [
    { id: 'dataset-a', document: { metadata: { template_id: 'template-document-id' } } },
    { id: 'dataset-b', document: { metadata: { template_id: 'template-record-id' } } }
  ])).toBeNull();
});

test('summarizeBenchmarkMetricFailures reports tool argument assertion failures by item count', () => {
  expect(summarizeBenchmarkMetricFailures([
    {
      tool_call_count: 1,
      tool_selected_correctly: true,
      tool_arguments_valid: true,
      tool_call_assertion_pass: true,
      missing_tool_call: false,
      hallucinated_tool_call: false
    },
    {
      tool_call_count: 1,
      tool_selected_correctly: true,
      tool_arguments_valid: false,
      tool_call_assertion_pass: false,
      missing_tool_call: false,
      hallucinated_tool_call: false
    }
  ])).toEqual({
    failedCount: 1,
    totalCount: 2,
    categories: ['invalid tool arguments', 'tool-call assertion failed'],
    message: 'functional check failed 1/2 items: invalid tool arguments; tool-call assertion failed'
  });
});

test('summarizeBenchmarkMetricFailures reports missing required terms when exact match is disabled', () => {
  expect(summarizeBenchmarkMetricFailures([
    {
      contains_required_terms: true
    },
    {
      contains_required_terms: false
    }
  ])).toEqual({
    failedCount: 1,
    totalCount: 2,
    categories: ['required terms missing'],
    message: 'functional check failed 1/2 items: required terms missing'
  });
});

test('summarizeBenchmarkMetricFailures returns null when no functional metric failed', () => {
  expect(summarizeBenchmarkMetricFailures([
    {
      tool_selected_correctly: true,
      tool_arguments_valid: true,
      tool_call_assertion_pass: true,
      schema_valid: true,
      contains_required_terms: true
    }
  ])).toBeNull();
});
