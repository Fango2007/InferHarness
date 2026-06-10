import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { resetDbInstance } from '../../src/models/db.js';
import { createInferenceServer } from '../../src/models/inference-server.js';
import { createModel } from '../../src/models/model.js';
import { BENCHMARK_DATASET_ROOT_ENV } from '../../src/services/benchmark-datasets.js';
import { sha256Document } from '../../src/services/benchmark-schemas.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

function benchmarkTemplate(iterations = 1, stopOnError = false): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: 'runner_chat_v1',
    template_version: '1.0.0',
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
        iterations_per_item: iterations,
        record_metrics: true,
        stop_on_error: stopOnError
      }
    ],
    metrics: ['input_tokens', 'output_tokens', 'elapsed_ms'],
    aggregations: ['mean']
  };
}

function seedServerAndModel(
  baseUrl: string,
  options: { schemaFamily?: string[]; streaming?: boolean; authToken?: string } = {}
): void {
  const schemaFamily = options.schemaFamily ?? ['openai-compatible'];
  const streaming = options.streaming ?? true;
  createInferenceServer({
    inference_server: {
      server_id: 'srv-runner',
      display_name: 'Runner Server',
      active: true,
      archived: false,
      archived_at: null
    },
    runtime: {
      retrieved_at: '2026-06-05T10:00:00.000Z',
      source: 'server',
      server_software: { name: 'mock-openai', version: '1.0.0', build: null },
      api: { schema_family: schemaFamily, api_version: null },
      platform: {
        os: { name: 'macos', version: null, arch: 'arm64' },
        container: { type: 'none', image: null }
      },
      hardware: { cpu: { model: null, cores: null }, gpu: [], ram_mb: null }
    },
    endpoints: { base_url: baseUrl, health_url: null, https: false },
    auth: options.authToken
      ? { type: 'bearer', header_name: 'Authorization', token_env: null, token: options.authToken }
      : { type: 'none', header_name: 'Authorization', token_env: null, token: null },
    capabilities: {
      server: { streaming, models_endpoint: true },
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
      retrieved_at: '2026-06-05T10:00:00.000Z',
      ttl_seconds: 300,
      model_list: { raw: {}, normalised: [] }
    },
    raw: {}
  });

  createModel({
    model_schema_version: '1.2.0',
    model: {
      server_id: 'srv-runner',
      model_id: 'mock-chat',
      display_name: 'Mock Chat',
      active: true,
      archived: false,
      archived_at: null,
      base_model_name: 'Mock'
    },
    identity: {
      provider: 'custom',
      family: 'mock',
      version: null,
      revision: null,
      checksum: null,
      quantized_provider: null
    },
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
    discovery: { retrieved_at: '2026-06-05T10:00:00.000Z', source: 'manual' },
    raw: {}
  });
}

function installMockInferenceFetch(status: number | number[] = 200): { baseUrl: string; requests: unknown[]; headers: Record<string, string>[] } {
  const requests: unknown[] = [];
  const headers: Record<string, string>[] = [];
  const statuses = Array.isArray(status) ? [...status] : [status];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'http://mock.local/v1/chat/completions') {
      return new Response('', { status: 404 });
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push(body);
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const nextStatus = statuses.length > 1 ? statuses.shift() ?? 200 : statuses[0] ?? 200;
    if (nextStatus >= 400) {
      return new Response(JSON.stringify({ error: { message: 'mock failure' } }), {
        status: nextStatus,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'benchmark answer' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }));
  return { baseUrl: 'http://mock.local', requests, headers };
}

function streamResponse(chunks: string[], contentType: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
}

function installMockOpenAiStreamFetch(mode: 'ok' | 'malformed' | 'retry' = 'ok'): { baseUrl: string; requests: unknown[] } {
  const requests: unknown[] = [];
  let callCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'http://mock.local/v1/chat/completions') {
      return new Response('', { status: 404 });
    }
    callCount += 1;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push(body);
    if (mode === 'retry' && callCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'try again' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (mode === 'malformed') {
      return streamResponse(['data: {"choices":\n\n'], 'text/event-stream');
    }
    return streamResponse([
      'data: {"choices":[{"delta":{"content":"benchmark "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n'
    ], 'text/event-stream');
  }));
  return { baseUrl: 'http://mock.local', requests };
}

