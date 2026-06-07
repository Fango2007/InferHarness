import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { BENCHMARK_DATASET_ROOT_ENV } from '../../src/services/benchmark-datasets.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

describe('benchmark dataset manifest API', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    process.env.INFERHARNESS_API_TOKEN = 'test-token';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-dataset-route-'));
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
});
