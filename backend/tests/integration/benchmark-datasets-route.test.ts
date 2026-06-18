import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { BENCHMARK_DATASET_ROOT_ENV } from '../../src/services/benchmark-datasets.js';
import { BENCHMARK_LIBRARY_ROOT_ENV } from '../../src/services/benchmark-library.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

describe('benchmark dataset manifest API', () => {
  let tmpDir: string;
  let libraryDir: string;
  let previousRoot: string | undefined;
  let previousLibraryRoot: string | undefined;

  beforeEach(() => {
    process.env.INFERHARNESS_API_TOKEN = 'test-token';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-dataset-route-'));
    libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-library-route-'));
    previousRoot = process.env[BENCHMARK_DATASET_ROOT_ENV];
    previousLibraryRoot = process.env[BENCHMARK_LIBRARY_ROOT_ENV];
    process.env[BENCHMARK_DATASET_ROOT_ENV] = tmpDir;
    process.env[BENCHMARK_LIBRARY_ROOT_ENV] = libraryDir;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env[BENCHMARK_DATASET_ROOT_ENV];
    } else {
      process.env[BENCHMARK_DATASET_ROOT_ENV] = previousRoot;
    }
    if (previousLibraryRoot === undefined) {
      delete process.env[BENCHMARK_LIBRARY_ROOT_ENV];
    } else {
      process.env[BENCHMARK_LIBRARY_ROOT_ENV] = previousLibraryRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(libraryDir, { recursive: true, force: true });
  });

  it('returns a manifest_only manifest for a server-side dataset file', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'codegen.jsonl'),
      `${JSON.stringify({ id: 'code-1', prompt: 'Write a JavaScript add function.' })}\n`,
      'utf8'
    );
    const app = createServer();

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/datasets/manifest',
      headers: AUTH_HEADERS,
      payload: {
        dataset_id: 'codegen-route',
        source: { source_type: 'file', format: 'jsonl', path: 'codegen.jsonl' }
      }
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json().manifest).toMatchObject({
      kind: 'dataset_manifest',
      schema_version: 'benchmark_dataset_manifest_v1',
      dataset_id: 'codegen-route',
      snapshot_policy: 'manifest_only',
      item_count: 1
    });
    await app.close();
  });

  it('rejects missing dataset files with a validation error', async () => {
    const app = createServer();

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/datasets/manifest',
      headers: AUTH_HEADERS,
      payload: {
        dataset_id: 'missing',
        source: { source_type: 'file', format: 'jsonl', path: 'missing.jsonl' }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('file not found');
    await app.close();
  });

  it('creates, reads, lists, and deletes JSONL dataset files with synced manifests', async () => {
    const app = createServer();
    const payload = {
      path: 'editor/codegen.jsonl',
      dataset_id: 'editor-codegen',
      items: [
        { id: 'item-1', prompt: 'Write an add function.', system_prompt: 'Return only code.' },
        { id: 'item-2', prompt: 'Write a clamp function.', system_prompt: 'Return only code.' }
      ]
    };

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/benchmark/datasets/files',
      headers: AUTH_HEADERS,
      payload
    });

    expect(saveResponse.statusCode, JSON.stringify(saveResponse.json())).toBe(200);
    expect(saveResponse.json()).toMatchObject({
      path: 'editor/codegen.jsonl',
      format: 'jsonl',
      dataset_id: 'editor-codegen',
      item_count: 2
    });
    expect(fs.existsSync(path.join(tmpDir, 'editor/codegen.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(libraryDir, 'dataset_manifest/editor-codegen.json'))).toBe(true);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/benchmark/datasets/files',
      headers: AUTH_HEADERS
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'editor/codegen.jsonl', dataset_id: 'editor-codegen', item_count: 2 })
    ]));

    const readResponse = await app.inject({
      method: 'POST',
      url: '/benchmark/datasets/files/read',
      headers: AUTH_HEADERS,
      payload: { path: 'editor/codegen.jsonl' }
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json().items).toHaveLength(2);
    expect(readResponse.json().manifest).toMatchObject({
      kind: 'dataset_manifest',
      dataset_id: 'editor-codegen',
      snapshot_policy: 'manifest_only'
    });

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/benchmark/datasets/files?path=${encodeURIComponent('editor/codegen.jsonl')}`,
      headers: AUTH_HEADERS
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(fs.existsSync(path.join(tmpDir, 'editor/codegen.jsonl'))).toBe(false);
    await app.close();
  });

  it('rejects unsafe dataset editor paths and duplicate item ids', async () => {
    const app = createServer();

    const unsafe = await app.inject({
      method: 'PUT',
      url: '/benchmark/datasets/files',
      headers: AUTH_HEADERS,
      payload: {
        path: '../unsafe.jsonl',
        dataset_id: 'unsafe',
        items: [{ id: 'item-1', prompt: 'Hello' }]
      }
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error).toContain('escapes');

    const duplicate = await app.inject({
      method: 'PUT',
      url: '/benchmark/datasets/files',
      headers: AUTH_HEADERS,
      payload: {
        path: 'duplicate.jsonl',
        dataset_id: 'duplicate',
        items: [
          { id: 'item-1', prompt: 'Hello' },
          { id: 'item-1', prompt: 'Again' }
        ]
      }
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain('unique');
    await app.close();
  });
});
