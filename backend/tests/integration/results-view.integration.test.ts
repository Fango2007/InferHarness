import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { getDb, resetDbInstance, runSchema } from '../../src/models/db.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(moduleDir, '../../src/models/schema.sql');

function seedServer(serverId = 'srv-results', displayName = 'Results Server') {
  const db = getDb();
  const now = '2026-05-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO inference_servers (
      server_id, display_name, active, archived, created_at, updated_at, runtime,
      endpoints, auth, capabilities, discovery, raw
    ) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId,
    displayName,
    now,
    now,
    JSON.stringify({ api: { api_version: '1.0.0' } }),
    JSON.stringify({ base_url: 'http://localhost:8080' }),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({ model_list: { normalised: [] } }),
    JSON.stringify({})
  );
  return serverId;
}

function seedRun(input: {
  runId: string;
  model: string;
  verdict: 'pass' | 'fail';
  startedAt: string;
  latency: number;
  templateId?: string;
  serverId?: string;
  coldStartSamples?: {
    cold_total_ms: number[];
    hot_total_ms: number[];
    cold_penalty_ms: number[];
  };
}) {
  const db = getDb();
  const templateId = input.templateId ?? 'cold-start';
  const serverId = input.serverId ?? 'srv-results';

  db.prepare(`
    INSERT INTO runs (
      id, inference_server_id, suite_id, test_id, profile_id, profile_version,
      status, started_at, ended_at, environment_snapshot, retention_days
    ) VALUES (?, ?, null, ?, null, null, 'completed', ?, ?, ?, 30)
  `).run(
    input.runId,
    serverId,
    templateId,
    input.startedAt,
    input.startedAt,
    JSON.stringify({ effective_config: { model: input.model } })
  );

  const resultId = `result-${input.runId}`;
  db.prepare(`
    INSERT INTO test_results (
      id, run_id, test_id, verdict, failure_reason, metrics, artefacts, raw_events,
      repetition_stats, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
  `).run(
    resultId,
    input.runId,
    templateId,
    input.verdict,
    input.verdict === 'fail' ? 'assertion failed' : null,
    JSON.stringify({ latency_ms: input.latency, estimated_cost: 0.001 }),
    JSON.stringify(
      input.coldStartSamples
        ? {
            python_result: {
              samples: input.coldStartSamples
            }
          }
        : {}
    ),
    JSON.stringify({ repetitions: 1 }),
    input.startedAt,
    input.startedAt
  );

  db.prepare(`
    INSERT INTO test_result_documents (test_result_id, run_id, test_id, schema_version, document, created_at)
    VALUES (?, ?, ?, '1.0.0', ?, ?)
  `).run(
    resultId,
    input.runId,
    templateId,
    JSON.stringify({ test: { tags: ['nightly'], type: 'scenario-json' }, selected_model: { id: input.model }, steps: [] }),
    input.startedAt
  );
}

