import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInferenceServer } from '../../src/models/inference-server.js';
import { createModel } from '../../src/models/model.js';
import { resetDbInstance, runSchema } from '../../src/models/db.js';
import { buildDatasetManifest, BenchmarkValidationError } from '../../src/services/benchmark-foundation.js';
import { putBenchmarkDocument } from '../../src/services/benchmark-document-store.js';
import { resolveBenchmarkPlan } from '../../src/services/benchmark-plan-registry.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(moduleDir, '../../src/models/schema.sql');

function templateDoc(): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: 'registry-template',
    template_version: '1.0.0',
    operation: 'chat_completion',
    stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true }],
    metrics: ['elapsed_ms'],
    aggregations: ['mean']
  };
}

function runtimeDoc(): Record<string, unknown> {
  return {
    kind: 'runtime_profile',
    schema_version: 'benchmark_runtime_profile_v1',
    profile_id: 'registry-runtime',
    runtime_parameters: { max_tokens: 16, stream: false }
  };
}

function datasetDoc(): Record<string, unknown> {
  return buildDatasetManifest({
    dataset_id: 'registry-dataset',
    source: { source_type: 'inline', format: 'json' },
    snapshot_policy: 'embedded',
    items: [{ id: 'item-1', prompt: 'Hello' }]
  });
}

function planDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'benchmark_plan',
    schema_version: 'benchmark_plan_v1',
    plan_id: 'registry-plan',
    template_ref: 'registry-template',
    dataset_ref: 'registry-dataset',
    runtime_profile_ref: 'registry-runtime',
    model_profile_refs: ['srv-registry:model-a', 'srv-registry:model-b'],
    execution: { mode: 'sequential', continue_on_model_error: true },
    ...overrides
  };
}

function seedServerAndModel(modelId: string): void {
  if (modelId === 'model-a') {
    createInferenceServer({
      inference_server: {
        server_id: 'srv-registry',
        display_name: 'Registry Server',
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
  }

  createModel({
    model_schema_version: '1.2.0',
    model: {
      server_id: 'srv-registry',
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

describe('benchmark plan registry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-plan-registry-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    runSchema(fs.readFileSync(schemaPath, 'utf8'));
    putBenchmarkDocument(templateDoc());
    putBenchmarkDocument(runtimeDoc());
    putBenchmarkDocument(datasetDoc());
    seedServerAndModel('model-a');
    seedServerAndModel('model-b');
  });

  afterEach(() => {
    resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves benchmark_plan refs to the inline runner input shape', () => {
    const resolved = resolveBenchmarkPlan(planDoc());

    expect(resolved.plan_id).toBe('registry-plan');
    expect(resolved.template.template_id).toBe('registry-template');
    expect(resolved.dataset.dataset_id).toBe('registry-dataset');
    expect(resolved.runtime_profile.profile_id).toBe('registry-runtime');
    expect(resolved.targets).toEqual([
      { server_id: 'srv-registry', model_id: 'model-a' },
      { server_id: 'srv-registry', model_id: 'model-b' }
    ]);
    expect(resolved.continue_on_model_error).toBe(true);
  });

  it('rejects missing document refs with validation errors naming the ref', () => {
    expect(() => resolveBenchmarkPlan(planDoc({ template_ref: 'missing-template' })))
      .toThrow('test_template ref not found: missing-template');
    expect(() => resolveBenchmarkPlan(planDoc({ dataset_ref: 'missing-dataset' })))
      .toThrow('dataset_manifest ref not found: missing-dataset');
    expect(() => resolveBenchmarkPlan(planDoc({ runtime_profile_ref: 'missing-runtime' })))
      .toThrow('runtime_profile ref not found: missing-runtime');
  });

  it('rejects malformed and missing model refs', () => {
    expect(() => resolveBenchmarkPlan(planDoc({ model_profile_refs: ['not-a-ref'] })))
      .toThrow('Expected server_id:model_id');
    expect(() => resolveBenchmarkPlan(planDoc({ model_profile_refs: ['srv-registry:missing'] })))
      .toThrow('model_profile_ref not found: srv-registry:missing');
  });

  it('rejects parallel execution as deferred checkpoint work', () => {
    expect(() => resolveBenchmarkPlan(planDoc({ execution: { mode: 'parallel', continue_on_model_error: true } })))
      .toThrow(BenchmarkValidationError);
  });
});
