import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { createBenchmarkInstantiation, createBenchmarkResult } from '../../src/models/benchmark.js';
import { getDb, resetDbInstance } from '../../src/models/db.js';
import { createInferenceServer } from '../../src/models/inference-server.js';
import { createModel } from '../../src/models/model.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(moduleDir, '../contract/fixtures/benchmark');

function readExample(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8')) as Record<string, unknown>;
}

function seedServerAndModel(): void {
  createInferenceServer({
    inference_server: {
      server_id: 'srv-local',
      display_name: 'Local Server',
      active: true,
      archived: false,
      archived_at: null
    },
    runtime: {
      retrieved_at: '2026-05-24T10:00:00.000Z',
      source: 'server',
      server_software: { name: 'ollama', version: '0.6.0', build: null },
      api: { schema_family: ['ollama'], api_version: null },
      platform: {
        os: { name: 'macos', version: null, arch: 'arm64' },
        container: { type: 'none', image: null }
      },
      hardware: { cpu: { model: null, cores: null }, gpu: [], ram_mb: null }
    },
    endpoints: { base_url: 'http://localhost:11434', health_url: null, https: false },
    auth: { type: 'bearer', header_name: 'Authorization', token_env: 'LOCAL_TOKEN', token: 'secret-token' },
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
      retrieved_at: '2026-05-24T10:00:00.000Z',
      ttl_seconds: 300,
      model_list: { raw: {}, normalised: [] }
    },
    raw: {}
  });

  createModel({
    model_schema_version: '1.2.0',
    model: {
      server_id: 'srv-local',
      model_id: 'mistral:latest',
      display_name: 'Mistral Latest',
      active: true,
      archived: false,
      archived_at: null,
      base_model_name: 'Mistral'
    },
    identity: {
      provider: 'mistral',
      family: 'mistral',
      version: null,
      revision: null,
      checksum: null,
      quantized_provider: null
    },
    architecture: {
      type: 'decoder-only',
      parameter_count: null,
      parameter_count_label: '7B',
      active_parameter_label: null,
      precision: 'int4',
      quantisation: {
        method: 'gguf',
        bits: 4,
        group_size: null,
        scheme: 'k-quant',
        variant: 'M',
        weight_format: 'Q4_K_M'
      },
      format: 'GGUF'
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
    discovery: { retrieved_at: '2026-05-24T10:00:00.000Z', source: 'manual' },
    raw: {}
  });
}

