import { getDb } from './db.js';
import { nowIso, parseJson } from './repositories.js';

export interface BenchmarkInstantiationRecord {
  id: string;
  schema_version: string;
  document_hash: string;
  template_id: string;
  template_version: string;
  server_id: string;
  model_id: string;
  dataset_hash: string;
  status: string;
  document: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkResultRecord {
  id: string;
  schema_version: string;
  document_hash: string;
  instantiation_id: string;
  run_id: string;
  status: string;
  document: Record<string, unknown>;
  created_at: string;
}

interface InstantiationRow extends Omit<BenchmarkInstantiationRecord, 'document'> {
  document: string;
}

interface ResultRow extends Omit<BenchmarkResultRecord, 'document'> {
  document: string;
}

function mapInstantiation(row: InstantiationRow): BenchmarkInstantiationRecord {
  return {
    ...row,
    document: parseJson<Record<string, unknown>>(row.document) ?? {}
  };
}

function mapResult(row: ResultRow): BenchmarkResultRecord {
  return {
    ...row,
    document: parseJson<Record<string, unknown>>(row.document) ?? {}
  };
}

export function createBenchmarkInstantiation(input: {
  id: string;
  schema_version: string;
  document_hash: string;
  template_id: string;
  template_version: string;
  server_id: string;
  model_id: string;
  dataset_hash: string;
  document: Record<string, unknown>;
}): BenchmarkInstantiationRecord {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO benchmark_test_instantiations (
      id, schema_version, document_hash, template_id, template_version, server_id,
      model_id, dataset_hash, status, document, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.schema_version,
    input.document_hash,
    input.template_id,
    input.template_version,
    input.server_id,
    input.model_id,
    input.dataset_hash,
    'created',
    JSON.stringify(input.document),
    now,
    now
  );
  const record = getBenchmarkInstantiation(input.id);
  if (!record) {
    throw new Error(`Benchmark instantiation was not persisted: ${input.id}`);
  }
  return record;
}

export function getBenchmarkInstantiation(id: string): BenchmarkInstantiationRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM benchmark_test_instantiations WHERE id = ?')
    .get(id) as InstantiationRow | undefined;
  return row ? mapInstantiation(row) : null;
}

export function createBenchmarkResult(input: {
  id: string;
  schema_version: string;
  document_hash: string;
  instantiation_id: string;
  run_id: string;
  status: string;
  document: Record<string, unknown>;
}): BenchmarkResultRecord {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO benchmark_test_run_results (
      id, schema_version, document_hash, instantiation_id, run_id, status,
      document, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.schema_version,
    input.document_hash,
    input.instantiation_id,
    input.run_id,
    input.status,
    JSON.stringify(input.document),
    now
  );
  const record = getBenchmarkResult(input.id);
  if (!record) {
    throw new Error(`Benchmark result was not persisted: ${input.id}`);
  }
  return record;
}

export function getBenchmarkResult(id: string): BenchmarkResultRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM benchmark_test_run_results WHERE id = ?')
    .get(id) as ResultRow | undefined;
  return row ? mapResult(row) : null;
}

