import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import {
  BenchmarkKind,
  benchmarkKindFromDocument,
  benchmarkSchemaPath,
  validateBenchmarkDocument
} from '../../src/services/benchmark-schemas.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(moduleDir, '../../../specs/011-new-python-test-schema-and-logic/examples');

const validExamples: Array<{ file: string; kind: BenchmarkKind }> = [
  { file: 'model_profile.minimal.valid.json', kind: 'model_profile' },
  { file: 'model_snapshot.complete.valid.json', kind: 'model_snapshot' },
  { file: 'runtime_profile.minimal.valid.json', kind: 'runtime_profile' },
  { file: 'dataset_manifest.manifest_only.valid.json', kind: 'dataset_manifest' },
  { file: 'dataset_manifest.embedded.valid.json', kind: 'dataset_manifest' },
  { file: 'dataset_manifest.compressed_blob.valid.json', kind: 'dataset_manifest' },
  { file: 'test_template.valid.json', kind: 'test_template' },
  { file: 'test_instantiation.complete.valid.json', kind: 'test_instantiation' },
  { file: 'test_run_result.completed.valid.json', kind: 'test_run_result' },
  { file: 'test_run_result.partial.valid.json', kind: 'test_run_result' },
  { file: 'benchmark_plan.valid.json', kind: 'benchmark_plan' }
];

const invalidExamples: Array<{ file: string; kind: BenchmarkKind }> = [
  { file: 'invalid/dataset_manifest.missing_hash.json', kind: 'dataset_manifest' },
  { file: 'invalid/test_template.invalid_required_capability.json', kind: 'test_template' },
  { file: 'invalid/test_instantiation.missing_dataset_manifest.json', kind: 'test_instantiation' },
  { file: 'invalid/model_snapshot.missing_quality.json', kind: 'model_snapshot' }
];

function readExample(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8')) as Record<string, unknown>;
}

describe('benchmark schema pack', () => {
  it.each(validExamples)('accepts $file', ({ file, kind }) => {
    expect(fs.existsSync(benchmarkSchemaPath(kind))).toBe(true);
    const result = validateBenchmarkDocument(kind, readExample(file));
    expect(result.ok).toBe(true);
  });

  it.each(invalidExamples)('rejects $file', ({ file, kind }) => {
    const result = validateBenchmarkDocument(kind, readExample(file));
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each(validExamples)('infers $kind from schema_version when kind is absent in $file', ({ file, kind }) => {
    const document = readExample(file);
    delete document.kind;
    expect(benchmarkKindFromDocument(document)).toBe(kind);
  });
});
