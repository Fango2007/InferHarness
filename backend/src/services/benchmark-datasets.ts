import fs from 'fs';
import path from 'path';

import { BenchmarkValidationError, buildDatasetManifest } from './benchmark-foundation.js';
import { sha256Document } from './benchmark-schemas.js';

export const BENCHMARK_DATASET_ROOT_ENV = 'INFERHARNESS_BENCHMARK_DATASET_ROOT';

type DatasetItem = Record<string, unknown>;

export interface PrepareDatasetManifestInput {
  dataset_id: string;
  source: {
    source_type: 'file';
    format: 'json' | 'jsonl' | 'csv';
    path: string;
  };
  metadata?: Record<string, unknown>;
}

const optionalItemFields: Record<string, (value: unknown) => boolean> = {
  system_prompt: (value) => value === null || typeof value === 'string',
  interaction_mode: (value) => ['chat', 'tool_calling', 'structured_output', 'multi_turn', 'agentic'].includes(String(value)),
  tools: Array.isArray,
  tool_choice: (value) => value === null || typeof value === 'string' || (typeof value === 'object' && !Array.isArray(value)),
  expected_tool_calls: Array.isArray,
  expected_answer: () => true,
  expected_format: (value) => ['free_text', 'json', 'markdown', 'code', 'boolean', 'number', 'schema', 'regex'].includes(String(value)),
  expected_schema: (value) => value === null || (typeof value === 'object' && !Array.isArray(value)),
  evaluation: (value) => value === null || (typeof value === 'object' && !Array.isArray(value)),
  tags: (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
  metadata: (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
};

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = (value as Record<string, unknown>)[key];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
}

function textAt(value: Record<string, unknown> | null, key: string): string | null {
  const entry = value?.[key];
  return typeof entry === 'string' && entry.trim().length > 0 ? entry : null;
}

function assertInsideRoot(filePath: string, roots: string[]): void {
  const resolved = path.resolve(filePath);
  const allowed = roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
  if (!allowed) {
    throw new BenchmarkValidationError(`Benchmark dataset path is outside allowed roots: ${filePath}`);
  }
}

function allowedDatasetRoots(): string[] {
  const roots = [process.cwd()];
  const configured = process.env[BENCHMARK_DATASET_ROOT_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new BenchmarkValidationError(`${BENCHMARK_DATASET_ROOT_ENV} must be an absolute path.`);
    }
    roots.push(configured);
  }
  return roots;
}

export function resolveDatasetFilePath(sourcePath: string): string {
  const roots = allowedDatasetRoots();
  const candidates = path.isAbsolute(sourcePath)
    ? [sourcePath]
    : roots.map((root) => path.resolve(root, sourcePath));
  for (const candidate of candidates) {
    assertInsideRoot(candidate, roots);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new BenchmarkValidationError(`Benchmark dataset file not found: ${sourcePath}`);
}

function parseJsonDataset(raw: string): DatasetItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BenchmarkValidationError(`Invalid benchmark JSON dataset: ${(error as Error).message}`);
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).items
      : null;
  if (!Array.isArray(items)) {
    throw new BenchmarkValidationError('JSON benchmark datasets must be an array or an object with an items array.');
  }
  return items as DatasetItem[];
}