function installMockOllamaStreamFetch(): { baseUrl: string; requests: unknown[] } {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'http://mock.local/api/chat') {
      return new Response('', { status: 404 });
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push(body);
    return streamResponse([
      `${JSON.stringify({ message: { role: 'assistant', content: 'benchmark ' }, done: false })}\n`,
      `${JSON.stringify({ message: { role: 'assistant', content: 'answer' }, done: false })}\n`,
      `${JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 2 })}\n`
    ], 'application/x-ndjson');
  }));
  return { baseUrl: 'http://mock.local', requests };
}

function runtimeProfile(executionPolicy: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'runtime_profile',
    schema_version: 'benchmark_runtime_profile_v1',
    profile_id: 'runner-runtime',
    runtime_parameters: { temperature: 0.1, max_tokens: 32, stream: false, timeout_ms: 5000 },
    execution_policy: executionPolicy
  };
}

function streamingRuntimeProfile(executionPolicy: Record<string, unknown> = { timeout_ms: 5000 }): Record<string, unknown> {
  return {
    kind: 'runtime_profile',
    schema_version: 'benchmark_runtime_profile_v1',
    profile_id: 'runner-runtime-stream',
    runtime_parameters: { temperature: 0.1, max_tokens: 32, stream: true, timeout_ms: 5000 },
    execution_policy: executionPolicy
  };
}

function manifestOnlyDataset(pathName: string, items: Array<Record<string, unknown>>): Record<string, unknown> {
  const source = { source_type: 'file', format: 'jsonl', path: pathName };
  return {
    kind: 'dataset_manifest',
    schema_version: 'benchmark_dataset_manifest_v1',
    dataset_id: 'manifest-runner',
    source,
    canonicalization_version: 'dataset_canonical_v1',
    snapshot_policy: 'manifest_only',
    dataset_hash: sha256Document({
      source,
      canonicalization_version: 'dataset_canonical_v1',
      item_count: items.length,
      items
    }),
    item_count: items.length,
    item_hashes: items.map((item) => ({ item_id: String(item.id), hash: sha256Document(item) })),
    item_manifest_ref: null,
    snapshot_blob_ref: null
  };
}

