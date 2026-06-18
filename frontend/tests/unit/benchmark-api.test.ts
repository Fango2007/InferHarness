import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPersistedBenchmarkPlanDocument,
  buildBenchmarkSmokePayload,
  createBenchmarkInstantiation,
  deleteBenchmarkDatasetFile,
  deleteBenchmarkDocument,
  getBenchmarkLibraryStatus,
  getBenchmarkInstantiation,
  listBenchmarkDatasetFiles,
  listBenchmarkDocuments,
  prepareBenchmarkDatasetManifest,
  readBenchmarkDatasetFile,
  reloadBenchmarkLibrary,
  runPersistedBenchmarkPlan,
  runBenchmarkInstantiation,
  saveBenchmarkDatasetFile,
  saveBenchmarkPlan,
  saveBenchmarkDocument
} from '../../src/services/benchmark-api.js';

beforeEach(() => {
  vi.unstubAllGlobals();
});

const smokeTemplate = {
  kind: 'test_template',
  schema_version: 'benchmark_test_template_v1',
  template_id: 'run-smoke-chat-v1',
  template_version: '1.0.0',
  name: 'Run smoke chat',
  operation: 'chat_completion',
  required_capabilities: {
    chat_completion: true,
    streaming: false,
    tool_calling: false,
    structured_output: false
  },
  stages: [
    {
      id: 'chat',
      type: 'dataset_loop',
      iterations_per_item: 1,
      record_metrics: true
    }
  ],
  metrics: ['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms'],
  aggregations: ['mean', 'count']
} as const;

