import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { SchemaValidationIssue, validateWithSchema } from './schema-validator.js';

export type BenchmarkKind =
  | 'model_profile'
  | 'model_snapshot'
  | 'runtime_profile'
  | 'dataset_manifest'
  | 'test_template'
  | 'test_instantiation'
  | 'test_run_result'
  | 'benchmark_plan';

export interface BenchmarkValidationResult {
  ok: boolean;
  issues: SchemaValidationIssue[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(moduleDir, '../schemas/benchmark');

const schemaFiles: Record<BenchmarkKind, string> = {
  model_profile: 'model_profile.schema.json',
  model_snapshot: 'model_snapshot.schema.json',
  runtime_profile: 'runtime_profile.schema.json',
  dataset_manifest: 'dataset_manifest.schema.json',
  test_template: 'test_template.schema.json',
  test_instantiation: 'test_instantiation.schema.json',
  test_run_result: 'test_run_result.schema.json',
  benchmark_plan: 'benchmark_plan.schema.json'
};

const schemaVersions: Record<string, BenchmarkKind> = {
  benchmark_model_profile_v1: 'model_profile',
  benchmark_model_snapshot_v1: 'model_snapshot',
  benchmark_runtime_profile_v1: 'runtime_profile',
  benchmark_dataset_manifest_v1: 'dataset_manifest',
  benchmark_test_template_v1: 'test_template',
  benchmark_test_instantiation_v1: 'test_instantiation',
  benchmark_test_run_result_v1: 'test_run_result',
  benchmark_plan_v1: 'benchmark_plan'
};

export function benchmarkSchemaPath(kind: BenchmarkKind): string {
  return path.join(schemaDir, schemaFiles[kind]);
}

export function benchmarkSchemaKinds(): BenchmarkKind[] {
  return Object.keys(schemaFiles) as BenchmarkKind[];
}

export function benchmarkKindFromDocument(document: unknown): BenchmarkKind | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return null;
  }
  const kind = (document as Record<string, unknown>).kind;
  if (typeof kind === 'string' && kind in schemaFiles) {
    return kind as BenchmarkKind;
  }
  const schemaVersion = (document as Record<string, unknown>).schema_version;
  return typeof schemaVersion === 'string' ? schemaVersions[schemaVersion] ?? null : null;
}

export function validateBenchmarkDocument(
  kind: BenchmarkKind,
  document: unknown
): BenchmarkValidationResult {
  const result = validateWithSchema(benchmarkSchemaPath(kind), document);
  if (result.ok) {
    return { ok: true, issues: [] };
  }
  return { ok: false, issues: result.issues };
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortForCanonicalJson(entry)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function sha256Document(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
