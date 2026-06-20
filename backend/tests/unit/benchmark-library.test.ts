import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDbInstance, runSchema } from '../../src/models/db.js';
import { getBenchmarkDocumentOrNull } from '../../src/services/benchmark-document-store.js';
import {
  BENCHMARK_LIBRARY_ROOT_ENV,
  deleteBenchmarkDocumentWithLibrary,
  installBenchmarkLibraryDocuments,
  putBenchmarkDocumentWithLibrary
} from '../../src/services/benchmark-library.js';
import { resolveBenchmarkDatasetItems } from '../../src/services/benchmark-datasets.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(moduleDir, '../../src/models/schema.sql');
const contextNeedleSizes = ['4k', '8k', '16k', '32k', '64k', '128k', '256k'] as const;
const contextFunctionRetrievalSizes = contextNeedleSizes;

function templateDoc(templateId = 'user-template'): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: templateId,
    template_version: '1.0.0',
    name: 'User template',
    operation: 'chat_completion',
    stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true }],
    metrics: ['elapsed_ms'],
    aggregations: ['mean']
  };
}

function resetDb(dbPath: string): void {
  resetDbInstance();
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  runSchema(fs.readFileSync(schemaPath, 'utf8'));
}

describe('benchmark library persistence', () => {
  let tmpDir: string;
  let dbPath: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-library-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    previousRoot = process.env[BENCHMARK_LIBRARY_ROOT_ENV];
    process.env.INFERHARNESS_DB_PATH = dbPath;
    process.env[BENCHMARK_LIBRARY_ROOT_ENV] = path.join(tmpDir, 'library');
    resetDb(dbPath);
  });

  afterEach(() => {
    resetDbInstance();
    if (previousRoot === undefined) {
      delete process.env[BENCHMARK_LIBRARY_ROOT_ENV];
    } else {
      process.env[BENCHMARK_LIBRARY_ROOT_ENV] = previousRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs built-in benchmark documents into an empty database', () => {
    const report = installBenchmarkLibraryDocuments();

    expect(report.invalid).toHaveLength(0);
    expect(getBenchmarkDocumentOrNull('test_template', 'agent-codex-apply-patch-v1')?.document.name)
      .toBe('Agent - Codex apply_patch');
    expect(getBenchmarkDocumentOrNull('dataset_manifest', 'dataset-agent-codex-apply-patch-v1')?.document.item_count)
      .toBe(2);
    expect(getBenchmarkDocumentOrNull('test_template', 'model-context-python-snippet-retrieval-v1')).toBeNull();
    expect(getBenchmarkDocumentOrNull('dataset_manifest', 'dataset-model-context-python-snippet-retrieval-v1')).toBeNull();
    for (const size of contextNeedleSizes) {
      const templateId = `model-context-needle-${size}-v1`;
      const datasetId = `dataset-model-context-needle-${size}-v1`;
      expect(getBenchmarkDocumentOrNull('test_template', templateId)?.document.name)
        .toBe(`Model - Context needle ${size}`);
      expect(getBenchmarkDocumentOrNull('dataset_manifest', datasetId)?.document).toMatchObject({
        item_count: 5,
        metadata: { template_id: templateId }
      });
    }
    for (const size of contextFunctionRetrievalSizes) {
      const templateId = `model-context-function-retrieval-${size}-v1`;
      const datasetId = `dataset-model-context-function-retrieval-${size}-v1`;
      expect(getBenchmarkDocumentOrNull('test_template', templateId)?.document.name)
        .toBe(`Model - Context function retrieval ${size}`);
      expect(getBenchmarkDocumentOrNull('dataset_manifest', datasetId)?.document).toMatchObject({
        item_count: 5,
        metadata: { template_id: templateId }
      });
    }
  });

  it('loads every built-in Python context needle dataset from its file-backed manifest', () => {
    installBenchmarkLibraryDocuments();
    for (const size of contextNeedleSizes) {
      const dataset = getBenchmarkDocumentOrNull('dataset_manifest', `dataset-model-context-needle-${size}-v1`)?.document;
      expect(dataset).toBeTruthy();
      const items = resolveBenchmarkDatasetItems({ dataset });
      expect(items).toHaveLength(5);
      expect(items.map((item) => item.id)).toEqual([
        `needle-front-${size}`,
        `needle-middle-${size}`,
        `needle-late-${size}`,
        `needle-two-facts-${size}`,
        `negative-control-${size}`
      ]);
      expect(items[0]).toMatchObject({
        expected_format: 'free_text',
        metadata: { needle_position: 'front', needle_count: 1 }
      });
      expect(items[3]).toMatchObject({
        metadata: { needle_count: 2 }
      });
      expect(items[4]).toMatchObject({
        expected_answer: 'NOT_FOUND',
        metadata: { needle_count: 0, needle_position: 'absent' }
      });
    }
  });

  it('loads every built-in Python context function retrieval dataset from its file-backed manifest', () => {
    installBenchmarkLibraryDocuments();
    for (const size of contextFunctionRetrievalSizes) {
      const dataset = getBenchmarkDocumentOrNull('dataset_manifest', `dataset-model-context-function-retrieval-${size}-v1`)?.document;
      expect(dataset).toBeTruthy();
      const items = resolveBenchmarkDatasetItems({ dataset });
      expect(items).toHaveLength(5);
      expect(items.map((item) => item.id)).toEqual([
        `function-front-${size}`,
        `function-middle-${size}`,
        `function-late-${size}`,
        `function-two-blocks-${size}`,
        `function-negative-control-${size}`
      ]);
      expect(items[0]).toMatchObject({
        expected_format: 'code',
        metadata: { function_name: '_constructor_from_mgr', function_position: 'front' }
      });
      expect(items[3]).toMatchObject({
        expected_format: 'code',
        metadata: { function_names: ['_construct_result', '_to_dict_of_blocks'] }
      });
      expect(items[4]).toMatchObject({
        expected_answer: 'NOT_FOUND',
        metadata: { function_position: 'absent' }
      });
    }
  });

  it('rebuilds user-created documents from the user library after the database is erased', () => {
    putBenchmarkDocumentWithLibrary(templateDoc());
    expect(getBenchmarkDocumentOrNull('test_template', 'user-template')).not.toBeNull();

    resetDb(dbPath);
    expect(getBenchmarkDocumentOrNull('test_template', 'user-template')).toBeNull();

    installBenchmarkLibraryDocuments();
    expect(getBenchmarkDocumentOrNull('test_template', 'user-template')?.document.name).toBe('User template');
  });

  it('lets user library documents override built-in documents with the same id', () => {
    putBenchmarkDocumentWithLibrary({
      ...templateDoc('agent-codex-apply-patch-v1'),
      name: 'Custom Codex patch benchmark'
    });

    resetDb(dbPath);
    installBenchmarkLibraryDocuments();

    expect(getBenchmarkDocumentOrNull('test_template', 'agent-codex-apply-patch-v1')?.document.name)
      .toBe('Custom Codex patch benchmark');
  });

  it('keeps a deleted built-in document hidden after restart via tombstone', () => {
    installBenchmarkLibraryDocuments();
    expect(getBenchmarkDocumentOrNull('test_template', 'agent-codex-apply-patch-v1')).not.toBeNull();

    expect(deleteBenchmarkDocumentWithLibrary('test_template', 'agent-codex-apply-patch-v1')).toBe(true);
    expect(getBenchmarkDocumentOrNull('test_template', 'agent-codex-apply-patch-v1')).toBeNull();

    resetDb(dbPath);
    installBenchmarkLibraryDocuments();
    expect(getBenchmarkDocumentOrNull('test_template', 'agent-codex-apply-patch-v1')).toBeNull();
  });

  it('reports invalid user library JSON without installing it', () => {
    const invalidDir = path.join(process.env[BENCHMARK_LIBRARY_ROOT_ENV] as string, 'test_template');
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(path.join(invalidDir, 'invalid.json'), '{ nope', 'utf8');

    const report = installBenchmarkLibraryDocuments();

    expect(report.invalid.some((entry) => entry.path.endsWith('invalid.json'))).toBe(true);
    expect(getBenchmarkDocumentOrNull('test_template', 'invalid')).toBeNull();
  });
});