function parseJsonlDataset(raw: string): DatasetItem[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as DatasetItem;
      } catch (error) {
        throw new BenchmarkValidationError(`Invalid benchmark JSONL line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (quoted) {
    throw new BenchmarkValidationError('Invalid benchmark CSV dataset: unterminated quoted field.');
  }
  return cells;
}

function parseCsvDataset(raw: string): DatasetItem[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  if (!headers.includes('prompt')) {
    throw new BenchmarkValidationError('CSV benchmark datasets require a prompt column.');
  }
  if (!headers.includes('id')) {
    throw new BenchmarkValidationError('CSV benchmark datasets require an id column.');
  }
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function normalizeItems(items: DatasetItem[]): DatasetItem[] {
  if (items.length === 0) {
    throw new BenchmarkValidationError('Benchmark dataset must contain at least one item.');
  }
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BenchmarkValidationError(`Benchmark dataset item ${index} must be an object.`);
    }
    const id = item.id;
    const prompt = item.prompt;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new BenchmarkValidationError(`Benchmark dataset item ${index} requires a non-empty string id.`);
    }
    if (typeof prompt !== 'string') {
      throw new BenchmarkValidationError(`Benchmark dataset item ${index} requires a prompt string.`);
    }
    for (const [key, value] of Object.entries(item)) {
      if (key === 'id' || key === 'prompt') {
        continue;
      }
      const validator = optionalItemFields[key];
      if (!validator || !validator(value)) {
        throw new BenchmarkValidationError(`Benchmark dataset item ${index} has invalid field: ${key}`);
      }
    }
    return item;
  });
}

export function readBenchmarkDatasetFile(source: Record<string, unknown>): DatasetItem[] {
  const sourceType = textAt(source, 'source_type');
  const format = textAt(source, 'format');
  const sourcePath = textAt(source, 'path');
  if (sourceType !== 'file') {
    throw new BenchmarkValidationError(`Benchmark manifest_only execution supports only file sources; received ${String(sourceType ?? 'unknown')}.`);
  }
  if (!sourcePath) {
    throw new BenchmarkValidationError('Benchmark manifest_only file datasets require source.path.');
  }
  const resolvedPath = resolveDatasetFilePath(sourcePath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  if (format === 'json') {
    return normalizeItems(parseJsonDataset(raw));
  }
  if (format === 'jsonl') {
    return normalizeItems(parseJsonlDataset(raw));
  }
  if (format === 'csv') {
    return normalizeItems(parseCsvDataset(raw));
  }
  throw new BenchmarkValidationError(`Unsupported benchmark dataset file format: ${String(format ?? 'unknown')}.`);
}

export function prepareBenchmarkDatasetManifest(input: PrepareDatasetManifestInput): Record<string, unknown> {
  const datasetId = input.dataset_id.trim();
  if (!datasetId) {
    throw new BenchmarkValidationError('Benchmark dataset manifest requires dataset_id.');
  }
  const source = {
    source_type: input.source.source_type,
    format: input.source.format,
    path: input.source.path.trim()
  };
  const items = readBenchmarkDatasetFile(source);
  return buildDatasetManifest({
    dataset_id: datasetId,
    source,
    snapshot_policy: 'manifest_only',
    item_count: items.length,
    items,
    metadata: input.metadata
  });
}

function verifyDatasetIntegrity(dataset: Record<string, unknown>, items: DatasetItem[]): void {
  const expectedCount = dataset.item_count;
  if (typeof expectedCount !== 'number' || expectedCount !== items.length) {
    throw new BenchmarkValidationError(`Benchmark dataset item_count mismatch: expected ${String(expectedCount)}, loaded ${items.length}.`);
  }
  const expectedHash = dataset.dataset_hash;
  const source = objectAt(dataset, 'source');
  const actualHash = sha256Document({
    source,
    canonicalization_version: dataset.canonicalization_version,
    item_count: items.length,
    items
  });
  if (expectedHash !== actualHash) {
    throw new BenchmarkValidationError('Benchmark dataset_hash mismatch; refusing to execute.');
  }
  const itemHashes = dataset.item_hashes;
  if (Array.isArray(itemHashes)) {
    const byId = new Map(items.map((item) => [String(item.id), item]));
    for (const entry of itemHashes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new BenchmarkValidationError('Benchmark item_hashes entries must be objects.');
      }
      const record = entry as Record<string, unknown>;
      const itemId = textAt(record, 'item_id');
      const hash = textAt(record, 'hash');
      const item = itemId ? byId.get(itemId) : null;
      if (!item || !hash || sha256Document(item) !== hash) {
        throw new BenchmarkValidationError(`Benchmark item hash mismatch for item: ${String(itemId ?? 'unknown')}.`);
      }
    }
  }
}

export function resolveBenchmarkDatasetItems(instantiation: Record<string, unknown>): DatasetItem[] {
  const dataset = objectAt(instantiation, 'dataset');
  const policy = dataset?.snapshot_policy;
  if (!dataset) {
    throw new BenchmarkValidationError('Benchmark instantiation requires a dataset manifest.');
  }
  if (policy === 'embedded') {
    const items = dataset.items;
    if (!Array.isArray(items)) {
      throw new BenchmarkValidationError('Embedded benchmark datasets require an items array.');
    }
    return normalizeItems(items as DatasetItem[]);
  }
  if (policy === 'manifest_only') {
    const items = readBenchmarkDatasetFile(objectAt(dataset, 'source') ?? {});
    verifyDatasetIntegrity(dataset, items);
    return items;
  }
  if (policy === 'compressed_blob') {
    throw new BenchmarkValidationError('compressed_blob benchmark datasets are not executable in this checkpoint.');
  }
  throw new BenchmarkValidationError(`Unsupported benchmark dataset snapshot_policy: ${String(policy ?? 'unknown')}.`);
}
