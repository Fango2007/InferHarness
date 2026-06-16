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

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(moduleDir, '../../src/models/schema.sql');

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