describe('benchmark runner API', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  let tmpDir: string;
  let mockServer: { baseUrl: string; requests: unknown[]; headers?: Record<string, string>[] } | null = null;
  let previousDatasetRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-runner-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    previousDatasetRoot = process.env[BENCHMARK_DATASET_ROOT_ENV];
    process.env[BENCHMARK_DATASET_ROOT_ENV] = tmpDir;
    resetDbInstance();
  });

  afterEach(() => {
    mockServer = null;
    vi.unstubAllGlobals();
    if (previousDatasetRoot === undefined) {
      delete process.env[BENCHMARK_DATASET_ROOT_ENV];
    } else {
      process.env[BENCHMARK_DATASET_ROOT_ENV] = previousDatasetRoot;
    }
    resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes an embedded dataset instantiation and persists a real benchmark result', async () => {
    mockServer = installMockInferenceFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: {
          kind: 'runtime_profile',
          schema_version: 'benchmark_runtime_profile_v1',
          profile_id: 'runner-runtime',
          runtime_parameters: { temperature: 0.1, max_tokens: 32, stream: false, timeout_ms: 5000 },
          execution_policy: { timeout_ms: 5000 }
        },
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', system_prompt: 'Be concise.', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);
    const instantiation = createResponse.json();

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${instantiation.id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.instantiation_id).toBe(instantiation.id);
    expect(result.document.status).toBe('completed');
    expect(result.document.raw_responses).toHaveLength(1);
    expect(result.document.normalized_responses[0].answer_text).toBe('benchmark answer');
    expect(result.document.metric_results[0].total_tokens).toBe(7);
    expect(result.document.metric_version).toBe('metrics-v1');
    expect(result.document.aggregated_metrics.elapsed_ms.valid_sample_count).toBe(1);
    expect(mockServer.requests).toHaveLength(1);
    expect((mockServer.requests[0] as Record<string, unknown>).model).toBe('mock-chat');

    const getResponse = await app.inject({
      method: 'GET',
      url: `/benchmark/results/${result.id}`,
      headers: AUTH_HEADERS
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().document_hash).toBe(result.document_hash);
    await app.close();
  });

  it('sends saved bearer auth headers to OpenAI-compatible benchmark chat requests', async () => {
    mockServer = installMockInferenceFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl, { authToken: 'mistral-secret' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: runtimeProfile({ timeout_ms: 5000 }),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    expect(mockServer.headers?.[0]).toMatchObject({
      authorization: 'Bearer mistral-secret',
      'content-type': 'application/json'
    });
    await app.close();
  });

  it('persists OpenAI SSE stream events, normalized answer, and first token timing', async () => {
    mockServer = installMockOpenAiStreamFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: streamingRuntimeProfile(),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed');
    expect(result.document.raw_responses[0].stream.format).toBe('sse');
    expect(result.document.raw_responses[0].stream.done).toBe(true);
    expect(result.document.raw_responses[0].stream.events).toHaveLength(3);
    expect(result.document.normalized_responses[0].answer_text).toBe('benchmark answer');
    expect(result.document.normalized_responses[0].stream.done).toBe(true);
    expect(result.document.metric_results[0].first_token_ms).toEqual(expect.any(Number));
    expect(result.document.metric_results[0].total_tokens).toBe(7);
    expect((mockServer.requests[0] as Record<string, unknown>).stream).toBe(true);
    await app.close();
  });

  it('persists Ollama JSONL stream chunks, normalized answer, and final token counts', async () => {
    mockServer = installMockOllamaStreamFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl, { schemaFamily: ['ollama'] });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: streamingRuntimeProfile(),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed');
    expect(result.document.raw_responses[0].stream.format).toBe('jsonl');
    expect(result.document.raw_responses[0].stream.done).toBe(true);
    expect(result.document.normalized_responses[0].answer_text).toBe('benchmark answer');
    expect(result.document.metric_results[0].input_tokens).toBe(6);
    expect(result.document.metric_results[0].output_tokens).toBe(2);
    expect(result.document.metric_results[0].total_tokens).toBe(8);
    expect((mockServer.requests[0] as Record<string, unknown>).stream).toBe(true);
    await app.close();
  });

  it('retries transient streaming HTTP failures according to policy', async () => {
    mockServer = installMockOpenAiStreamFetch('retry');
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: streamingRuntimeProfile({
          timeout_ms: 5000,
          retry_policy: { max_retries: 1, retry_on: ['http_503'], backoff: 'none' }
        }),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed');
    expect(result.document.stage_results[0].results[0].attempts).toBe(2);
    expect(result.document.stage_results[0].results[0].attempt_errors[0].code).toBe('http_503');
    expect(result.document.normalized_responses[0].answer_text).toBe('benchmark answer');
    expect(mockServer.requests).toHaveLength(2);
    await app.close();
  });

  it('persists completed_with_errors diagnostics for malformed stream chunks', async () => {
    mockServer = installMockOpenAiStreamFetch('malformed');
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: streamingRuntimeProfile(),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed_with_errors');
    expect(result.document.errors[0].code).toBe('malformed_stream');
    expect(result.document.errors[0].message).toContain('Malformed OpenAI SSE stream event');
    expect(result.document.raw_responses[0].stream.parse_error).toContain('Malformed OpenAI SSE stream event');
    expect(result.document.normalized_responses[0].stream.done).toBe(false);
    await app.close();
  });

  it('rejects streaming execution when operation_spec does not support streaming', async () => {
    mockServer = installMockOpenAiStreamFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl, { streaming: false });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: streamingRuntimeProfile(),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(400);
    expect(runResponse.json().error).toContain('supports_streaming');
    expect(mockServer.requests).toHaveLength(0);
    await app.close();
  });

  it('persists diagnostic data when the upstream model request fails', async () => {
    mockServer = installMockInferenceFetch(500);
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed_with_errors');
    expect(result.document.errors[0].code).toBe('http_500');
    expect(result.document.stage_results[0].status).toBe('failed');
    expect(result.document.raw_responses[0].status).toBe(500);
    await app.close();
  });

  it('executes a manifest_only JSONL dataset after hash verification', async () => {
    mockServer = installMockInferenceFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);
    const datasetItems = [
      { id: 'item-1', prompt: 'Run first benchmark.' },
      { id: 'item-2', prompt: 'Run second benchmark.' }
    ];
    fs.writeFileSync(
      path.join(tmpDir, 'manifest-dataset.jsonl'),
      `${JSON.stringify(datasetItems[0])}\n${JSON.stringify(datasetItems[1])}\n`,
      'utf8'
    );

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        dataset: manifestOnlyDataset('manifest-dataset.jsonl', datasetItems)
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed');
    expect(result.document.metric_results).toHaveLength(2);
    expect(result.document.aggregated_metrics.elapsed_ms.valid_sample_count).toBe(2);
    expect(mockServer.requests).toHaveLength(2);
    await app.close();
  });

  it('rejects manifest_only hash mismatch before any model request', async () => {
    mockServer = installMockInferenceFetch();
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);
    const datasetItems = [{ id: 'item-1', prompt: 'Original prompt.' }];
    fs.writeFileSync(path.join(tmpDir, 'bad-dataset.jsonl'), `${JSON.stringify({ id: 'item-1', prompt: 'Changed prompt.' })}\n`, 'utf8');
    const dataset = manifestOnlyDataset('bad-dataset.jsonl', datasetItems);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        dataset
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(400);
    expect(runResponse.json().error).toContain('dataset_hash mismatch');
    expect(mockServer.requests).toHaveLength(0);
    await app.close();
  });

  it('retries transient HTTP failures and persists the successful attempt count', async () => {
    mockServer = installMockInferenceFetch([503, 200]);
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: runtimeProfile({
          timeout_ms: 5000,
          retry_policy: { max_retries: 1, retry_on: ['http_503'], backoff: 'none' }
        }),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed');
    expect(result.document.stage_results[0].results[0].attempts).toBe(2);
    expect(result.document.stage_results[0].results[0].attempt_errors[0].code).toBe('http_503');
    expect(mockServer.requests).toHaveLength(2);
    await app.close();
  });

  it('persists retry exhaustion as completed_with_errors', async () => {
    mockServer = installMockInferenceFetch([503, 503]);
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: runtimeProfile({
          timeout_ms: 5000,
          retry_policy: { max_retries: 1, retry_on: ['http_503'], backoff: 'none' }
        }),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [{ id: 'item-1', prompt: 'Run benchmark.' }]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('completed_with_errors');
    expect(result.document.errors[0].code).toBe('http_503');
    expect(result.document.stage_results[0].results[0].attempts).toBe(2);
    expect(mockServer.requests).toHaveLength(2);
    await app.close();
  });

  it('honors stop_on_error and marks remaining work skipped', async () => {
    mockServer = installMockInferenceFetch(500);
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(1, true),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [
            { id: 'item-1', prompt: 'Run first.' },
            { id: 'item-2', prompt: 'Run second.' }
          ]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('cancelled');
    expect(result.document.metadata.cancellation_reason).toBe('stage_stop_on_error');
    expect(result.document.stage_results[0].results[1].status).toBe('skipped');
    expect(mockServer.requests).toHaveLength(1);
    await app.close();
  });

  it('cancels after max consecutive errors and skips remaining items', async () => {
    mockServer = installMockInferenceFetch(500);
    const app = createServer();
    seedServerAndModel(mockServer.baseUrl);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template: benchmarkTemplate(),
        server_id: 'srv-runner',
        model_id: 'mock-chat',
        runtime_profile: runtimeProfile({
          timeout_ms: 5000,
          cancellation_policy: { max_consecutive_errors: 2, persist_partial_results: true }
        }),
        dataset: {
          dataset_id: 'embedded-runner',
          source: { source_type: 'inline', format: 'json' },
          snapshot_policy: 'embedded',
          items: [
            { id: 'item-1', prompt: 'Run first.' },
            { id: 'item-2', prompt: 'Run second.' },
            { id: 'item-3', prompt: 'Run third.' }
          ]
        }
      }
    });
    expect(createResponse.statusCode, JSON.stringify(createResponse.json())).toBe(201);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/benchmark/instantiations/${createResponse.json().id}/run`,
      headers: AUTH_HEADERS
    });
    expect(runResponse.statusCode).toBe(201);
    const result = runResponse.json();
    expect(result.document.status).toBe('cancelled');
    expect(result.document.metadata.cancellation_reason).toBe('max_consecutive_errors');
    expect(result.document.stage_results[0].results[2].status).toBe('skipped');
    expect(mockServer.requests).toHaveLength(2);
    await app.close();
  });
});
