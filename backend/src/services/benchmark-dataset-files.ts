import fs from 'fs';
import path from 'path';

import {
  BENCHMARK_DATASET_ROOT_ENV,
  DatasetItem,
  normalizeBenchmarkDatasetItems,
  parseJsonlDataset,
  prepareBenchmarkDatasetManifest
} from './benchmark-datasets.js';
import { BenchmarkValidationError } from './benchmark-foundation.js';
import {
  BenchmarkDocumentRecord,
  deleteBenchmarkDocument,
  listBenchmarkDocuments
} from './benchmark-document-store.js';
import { deleteBenchmarkDocumentWithLibrary, putBenchmarkDocumentWithLibrary } from './benchmark-library.js';

export interface BenchmarkDatasetFileRecord {
  path: string;
  format: 'jsonl';
  dataset_id: string;
  item_count: number | null;
  updated_at: string | null;
  error?: string;
}

export interface BenchmarkDatasetFileDocument extends BenchmarkDatasetFileRecord {
  item_count: number;
  dataset_hash: string;
  manifest: Record<string, unknown>;
  items: DatasetItem[];
}

export interface SaveBenchmarkDatasetFileInput {
  path: string;
  dataset_id: string;
  items: DatasetItem[];
  metadata?: Record<string, unknown>;
}

function configuredDatasetRoot(): string {
  const configured = process.env[BENCHMARK_DATASET_ROOT_ENV]?.trim();
  if (!configured) {
    throw new BenchmarkValidationError(`${BENCHMARK_DATASET_ROOT_ENV} must be configured before editing dataset files.`);
  }
  if (!path.isAbsolute(configured)) {
    throw new BenchmarkValidationError(`${BENCHMARK_DATASET_ROOT_ENV} must be an absolute path.`);
  }
  return path.resolve(configured);
}

function normalizeDatasetPath(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new BenchmarkValidationError('Benchmark dataset file path is required.');
  }
  if (value.includes('\0')) {
    throw new BenchmarkValidationError('Benchmark dataset file path contains an invalid character.');
  }
  if (path.isAbsolute(value)) {
    throw new BenchmarkValidationError('Benchmark dataset file path must be relative to the dataset root.');
  }
  const normalized = path.normalize(value);
  if (normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new BenchmarkValidationError('Benchmark dataset file path escapes the dataset root.');
  }
  if (path.extname(normalized) !== '.jsonl') {
    throw new BenchmarkValidationError('Benchmark dataset editor supports only .jsonl files in this checkpoint.');
  }
  return normalized.split(path.sep).join('/');
}

function resolveDatasetFilePath(relativePath: string): { root: string; relativePath: string; filePath: string } {
  const root = configuredDatasetRoot();
  const normalized = normalizeDatasetPath(relativePath);
  const filePath = path.resolve(root, normalized);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new BenchmarkValidationError('Benchmark dataset file path escapes the dataset root.');
  }
  return { root, relativePath: normalized, filePath };
}

function datasetIdFromPath(relativePath: string): string {
  return path.basename(relativePath, '.jsonl')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'dataset';
}

function matchingDatasetManifest(relativePath: string): BenchmarkDocumentRecord | null {
  const documents = listDatasetManifestDocuments();
  return documents.find((record) => {
    const source = record.document.source;
    return Boolean(
      source
      && typeof source === 'object'
      && !Array.isArray(source)
      && (source as Record<string, unknown>).source_type === 'file'
      && (source as Record<string, unknown>).format === 'jsonl'
      && (source as Record<string, unknown>).path === relativePath
    );
  }) ?? null;
}

function listDatasetManifestDocuments(): BenchmarkDocumentRecord[] {
  return listBenchmarkDocuments('dataset_manifest');
}

function assertUniqueItemIds(items: DatasetItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = String(item.id);
    if (seen.has(id)) {
      throw new BenchmarkValidationError(`Benchmark dataset item id must be unique: ${id}`);
    }
    seen.add(id);
  }
}

function readJsonlItems(filePath: string): DatasetItem[] {
  const items = normalizeBenchmarkDatasetItems(parseJsonlDataset(fs.readFileSync(filePath, 'utf8')));
  assertUniqueItemIds(items);
  return items;
}

