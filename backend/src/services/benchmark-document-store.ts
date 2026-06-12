import { getDb } from '../models/db.js';
import { nowIso, parseJson } from '../models/repositories.js';
import {
  BenchmarkNotFoundError,
  BenchmarkValidationError,
  validateAnyBenchmarkDocument
} from './benchmark-foundation.js';
import { BenchmarkKind, benchmarkKindFromDocument } from './benchmark-schemas.js';

export type BenchmarkDocumentKind = 'test_template' | 'runtime_profile' | 'dataset_manifest' | 'benchmark_plan';

export interface BenchmarkDocumentRecord {
  id: string;
  kind: BenchmarkDocumentKind;
  schema_version: string;
  document: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface BenchmarkDocumentRow extends Omit<BenchmarkDocumentRecord, 'document' | 'kind'> {
  kind: BenchmarkDocumentKind;
  document: string;
}

const supportedKinds: ReadonlySet<BenchmarkKind> = new Set([
  'test_template',
  'runtime_profile',
  'dataset_manifest',
  'benchmark_plan'
]);

function assertSupportedKind(kind: BenchmarkKind): asserts kind is BenchmarkDocumentKind {
  if (!supportedKinds.has(kind)) {
    throw new BenchmarkValidationError(`Benchmark document kind is not stored in this checkpoint: ${kind}`);
  }
}

function mapRow(row: BenchmarkDocumentRow): BenchmarkDocumentRecord {
  return {
    ...row,
    document: parseJson<Record<string, unknown>>(row.document) ?? {}
  };
}

function naturalDocumentId(kind: BenchmarkDocumentKind, document: Record<string, unknown>): string {
  const fieldByKind: Record<BenchmarkDocumentKind, string> = {
    test_template: 'template_id',
    runtime_profile: 'profile_id',
    dataset_manifest: 'dataset_id',
    benchmark_plan: 'plan_id'
  };
  const field = fieldByKind[kind];
  const value = document[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BenchmarkValidationError(`Benchmark ${kind} document requires ${field} for storage.`);
  }
  return value;
}

function assertValidDocument(kind: BenchmarkDocumentKind, document: Record<string, unknown>): void {
  const validation = validateAnyBenchmarkDocument(document, kind);
  if (!validation.ok) {
    throw new BenchmarkValidationError(`Invalid benchmark ${kind} document`, validation.issues);
  }
}

export function putBenchmarkDocument(document: Record<string, unknown>): BenchmarkDocumentRecord {
  const kind = benchmarkKindFromDocument(document);
  if (!kind) {
    throw new BenchmarkValidationError('Unable to determine benchmark schema kind.', [
      { message: 'Provide a supported benchmark document with kind/schema_version.' }
    ]);
  }
  assertSupportedKind(kind);
  assertValidDocument(kind, document);
  const id = naturalDocumentId(kind, document);
  const schemaVersion = String(document.schema_version);
  const db = getDb();
  const now = nowIso();
  const existing = getBenchmarkDocumentOrNull(kind, id);
  db.prepare(
    `INSERT INTO benchmark_documents (
      id, kind, schema_version, document, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET
      schema_version = excluded.schema_version,
      document = excluded.document,
      updated_at = excluded.updated_at`
  ).run(
    id,
    kind,
    schemaVersion,
    JSON.stringify(document),
    existing?.created_at ?? now,
    now
  );
  return getBenchmarkDocument(kind, id);
}

export function getBenchmarkDocument(kind: BenchmarkDocumentKind, id: string): BenchmarkDocumentRecord {
  const record = getBenchmarkDocumentOrNull(kind, id);
  if (!record) {
    throw new BenchmarkNotFoundError(`Benchmark document not found: ${kind}/${id}`);
  }
  return record;
}

export function getBenchmarkDocumentOrNull(kind: BenchmarkDocumentKind, id: string): BenchmarkDocumentRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM benchmark_documents WHERE kind = ? AND id = ?')
    .get(kind, id) as BenchmarkDocumentRow | undefined;
  return row ? mapRow(row) : null;
}

export function putBenchmarkPlan(document: Record<string, unknown>): BenchmarkDocumentRecord {
  const kind = benchmarkKindFromDocument(document);
  if (kind !== 'benchmark_plan') {
    throw new BenchmarkValidationError('Expected benchmark_plan document.');
  }
  return putBenchmarkDocument(document);
}
