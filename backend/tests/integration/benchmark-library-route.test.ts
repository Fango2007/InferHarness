import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { resetDbInstance } from '../../src/models/db.js';
import { BENCHMARK_LIBRARY_ROOT_ENV } from '../../src/services/benchmark-library.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

function routeTemplate(): Record<string, unknown> {
  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: 'route-library-template',
    template_version: '1.0.0',
    name: 'Route library template',
    operation: 'chat_completion',
    stages: [{ id: 'chat', type: 'dataset_loop', iterations_per_item: 1, record_metrics: true }],
    metrics: ['elapsed_ms'],
    aggregations: ['mean']
  };
}

describe('benchmark library routes', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    process.env.INFERHARNESS_API_TOKEN = 'test-token';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-benchmark-library-route-'));
    previousRoot = process.env[BENCHMARK_LIBRARY_ROOT_ENV];
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    process.env[BENCHMARK_LIBRARY_ROOT_ENV] = path.join(tmpDir, 'library');
    resetDbInstance();
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

  it('reloads built-in documents and reports library status', async () => {
    const app = createServer();

    const reload = await app.inject({
      method: 'POST',
      url: '/benchmark/library/reload',
      headers: AUTH_HEADERS,
      payload: {}
    });
    expect(reload.statusCode, JSON.stringify(reload.json())).toBe(200);
    expect(reload.json().installed.some((entry: { id: string }) => entry.id === 'agent-codex-apply-patch-v1')).toBe(true);

    const status = await app.inject({ method: 'GET', url: '/benchmark/library', headers: AUTH_HEADERS });
    expect(status.statusCode).toBe(200);
    expect(status.json().entries.some((entry: { id: string; status: string }) =>
      entry.id === 'agent-codex-apply-patch-v1' && entry.status === 'built_in'
    )).toBe(true);

    await app.close();
  });

  it('auto-seeds built-in documents when explicitly enabled for server startup', async () => {
    const previousAutoseed = process.env.INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED;
    process.env.INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED = 'true';
    const app = createServer();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/benchmark/documents/test_template',
        headers: AUTH_HEADERS
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().some((entry: { id: string }) => entry.id === 'agent-codex-apply-patch-v1')).toBe(true);
    } finally {
      if (previousAutoseed === undefined) {
        delete process.env.INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED;
      } else {
        process.env.INFERHARNESS_BENCHMARK_LIBRARY_AUTOSEED = previousAutoseed;
      }
      await app.close();
    }
  });


  it('persists API-created benchmark documents to the user library', async () => {
    const app = createServer();

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/documents',
      headers: AUTH_HEADERS,
      payload: routeTemplate()
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(fs.existsSync(path.join(
      process.env[BENCHMARK_LIBRARY_ROOT_ENV] as string,
      'test_template',
      'route-library-template.json'
    ))).toBe(true);

    await app.close();
  });
});