describe('benchmark API helpers', () => {
  it('builds a benchmark smoke payload from Run page inputs', () => {
    const payload = buildBenchmarkSmokePayload({
      target: { inference_server_id: 'srv-1', model_id: 'model-a' },
      prompt: 'Say OK',
      systemPrompt: 'Be exact.',
      inferenceParams: {
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 32,
        quantization_level: 'Q4',
        stream: true
      },
      timeoutSec: '12.5',
      seed: '42',
      template: smokeTemplate
    });

    expect(payload.server_id).toBe('srv-1');
    expect(payload.model_id).toBe('model-a');
    expect(payload.template).toBe(smokeTemplate);
    expect(payload.runtime_profile.runtime_parameters).toMatchObject({
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 32,
      stream: true,
      timeout_ms: 12500,
      seed: 42
    });
    expect(payload.dataset.items).toEqual([
      { id: 'item-1', prompt: 'Say OK', system_prompt: 'Be exact.' }
    ]);
  });

  it('omits optional runtime fields that are not valid benchmark parameters', () => {
    const payload = buildBenchmarkSmokePayload({
      target: { inference_server_id: 'srv-1', model_id: 'model-a' },
      prompt: 'Say OK',
      systemPrompt: '   ',
      inferenceParams: {
        temperature: null,
        top_p: null,
        max_tokens: null,
        quantization_level: 'Q8',
        stream: false
      },
      timeoutSec: '',
      seed: '',
      template: smokeTemplate
    });

    expect(payload.template).toBe(smokeTemplate);
    expect(payload.runtime_profile.runtime_parameters).toEqual({
      temperature: null,
      top_p: null,
      max_tokens: null,
      stream: false
    });
    expect(payload.dataset.items).toEqual([{ id: 'item-1', prompt: 'Say OK' }]);
  });

  it('builds a manifest_only dataset payload for server-side dataset runs', () => {
    const payload = buildBenchmarkSmokePayload({
      target: { inference_server_id: 'srv-1', model_id: 'model-a' },
      prompt: '',
      systemPrompt: '',
      inferenceParams: {
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 32,
        quantization_level: null,
        stream: false
      },
      timeoutSec: '30',
      seed: '',
      template: smokeTemplate,
      dataset: {
        mode: 'manifest_only',
        manifest: {
          kind: 'dataset_manifest',
          dataset_id: 'codegen-small',
          snapshot_policy: 'manifest_only',
          item_count: 2
        }
      }
    });

    expect(payload.dataset).toEqual({
      kind: 'dataset_manifest',
      dataset_id: 'codegen-small',
      snapshot_policy: 'manifest_only',
      item_count: 2
    });
  });

  it('prepares dataset manifests through the benchmark API', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ manifest: { dataset_id: 'codegen-small', item_count: 2 } })
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const manifest = await prepareBenchmarkDatasetManifest({
      dataset_id: 'codegen-small',
      source: {
        source_type: 'file',
        format: 'jsonl',
        path: 'backend/data/datasets/codegen-small.jsonl'
      }
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/datasets/manifest');
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({
      dataset_id: 'codegen-small',
      source: {
        source_type: 'file',
        format: 'jsonl',
        path: 'backend/data/datasets/codegen-small.jsonl'
      }
    }));
    expect(manifest).toEqual({ dataset_id: 'codegen-small', item_count: 2 });
  });

  it('prepares inline dataset manifests through the benchmark API', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ manifest: { dataset_id: 'run-dataset-1', snapshot_policy: 'embedded', item_count: 1 } })
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const manifest = await prepareBenchmarkDatasetManifest({
      dataset_id: 'run-dataset-1',
      source: {
        source_type: 'inline',
        format: 'json'
      },
      snapshot_policy: 'embedded',
      items: [{ id: 'item-1', prompt: 'Say OK' }]
    });

    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({
      dataset_id: 'run-dataset-1',
      source: {
        source_type: 'inline',
        format: 'json'
      },
      snapshot_policy: 'embedded',
      items: [{ id: 'item-1', prompt: 'Say OK' }]
    }));
    expect(manifest).toEqual({ dataset_id: 'run-dataset-1', snapshot_policy: 'embedded', item_count: 1 });
  });

  it('manages dataset item files through the benchmark API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ path: 'sample.jsonl', dataset_id: 'sample', item_count: 1, format: 'jsonl' }])
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ path: 'sample.jsonl', dataset_id: 'sample', item_count: 1, items: [{ id: 'item-1', prompt: 'Say OK' }] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ path: 'sample.jsonl', dataset_id: 'sample', item_count: 1, items: [{ id: 'item-1', prompt: 'Say OK' }] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({})
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await listBenchmarkDatasetFiles();
    await readBenchmarkDatasetFile('sample.jsonl');
    await saveBenchmarkDatasetFile({
      path: 'sample.jsonl',
      dataset_id: 'sample',
      items: [{ id: 'item-1', prompt: 'Say OK' }]
    });
    await deleteBenchmarkDatasetFile('sample.jsonl');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/datasets/files');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/benchmark/datasets/files/read');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({ path: 'sample.jsonl' }));
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8080/benchmark/datasets/files');
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PUT');
    expect(fetchMock.mock.calls[3][0]).toBe('http://localhost:8080/benchmark/datasets/files?path=sample.jsonl');
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('DELETE');
  });

  it('posts benchmark instantiation and run requests to the existing backend routes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'bti-1', document: {} })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'btr-1', document: { status: 'completed' } })
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await createBenchmarkInstantiation({
      template: {},
      server_id: 'srv-1',
      model_id: 'model-a',
      runtime_profile: {},
      dataset: {},
      metadata: {}
    });
    await runBenchmarkInstantiation('bti-1');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/instantiations');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/benchmark/instantiations/bti-1/run');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({}));
  });

  it('lists, saves, and deletes benchmark documents through the benchmark API', async () => {
    const document = {
      kind: 'test_template',
      schema_version: 'benchmark_test_template_v1',
      template_id: 'ui-template',
      template_version: '1.0.0',
      operation: 'chat_completion',
      stages: [{ id: 'chat', type: 'dataset_loop' }],
      metrics: ['elapsed_ms'],
      aggregations: ['mean']
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ id: 'ui-template', kind: 'test_template', document }])
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'ui-template', kind: 'test_template', document })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({})
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await listBenchmarkDocuments('test_template');
    await saveBenchmarkDocument(document);
    await deleteBenchmarkDocument('test_template', 'ui-template');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/documents/test_template');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/benchmark/documents');
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify(document));
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8080/benchmark/documents/test_template/ui-template');
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('DELETE');
  });

  it('reads and reloads the benchmark library through the benchmark API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ built_in_root: '/built-in', user_root: '/user', entries: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ installed: [], skipped: [], invalid: [], deleted: [] })
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getBenchmarkLibraryStatus();
    await reloadBenchmarkLibrary();

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/library');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/benchmark/library/reload');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('builds and runs persisted benchmark plan documents', async () => {
    const document = buildPersistedBenchmarkPlanDocument({
      planId: 'run-plan-1',
      templateRef: 'run-template-1',
      datasetRef: 'run-dataset-1',
      runtimeProfileRef: 'run-runtime-1',
      targets: [
        { inference_server_id: 'srv-1', model_id: 'model-a' },
        { inference_server_id: 'srv-1', model_id: 'model-b' }
      ]
    });
    expect(document).toMatchObject({
      kind: 'benchmark_plan',
      schema_version: 'benchmark_plan_v1',
      plan_id: 'run-plan-1',
      template_ref: 'run-template-1',
      dataset_ref: 'run-dataset-1',
      runtime_profile_ref: 'run-runtime-1',
      model_profile_refs: ['srv-1:model-a', 'srv-1:model-b'],
      execution: { mode: 'sequential', continue_on_model_error: true, concurrency: 1 }
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'run-plan-1', kind: 'benchmark_plan', document })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ kind: 'benchmark_plan_result', plan_id: 'run-plan-1', run_results: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'bti-1', document: {} })
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await saveBenchmarkPlan(document);
    await runPersistedBenchmarkPlan('run-plan-1');
    await getBenchmarkInstantiation('bti-1');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/benchmark/plans');
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify(document));
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/benchmark/plans/run-plan-1/run');
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8080/benchmark/instantiations/bti-1');
  });
});
