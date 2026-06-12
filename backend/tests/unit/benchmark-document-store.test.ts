import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDbInstance, runSchema } from '../../src/models/db.js';
import { BenchmarkNotFoundError, BenchmarkValidationError } from '../../src/services/benchmark-foundation.js';
import { getBenchmarkDocument, putBenchmarkDocument, putBenchmarkPlan } from '../../src/services/benchmark-document-store.js';
import { buildDatasetManifest } from '../../src/services/benchmark-foundation.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(moduleDir, '../../src/models/schema.sql');

function templateDoc(templateId = 'store-template'): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: templateId,
    template_version: '1.0.0',
    operation: 'chat_completion',
    stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true }],
    metrics: ['elapsed_ms'],
    aggregations: ['mean']
  };
}

function runtimeDoc(profileId = 'store-runtime'): Record<string, unknown> {
  return {
    kind: 'runtime_profile',
    schema_version: 'benchmark_runtime_profile_v1',
    profile_id: profileId,
    runtime_parameters: { temperature: 0, max_tokens: 16 }
  };
}

function datasetDoc(datasetId = 'store-dataset'): Record<string, unknown> {
  return buildDatasetManifest({
    dataset_id: datasetId,
    source: { source_type: 'inline', format: 'json' },
    snapshot_policy: 'embedded',
    items: [{ id: 'item-1', prompt: 'Hello' }]
  });
}

function planDoc(planId = 'store-plan'): Record<string, unknown> {
  return {
    kind: 'benchmark_plan',
    schema_version: 'benchmark_plan_v1',
    plan_id: planId,
    template_ref: 'store-template',
    dataset_ref: 'store-dataset',
    runtime_profile_ref: 'store-runtime',
    model_profile_refs: ['srv:model-a'],
    execution: { mode: 'sequential', continue_on_model_error: true }
  };
}

describe('benchmark document store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-doc-store-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    runSchema(fs.readFileSync(schemaPath, 'utf8'));
  });

  afterEach(() => {
    resetDbInstance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves supported benchmark document kinds', () => {
    const docs = [templateDoc(), runtimeDoc(), datasetDoc(), planDoc()];

    for (const doc of docs) {
      const stored = putBenchmarkDocument(doc);
      const loaded = getBenchmarkDocument(stored.kind, stored.id);
      expect(loaded.document).toEqual(doc);
      expect(loaded.schema_version).toBe(doc.schema_version);
    }
  });

  it('upserts documents by kind and natural id', () => {
    const first = putBenchmarkDocument(runtimeDoc());
    const updated = putBenchmarkDocument({
      ...runtimeDoc(),
      runtime_parameters: { temperature: 0.2, max_tokens: 32 }
    });

    expect(updated.id).toBe(first.id);
    expect(updated.created_at).toBe(first.created_at);
    expect(updated.document.runtime_parameters).toEqual({ temperature: 0.2, max_tokens: 32 });
  });

  it('rejects invalid documents and unsupported benchmark kinds', () => {
    expect(() => putBenchmarkDocument({ ...templateDoc(), metrics: [] })).toThrow(BenchmarkValidationError);
    expect(() => putBenchmarkDocument({
      kind: 'model_profile',
      schema_version: 'benchmark_model_profile_v1',
      profile_id: 'mp'
    })).toThrow('not stored in this checkpoint');
  });

  it('requires natural ids for storage even when the schema allows them to be omitted', () => {
    const runtime = runtimeDoc();
    delete runtime.profile_id;

    expect(() => putBenchmarkDocument(runtime)).toThrow('requires profile_id');
  });

  it('throws not found for absent documents', () => {
    expect(() => getBenchmarkDocument('runtime_profile', 'missing')).toThrow(BenchmarkNotFoundError);
  });

  it('stores only benchmark_plan documents through putBenchmarkPlan', () => {
    expect(putBenchmarkPlan(planDoc()).kind).toBe('benchmark_plan');
    expect(() => putBenchmarkPlan(templateDoc())).toThrow('Expected benchmark_plan');
  });
});
