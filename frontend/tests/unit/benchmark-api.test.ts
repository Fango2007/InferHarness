import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildBenchmarkSmokePayload,
  createBenchmarkInstantiation,
  deleteBenchmarkDocument,
  listBenchmarkDocuments,
  prepareBenchmarkDatasetManifest,
  runBenchmarkInstantiation,
  saveBenchmarkDocument
} from '../../src/services/benchmark-api.js';

beforeEach(() => {
  vi.unstubAllGlobals();
});

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
      seed: '42'
    });

    expect(payload.server_id).toBe('srv-1');
    expect(payload.model_id).toBe('model-a');
    expect(payload.template).toMatchObject({
      kind: 'test_template',
      schema_version: 'benchmark_test_template_v1',
      operation: 'chat_completion',
      required_capabilities: { streaming: true }
    });
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
      seed: ''
    });

    expect(payload.template.required_capabilities).toMatchObject({ streaming: false });
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
});