describe('results-view routes', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitb-results-view-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    runSchema(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    seedServer();
  });

  afterEach(() => {
    resetDbInstance();
  });

  it('returns empty dashboard/history structures for an empty database window', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: { date_from: '2026-05-01T00:00:00.000Z', date_to: '2026-05-02T00:00:00.000Z' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().dashboard.scorecards.total_runs).toBe(0);
    expect(response.json().history.rows).toEqual([]);
  });

  it('filters run-backed history by status, model, score and tag', async () => {
    const app = createServer();
    seedRun({ runId: 'run-pass', model: 'model-a', verdict: 'pass', startedAt: '2026-05-01T10:00:00.000Z', latency: 100 });
    seedRun({ runId: 'run-fail', model: 'model-b', verdict: 'fail', startedAt: '2026-05-01T11:00:00.000Z', latency: 200 });

    const response = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: {
        date_from: '2026-05-01T00:00:00.000Z',
        date_to: '2026-05-02T00:00:00.000Z',
        statuses: ['pass'],
        model_names: ['model-a'],
        score_min: 90,
        tags: ['nightly']
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().history.rows).toHaveLength(1);
    expect(response.json().history.rows[0].run_id).toBe('run-pass');
  });

  it('returns relationship metadata for the results funnel options', async () => {
    const app = createServer();
    seedServer('srv-other', 'Other Server');
    seedRun({ runId: 'run-a', serverId: 'srv-results', model: 'model-a', templateId: 'template-one', verdict: 'pass', startedAt: '2026-05-01T10:00:00.000Z', latency: 100 });
    seedRun({ runId: 'run-b', serverId: 'srv-other', model: 'model-b', templateId: 'template-two', verdict: 'pass', startedAt: '2026-05-01T11:00:00.000Z', latency: 120 });
    seedRun({ runId: 'run-c', serverId: 'srv-other', model: 'model-a', templateId: 'template-two', verdict: 'fail', startedAt: '2026-05-01T12:00:00.000Z', latency: 140 });

    const response = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: {
        date_from: '2026-05-01T00:00:00.000Z',
        date_to: '2026-05-02T00:00:00.000Z'
      }
    });

    expect(response.statusCode).toBe(200);
    const options = response.json().filter_options;
    expect(options.models.find((entry: { id: string }) => entry.id === 'model-a').server_ids).toEqual(['srv-other', 'srv-results']);
    expect(options.models.find((entry: { id: string }) => entry.id === 'model-b').server_ids).toEqual(['srv-other']);
    expect(options.templates.find((entry: { id: string }) => entry.id === 'template-one')).toMatchObject({
      server_ids: ['srv-results'],
      model_names: ['model-a']
    });
    expect(options.templates.find((entry: { id: string }) => entry.id === 'template-two')).toMatchObject({
      server_ids: ['srv-other'],
      model_names: ['model-a', 'model-b']
    });
  });

  it('returns model summaries for all filtered rows, independent of history pagination', async () => {
    const app = createServer();
    seedRun({ runId: 'run-a1', model: 'model-a', verdict: 'pass', startedAt: '2026-05-01T10:00:00.000Z', latency: 100 });
    seedRun({ runId: 'run-a2', model: 'model-a', verdict: 'fail', startedAt: '2026-05-01T11:00:00.000Z', latency: 200 });
    seedRun({ runId: 'run-b1', model: 'model-b', verdict: 'pass', startedAt: '2026-05-01T12:00:00.000Z', latency: 80 });

    const response = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: {
        date_from: '2026-05-01T00:00:00.000Z',
        date_to: '2026-05-02T00:00:00.000Z',
        page_size: 1
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().history.rows).toHaveLength(1);
    expect(response.json().dashboard.model_summary).toEqual([
      {
        model_name: 'model-b',
        run_count: 1,
        pass_rate: 100,
        median_latency_ms: 80,
        median_cost: 0.001
      },
      {
        model_name: 'model-a',
        run_count: 2,
        pass_rate: 50,
        median_latency_ms: 150,
        median_cost: 0.001
      }
    ]);
  });

  it('returns cold-start sample comparisons grouped by server, model, and template', async () => {
    const app = createServer();
    seedServer('srv-other', 'Other Server');
    seedRun({
      runId: 'run-local-a',
      serverId: 'srv-results',
      model: 'model-a',
      templateId: 'Cold_start_penalty',
      verdict: 'pass',
      startedAt: '2026-05-01T10:00:00.000Z',
      latency: 100,
      coldStartSamples: {
        cold_total_ms: [300, 320, 340],
        hot_total_ms: [200, 200, 200],
        cold_penalty_ms: [100, 120, 140]
      }
    });
    seedRun({
      runId: 'run-other-b',
      serverId: 'srv-other',
      model: 'model-b',
      templateId: 'Cold_start_penalty',
      verdict: 'pass',
      startedAt: '2026-05-01T11:00:00.000Z',
      latency: 90,
      coldStartSamples: {
        cold_total_ms: [240, 250, 260],
        hot_total_ms: [160, 160, 160],
        cold_penalty_ms: [80, 90, 100]
      }
    });
    seedRun({
      runId: 'run-summary-only',
      serverId: 'srv-results',
      model: 'model-c',
      templateId: 'Cold_start_penalty',
      verdict: 'pass',
      startedAt: '2026-05-01T12:00:00.000Z',
      latency: 80
    });

    const response = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: {
        date_from: '2026-05-01T00:00:00.000Z',
        date_to: '2026-05-02T00:00:00.000Z',
        template_ids: ['Cold_start_penalty']
      }
    });

    expect(response.statusCode).toBe(200);
    const comparison = response.json().dashboard.performance_comparison;
    expect(comparison.default_metric).toBe('cold_penalty_ms');
    expect(comparison.groups).toHaveLength(2);
    expect(comparison.groups.map((group: { model_name: string }) => group.model_name)).toEqual(['model-b', 'model-a']);
    expect(comparison.groups[0].metrics.cold_penalty_ms.stats).toMatchObject({
      count: 3,
      min: 80,
      median: 90,
      max: 100
    });
    expect(comparison.groups[1].metrics.cold_total_ms.samples).toEqual([300, 320, 340]);
  });

  it('opens run drawer detail for a history row', async () => {
    const app = createServer();
    seedRun({ runId: 'run-detail', model: 'model-a', verdict: 'pass', startedAt: '2026-05-01T10:00:00.000Z', latency: 100 });

    const response = await app.inject({
      method: 'GET',
      url: '/results-view/runs/run-detail',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().run.run_id).toBe('run-detail');
    expect(response.json().results[0].metrics.latency_ms).toBe(100);
  });
});
