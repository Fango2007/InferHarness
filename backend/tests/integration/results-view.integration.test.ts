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
  const instantiationId = `inst-${input.runId}`;
  const status = input.verdict === 'pass' ? 'completed' : 'completed_with_errors';
  const metricResults = input.coldStartSamples
    ? input.coldStartSamples.cold_penalty_ms.map((coldPenalty, index) => ({
        stage_id: 'stage-1',
        item_index: index,
        elapsed_ms: input.latency + index,
        estimated_cost: index === 0 ? 0.001 : 0,
        cold_penalty_ms: coldPenalty,
        cold_total_ms: input.coldStartSamples?.cold_total_ms[index],
        hot_total_ms: input.coldStartSamples?.hot_total_ms[index]
      }))
    : [{ stage_id: 'stage-1', item_index: 0, elapsed_ms: input.latency, estimated_cost: 0.001 }];
  const instantiationDocument = {
    template_id: templateId,
    model_id: input.model,
    server_id: serverId,
    template: { template_id: templateId, name: templateId, kind: 'JSON', tags: ['nightly'] }
  };

  db.prepare(`
    INSERT OR IGNORE INTO models (
      server_id, model_id, display_name, active, archived, created_at, updated_at,
      model_schema_version, identity, architecture, modalities, capabilities,
      limits, performance, configuration, discovery, raw
    ) VALUES (?, ?, ?, 1, 0, ?, ?, 'model_v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId,
    input.model,
    input.model,
    input.startedAt,
    input.startedAt,
    JSON.stringify({ id: input.model }),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({})
  );

  db.prepare(`
    INSERT INTO benchmark_test_instantiations (
      id, schema_version, document_hash, template_id, template_version, server_id,
      model_id, dataset_hash, status, document, created_at, updated_at
    ) VALUES (?, 'benchmark_test_instantiation_v1', ?, ?, '1.0.0', ?, ?, ?, 'created', ?, ?, ?)
  `).run(
    instantiationId,
    `hash-${instantiationId}`,
    templateId,
    serverId,
    input.model,
    `dataset-${input.runId}`,
    JSON.stringify(instantiationDocument),
    input.startedAt,
    input.startedAt
  );

  const resultId = `result-${input.runId}`;
  db.prepare(`
    INSERT INTO benchmark_test_run_results (
      id, schema_version, document_hash, instantiation_id, run_id, status, document, created_at
    ) VALUES (?, 'benchmark_test_run_result_v1', ?, ?, ?, ?, ?, ?)
  `).run(
    resultId,
    `hash-${resultId}`,
    instantiationId,
    input.runId,
    status,
    JSON.stringify({
      kind: 'test_run_result',
      schema_version: 'benchmark_test_run_result_v1',
      engine_version: 'test',
      run_id: input.runId,
      instantiation_id: instantiationId,
      status,
      started_at: input.startedAt,
      completed_at: input.startedAt,
      instantiation_snapshot: instantiationDocument,
      stage_results: [
        {
          stage_id: 'stage-1',
          stage_type: 'dataset_loop',
          status: input.verdict === 'pass' ? 'completed' : 'failed',
          record_metrics: true,
          run_count: 1,
          results: [
            {
              item_index: 0,
              status: input.verdict === 'pass' ? 'completed' : 'failed',
              started_at: input.startedAt,
              completed_at: input.startedAt,
              elapsed_ms: input.latency
            }
          ],
          errors: input.verdict === 'fail' ? [{ code: 'assertion_failed', message: 'assertion failed' }] : [],
          warnings: []
        }
      ],
      raw_responses: [{ body: { id: input.runId } }],
      normalized_responses: [{ answer_text: input.verdict === 'pass' ? 'OK' : 'not OK' }],
      metric_results: metricResults,
      aggregated_metrics: {
        elapsed_ms: { median: input.latency, mean: input.latency, valid_sample_count: metricResults.length }
      },
      errors: input.verdict === 'fail' ? [{ code: 'assertion_failed', message: 'assertion failed' }] : [],
      warnings: []
    }),
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

  it('filters benchmark-backed history by status, model, score and tag', async () => {
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
    expect(response.json().raw_run.metric_results[0].elapsed_ms).toBe(100);
  });

  it('deletes benchmark result rows without legacy runs', async () => {
    const app = createServer();
    seedRun({ runId: 'run-delete', model: 'model-a', verdict: 'pass', startedAt: '2026-05-01T10:00:00.000Z', latency: 100 });

    const response = await app.inject({
      method: 'DELETE',
      url: '/results-view/runs/run-delete',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(204);
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM benchmark_test_run_results WHERE run_id = ?').get('run-delete') as { count: number }).count).toBe(0);
  });
});
