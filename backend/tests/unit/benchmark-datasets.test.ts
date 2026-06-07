import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BENCHMARK_DATASET_ROOT_ENV,
  prepareBenchmarkDatasetManifest,
  resolveBenchmarkDatasetItems
} from '../../src/services/benchmark-datasets.js';
import { sha256Document } from '../../src/services/benchmark-schemas.js';

const source = { source_type: 'file', format: 'jsonl', path: 'dataset.jsonl' };
const items = [
  { id: 'item-1', prompt: 'First prompt' },
  { id: 'item-2', prompt: 'Second prompt', tags: ['smoke'] }
];

function manifest(sourceOverride: Record<string, unknown>, itemOverride = items): Record<string, unknown> {
  return {
    kind: 'test_instantiation',
    schema_version: 'benchmark_test_instantiation_v1',
    dataset: {
      kind: 'dataset_manifest',
      schema_version: 'benchmark_dataset_manifest_v1',
      dataset_id: 'unit-dataset',
      source: sourceOverride,
      canonicalization_version: 'dataset_canonical_v1',
      snapshot_policy: 'manifest_only',
      dataset_hash: sha256Document({
        source: sourceOverride,
        canonicalization_version: 'dataset_canonical_v1',
        item_count: itemOverride.length,
        items: itemOverride
      }),
      item_count: itemOverride.length,
      item_hashes: itemOverride.map((item) => ({ item_id: item.id, hash: sha256Document(item) })),
      item_manifest_ref: null,
      snapshot_blob_ref: null
    }
  };
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('benchmark dataset resolver', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-datasets-'));
    previousRoot = process.env[BENCHMARK_DATASET_ROOT_ENV];
    process.env[BENCHMARK_DATASET_ROOT_ENV] = tmpDir;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env[BENCHMARK_DATASET_ROOT_ENV];
    } else {
      process.env[BENCHMARK_DATASET_ROOT_ENV] = previousRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads manifest_only JSONL datasets and verifies item hashes', () => {
    write(path.join(tmpDir, 'dataset.jsonl'), `${JSON.stringify(items[0])}\n\n${JSON.stringify(items[1])}\n`);
    expect(resolveBenchmarkDatasetItems(manifest(source))).toEqual(items);
  });

  it('prepares a manifest_only dataset manifest from a server-side JSONL path', () => {
    write(path.join(tmpDir, 'dataset.jsonl'), `${JSON.stringify(items[0])}\n${JSON.stringify(items[1])}\n`);

    const prepared = prepareBenchmarkDatasetManifest({
      dataset_id: 'unit-dataset',
      source: { source_type: 'file', format: 'jsonl', path: 'dataset.jsonl' }
    });

    expect(prepared).toMatchObject({
      kind: 'dataset_manifest',
      schema_version: 'benchmark_dataset_manifest_v1',
      dataset_id: 'unit-dataset',
      source,
      snapshot_policy: 'manifest_only',
      item_count: 2
    });
    expect(prepared.dataset_hash).toBe(sha256Document({
      source,
      canonicalization_version: 'dataset_canonical_v1',
      item_count: items.length,
      items
    }));
    expect(prepared.item_hashes).toEqual(items.map((item) => ({
      item_id: item.id,
      hash: sha256Document(item)
    })));
  });

  it('loads manifest_only JSON array datasets', () => {
    const jsonSource = { ...source, format: 'json', path: 'dataset.json' };
    write(path.join(tmpDir, 'dataset.json'), JSON.stringify(items));
    expect(resolveBenchmarkDatasetItems(manifest(jsonSource))).toEqual(items);
  });

  it('loads manifest_only JSON object datasets with items', () => {
    const jsonSource = { ...source, format: 'json', path: 'dataset-object.json' };
    write(path.join(tmpDir, 'dataset-object.json'), JSON.stringify({ items }));
    expect(resolveBenchmarkDatasetItems(manifest(jsonSource))).toEqual(items);
  });

  it('loads manifest_only CSV datasets', () => {
    const csvItems = [
      { id: 'item-1', prompt: 'Hello, model', system_prompt: 'Be brief' },
      { id: 'item-2', prompt: 'Second prompt', system_prompt: '' }
    ];
    const csvSource = { ...source, format: 'csv', path: 'dataset.csv' };
    write(path.join(tmpDir, 'dataset.csv'), 'id,prompt,system_prompt\nitem-1,"Hello, model",Be brief\nitem-2,Second prompt,\n');
    expect(resolveBenchmarkDatasetItems(manifest(csvSource, csvItems))).toEqual(csvItems);
  });

  it('rejects dataset_hash mismatches', () => {
    write(
      path.join(tmpDir, 'dataset.jsonl'),
      `${JSON.stringify({ id: 'item-1', prompt: 'changed' })}\n${JSON.stringify(items[1])}\n`
    );
    expect(() => resolveBenchmarkDatasetItems(manifest(source))).toThrow(/dataset_hash mismatch/);
  });

  it('rejects item_hash mismatches', () => {
    write(path.join(tmpDir, 'dataset.jsonl'), `${JSON.stringify(items[0])}\n${JSON.stringify(items[1])}\n`);
    const instantiation = manifest(source);
    ((instantiation.dataset as Record<string, unknown>).item_hashes as Record<string, unknown>[])[0].hash =
      'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(() => resolveBenchmarkDatasetItems(instantiation)).toThrow(/item hash mismatch/);
  });

  it('rejects unsafe paths outside allowed roots', () => {
    const unsafeSource = { ...source, path: path.resolve(os.tmpdir(), 'outside.jsonl') };
    expect(() => resolveBenchmarkDatasetItems(manifest(unsafeSource))).toThrow(/outside allowed roots/);
  });

  it('rejects unsupported source and storage policies', () => {
    expect(() => resolveBenchmarkDatasetItems(manifest({ ...source, source_type: 'url', url: 'https://example.test/data.jsonl' })))
      .toThrow(/supports only file sources/);
    const compressed = manifest(source);
    (compressed.dataset as Record<string, unknown>).snapshot_policy = 'compressed_blob';
    expect(() => resolveBenchmarkDatasetItems(compressed)).toThrow(/compressed_blob/);
  });
});
