import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { getDb, resetDbInstance } from '../../src/models/db.js';
import { createInferenceServer } from '../../src/models/inference-server.js';
import { createModel } from '../../src/models/model.js';
import { buildDatasetManifest } from '../../src/services/benchmark-foundation.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

function templateDoc(): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: 'route-template',
    template_version: '1.0.0',
    operation: 'chat_completion',
    required_capabilities: {
      chat_completion: true,
      streaming: false,
      tool_calling: false,
      structured_output: false
    },
    stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true, stop_on_error: false }],
    metrics: ['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms'],
    aggregations: ['mean', 'count']
  };
}

function runtimeDoc(): Record<string, unknown> {
  return {
    kind: 'runtime_profile',
    schema_version: 'benchmark_runtime_profile_v1',
    profile_id: 'route-runtime',
    runtime_parameters: { max_tokens: 16, stream: false }
  };
}

function datasetDoc(): Record<string, unknown> {
  return buildDatasetManifest({
    dataset_id: 'route-dataset',
    source: { source_type: 'inline', format: 'json' },
    snapshot_policy: 'embedded',
    items: [{ id: 'item-1', prompt: 'Say hello' }]
  });
}

function planDoc(): Record<string, unknown> {
  return {
    kind: 'benchmark_plan',
    schema_version: 'benchmark_plan_v1',
    plan_id: 'route-plan',
    template_ref: 'route-template',
    dataset_ref: 'route-dataset',
    runtime_profile_ref: 'route-runtime',
    model_profile_refs: ['srv-route:model-a', 'srv-route:model-b'],
    execution: { mode: 'sequential', continue_on_model_error: true }
  };
}

function seedServerAndModels(): void {
  createInferenceServer({
    inference_server: {
      server_id: 'srv-route',
      display_name: 'Route Server',
      active: true,
      archived: false,
      archived_at: null
    },
    runtime: {
      retrieved_at: '2026-06-12T10:00:00.000Z',
      source: 'server',
      server_software: { name: 'mock-openai', version: '1.0.0', build: null },
      api: { schema_family: ['openai-compatible'], api_version: null },
      platform: {
        os: { name: 'macos', version: null, arch: 'arm64' },
        container: { type: 'none', image: null }
      },
      hardware: { cpu: { model: null, cores: null }, gpu: [], ram_mb: null }
    },
    endpoints: { base_url: 'http://mock.local', health_url: null, https: false },
    auth: { type: 'none', header_name: 'Authorization', token_env: null, token: null },
    capabilities: {
      server: { streaming: true, models_endpoint: true },
      generation: { text: true, json_schema_output: true, tools: false, embeddings: false },
      multimodal: {
        vision: { input_images: false, output_images: false },
        audio: { input_audio: false, output_audio: false }
      },
      reasoning: { exposed: false, token_budget_configurable: false },
      concurrency: { parallel_requests: true, parallel_tool_calls: false, max_concurrent_requests: null },
      enforcement: 'server'
    },
    discovery: {
      retrieved_at: '2026-06-12T10:00:00.000Z',
      ttl_seconds: 300,
      model_list: { raw: {}, normalised: [] }
    },
    raw: {}
  });

  for (const modelId of ['model-a', 'model-b']) {
    createModel({
      model_schema_version: '1.2.0',
      model: {
        server_id: 'srv-route',
        model_id: modelId,
        display_name: modelId,
        active: true,
        archived: false,
        archived_at: null,
        base_model_name: modelId
      },
      identity: { provider: 'custom', family: 'mock', version: null, revision: null, checksum: null, quantized_provider: null },
      architecture: {
        type: 'decoder-only',
        parameter_count: null,
        parameter_count_label: null,
        active_parameter_label: null,
        precision: 'unknown',
        quantisation: null,
        format: null
      },
      modalities: { input: ['text'], output: ['text'] },
      capabilities: {
        generation: { text: true, json_schema_output: true, tools: false, embeddings: false },
        multimodal: { vision: false, audio: false },
        reasoning: { supported: false, explicit_tokens: false },
        use_case: { thinking: false, coding: false, instruct: true, mixture_of_experts: false }
      },
      limits: { context_window_tokens: 8192, max_output_tokens: null, max_images: null, max_batch_size: null },
      performance: {
        theoretical: { tokens_per_second: null },
        observed: { prefill_tps: null, generation_tps: null, latency_ms_p50: null, latency_ms_p95: null, measured_at: null }
      },
      configuration: {
        default_parameters: {
          temperature: null,
          top_p: null,
          top_k: null,
          presence_penalty: null,
          frequency_penalty: null,
          seed: null
        },
        context_strategy: { type: 'custom', window_tokens: null }
      },
      discovery: { retrieved_at: '2026-06-12T10:00:00.000Z', source: 'manual' },
      raw: {}
    });
  }
}

function installMockInferenceFetch(): { requests: unknown[] } {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== 'http://mock.local/v1/chat/completions') {
      return new Response('', { status: 404 });
    }
    requests.push(typeof init?.body === 'string' ? JSON.parse(init.body) : {});
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'benchmark answer' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }));
  return { requests };
}

describe('benchmark plan document routes', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-plan-route-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores benchmark documents and runs a persisted benchmark_plan by id', async () => {
    const mock = installMockInferenceFetch();
    const app = createServer();
    seedServerAndModels();

    for (const document of [templateDoc(), runtimeDoc(), datasetDoc()]) {
      const response = await app.inject({
        method: 'POST',
        url: '/benchmark/documents',
        headers: AUTH_HEADERS,
        payload: document
      });
      expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    }

    const planResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/plans',
      headers: AUTH_HEADERS,
      payload: planDoc()
    });
    expect(planResponse.statusCode, JSON.stringify(planResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/plans/route-plan/run',
      headers: AUTH_HEADERS,
      payload: {}
    });

    expect(runResponse.statusCode, JSON.stringify(runResponse.json())).toBe(201);
    expect(runResponse.json()).toMatchObject({
      kind: 'benchmark_plan_result',
      plan_id: 'route-plan'
    });
    expect(runResponse.json().run_results).toHaveLength(2);
    expect(runResponse.json().comparison.metrics.elapsed_ms['srv-route:model-a']).toEqual(expect.any(Number));
    expect(runResponse.json().comparison.metrics.elapsed_ms['srv-route:model-b']).toEqual(expect.any(Number));
    expect(mock.requests).toHaveLength(2);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM benchmark_test_run_results').get()).toEqual({ count: 2 });
    await app.close();
  });

  it('keeps the transitional inline benchmark plan route working', async () => {
    installMockInferenceFetch();
    const app = createServer();
    seedServerAndModels();

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/plans/run',
      headers: AUTH_HEADERS,
      payload: {
        plan_id: 'inline-plan',
        template: templateDoc(),
        runtime_profile: runtimeDoc(),
        dataset: datasetDoc(),
        targets: [{ server_id: 'srv-route', model_id: 'model-a' }]
      }
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(response.json().plan_id).toBe('inline-plan');
    expect(response.json().run_results).toHaveLength(1);
    await app.close();
  });
});