function writeJsonlItems(filePath: string, items: DatasetItem[]): void {
  const normalized = normalizeBenchmarkDatasetItems(items);
  assertUniqueItemIds(normalized);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${normalized.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

function readMtime(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

export function listBenchmarkDatasetFiles(): BenchmarkDatasetFileRecord[] {
  const root = configuredDatasetRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: BenchmarkDatasetFileRecord[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.jsonl') {
        continue;
      }
      const relativePath = path.relative(root, entryPath).split(path.sep).join('/');
      const manifest = matchingDatasetManifest(relativePath);
      try {
        files.push({
          path: relativePath,
          format: 'jsonl',
          dataset_id: manifest?.id ?? datasetIdFromPath(relativePath),
          item_count: readJsonlItems(entryPath).length,
          updated_at: readMtime(entryPath)
        });
      } catch (error) {
        files.push({
          path: relativePath,
          format: 'jsonl',
          dataset_id: manifest?.id ?? datasetIdFromPath(relativePath),
          item_count: null,
          updated_at: readMtime(entryPath),
          error: error instanceof Error ? error.message : 'Unable to read dataset file'
        });
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function readBenchmarkDatasetFile(relativePathInput: string): BenchmarkDatasetFileDocument {
  const { relativePath, filePath } = resolveDatasetFilePath(relativePathInput);
  if (!fs.existsSync(filePath)) {
    throw new BenchmarkValidationError(`Benchmark dataset file not found: ${relativePath}`);
  }
  const existingManifest = matchingDatasetManifest(relativePath);
  const datasetId = existingManifest?.id ?? datasetIdFromPath(relativePath);
  const items = readJsonlItems(filePath);
  const manifest = prepareBenchmarkDatasetManifest({
    dataset_id: datasetId,
    source: { source_type: 'file', format: 'jsonl', path: relativePath },
    metadata: existingManifest?.document.metadata as Record<string, unknown> | undefined
  });
  return {
    path: relativePath,
    format: 'jsonl',
    dataset_id: datasetId,
    item_count: items.length,
    dataset_hash: String(manifest.dataset_hash),
    updated_at: readMtime(filePath),
    manifest,
    items
  };
}

export function saveBenchmarkDatasetFile(input: SaveBenchmarkDatasetFileInput): BenchmarkDatasetFileDocument {
  const datasetId = input.dataset_id.trim();
  if (!datasetId) {
    throw new BenchmarkValidationError('Benchmark dataset file requires dataset_id.');
  }
  const { relativePath, filePath } = resolveDatasetFilePath(input.path);
  const existingManifest = matchingDatasetManifest(relativePath);
  writeJsonlItems(filePath, input.items);
  const manifest = prepareBenchmarkDatasetManifest({
    dataset_id: datasetId,
    source: { source_type: 'file', format: 'jsonl', path: relativePath },
    metadata: {
      source: 'datasets-page',
      ...(input.metadata ?? {})
    }
  });
  if (existingManifest && existingManifest.id !== datasetId) {
    deleteBenchmarkDocumentWithLibrary('dataset_manifest', existingManifest.id);
  }
  putBenchmarkDocumentWithLibrary(manifest);
  const items = readJsonlItems(filePath);
  return {
    path: relativePath,
    format: 'jsonl',
    dataset_id: datasetId,
    item_count: items.length,
    dataset_hash: String(manifest.dataset_hash),
    updated_at: readMtime(filePath),
    manifest,
    items
  };
}

export function deleteBenchmarkDatasetFile(relativePathInput: string): boolean {
  const { relativePath, filePath } = resolveDatasetFilePath(relativePathInput);
  const manifest = matchingDatasetManifest(relativePath);
  const existed = fs.existsSync(filePath);
  if (existed) {
    fs.rmSync(filePath, { force: true });
  }
  if (manifest) {
    deleteBenchmarkDocumentWithLibrary('dataset_manifest', manifest.id);
  } else {
    deleteBenchmarkDocument('dataset_manifest', datasetIdFromPath(relativePath));
  }
  return existed || Boolean(manifest);
}