describe('benchmark foundation API', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
  });

  afterEach(() => {
    resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates, creates, reloads, and stores a synthetic benchmark result', async () => {
    const app = createServer();
    seedServerAndModel();

    const template = readExample('test_template.valid.json');
    const validateResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/validate',
      headers: AUTH_HEADERS,
      payload: { kind: 'test_template', document: template }
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(validateResponse.json()).toEqual({ ok: true, issues: [] });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template,
        server_id: 'srv-local',
        model_id: 'mistral:latest',
        runtime_profile: readExample('runtime_profile.minimal.valid.json'),
        dataset: {
          dataset_id: 'tiny-dataset',
          source: { source_type: 'inline', format: 'json', description: 'small test dataset' },
          snapshot_policy: 'manifest_only',
          items: [{ id: 'item-1', prompt: 'Explain benchmark reproducibility.' }]
        }
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.document.kind).toBe('test_instantiation');
    expect(created.document.operation_spec.protocol).toBe('ollama_chat');
    expect(created.document.model_snapshot.auth.token).toBeNull();
    expect(created.document.dataset.snapshot_policy).toBe('manifest_only');

    const getResponse = await app.inject({
      method: 'GET',
      url: `/benchmark/instantiations/${created.id}`,
      headers: AUTH_HEADERS
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().document_hash).toBe(created.document_hash);

    const resultDocument = {
      kind: 'test_run_result',
      schema_version: 'benchmark_test_run_result_v1',
      engine_version: 'offline-test',
      run_id: 'bench-run-1',
      instantiation_id: created.id,
      status: 'completed',
      started_at: '2026-05-24T10:01:00.000Z',
      completed_at: '2026-05-24T10:01:01.000Z',
      instantiation_snapshot: created.document,
      stage_results: [],
      raw_responses: [],
      normalized_responses: [],
      metric_results: [],
      aggregated_metrics: {},
      errors: [],
      warnings: []
    };

    const resultResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/results',
      headers: AUTH_HEADERS,
      payload: resultDocument
    });
    expect(resultResponse.statusCode).toBe(201);
    expect(resultResponse.json().instantiation_id).toBe(created.id);

    await app.close();
  });

  it('rejects unsupported capability prerequisites before persistence', async () => {
    const app = createServer();
    seedServerAndModel();
    const template = {
      ...readExample('test_template.valid.json'),
      required_capabilities: { tool_calling: true }
    };

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template,
        server_id: 'srv-local',
        model_id: 'mistral:latest',
        dataset: {
          dataset_id: 'tiny-dataset',
          source: { source_type: 'inline', format: 'json' },
          items: [{ id: 'item-1', prompt: 'hello' }]
        }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues[0].message).toContain('Tool calling is enabled');
    await app.close();
  });

  it('returns actionable copy when streaming is required but not enabled on the server', async () => {
    const app = createServer();
    seedServerAndModel();
    const template = {
      ...readExample('test_template.valid.json'),
      required_capabilities: { streaming: true }
    };
    const server = getDb()
      .prepare('SELECT capabilities FROM inference_servers WHERE server_id = ?')
      .get('srv-local') as { capabilities: string };
    const capabilities = JSON.parse(server.capabilities) as Record<string, any>;
    capabilities.server.streaming = false;
    getDb()
      .prepare('UPDATE inference_servers SET capabilities = ? WHERE server_id = ?')
      .run(JSON.stringify(capabilities), 'srv-local');

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/instantiations',
      headers: AUTH_HEADERS,
      payload: {
        template,
        server_id: 'srv-local',
        model_id: 'mistral:latest',
        dataset: {
          dataset_id: 'tiny-dataset',
          source: { source_type: 'inline', format: 'json' },
          items: [{ id: 'item-1', prompt: 'hello' }]
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues[0].message).toBe(
      'Streaming is enabled for this run, but the selected server is not marked as streaming-capable. Disable Stream or enable Streaming on the server.'
    );
    await app.close();
  });

  it('supports indexed lookup after stress seeding benchmark snapshots and results', async () => {
    const app = createServer();
    seedServerAndModel();
    const db = getDb();
    const started = performance.now();

    for (let i = 0; i < 1000; i += 1) {
      const id = `stress-inst-${i}`;
      createBenchmarkInstantiation({
        id,
        schema_version: 'benchmark_test_instantiation_v1',
        document_hash: `sha256:${String(i).padStart(64, '0')}`,
        template_id: 'stress-template',
        template_version: '1.0.0',
        server_id: 'srv-local',
        model_id: 'mistral:latest',
        dataset_hash: `sha256:${String(i + 1000).padStart(64, '0')}`,
        document: { kind: 'test_instantiation', schema_version: 'benchmark_test_instantiation_v1', instantiation_id: id }
      });
    }

    for (let i = 0; i < 10000; i += 1) {
      const instantiationId = `stress-inst-${i % 1000}`;
      createBenchmarkResult({
        id: `stress-result-${i}`,
        schema_version: 'benchmark_test_run_result_v1',
        document_hash: `sha256:${String(i + 2000).padStart(64, '0')}`,
        instantiation_id: instantiationId,
        run_id: `stress-result-${i}`,
        status: 'completed',
        document: { kind: 'test_run_result', schema_version: 'benchmark_test_run_result_v1', run_id: `stress-result-${i}`, instantiation_id: instantiationId }
      });
    }

    const lookupStarted = performance.now();
    const instantiation = db
      .prepare('SELECT id FROM benchmark_test_instantiations WHERE document_hash = ?')
      .get(`sha256:${String(500).padStart(64, '0')}`) as { id: string } | undefined;
    const resultCount = db
      .prepare('SELECT COUNT(*) as count FROM benchmark_test_run_results WHERE instantiation_id = ?')
      .get('stress-inst-500') as { count: number };
    const lookupMs = performance.now() - lookupStarted;

    expect(instantiation?.id).toBe('stress-inst-500');
    expect(resultCount.count).toBe(10);
    expect(lookupMs).toBeLessThan(50);
    expect(performance.now() - started).toBeLessThan(10000);
    await app.close();
  });
});
