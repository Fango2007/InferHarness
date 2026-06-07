import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { getDb, resetDbInstance, runSchema } from '../../src/models/db.js';
import { createInferenceServerRecord } from '../../src/services/inference-servers-repository.js';
import { upsertTestDefinition } from '../../src/models/test-definition.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(moduleDir, '../../src/models/schema.sql');

function seedServer(serverId = 'srv-delete') {
  const db = getDb();
  const now = '2026-05-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO inference_servers (
      server_id, display_name, active, archived, created_at, updated_at, runtime,
      endpoints, auth, capabilities, discovery, raw
    ) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId,
    'Delete Server',
    now,
    now,
    JSON.stringify({ api: { api_version: '1.0.0' } }),
    JSON.stringify({ base_url: 'http://localhost:8080' }),
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify({ model_list: { normalised: [] } }),
    JSON.stringify({})
  );
}

function seedRunWithDependencies(input: { runId: string; status?: string; resultId?: string }) {
  const db = getDb();
  const now = '2026-05-01T10:00:00.000Z';
  const runId = input.runId;
  const resultId = input.resultId ?? `result-${runId}`;
  db.prepare(`
    INSERT INTO runs (
      id, inference_server_id, suite_id, test_id, profile_id, profile_version,
      status, started_at, ended_at, environment_snapshot, retention_days
    ) VALUES (?, 'srv-delete', null, 'delete-test', null, null, ?, ?, ?, ?, 30)
  `).run(
    runId,
    input.status ?? 'completed',
    now,
    now,
    JSON.stringify({ effective_config: { model: 'model-delete' } })
  );
  db.prepare(`
    INSERT INTO test_results (
      id, run_id, test_id, verdict, failure_reason, metrics, artefacts, raw_events,
      repetition_stats, started_at, ended_at
    ) VALUES (?, ?, 'delete-test', 'pass', null, ?, ?, '[]', ?, ?, ?)
  `).run(
    resultId,
    runId,
    JSON.stringify({ latency_ms: 42 }),
    JSON.stringify({ response_body: 'ok' }),
    JSON.stringify({ repetitions: 1 }),
    now,
    now
  );
  db.prepare(`
    INSERT INTO test_result_documents (test_result_id, run_id, test_id, schema_version, document, created_at)
    VALUES (?, ?, 'delete-test', '1.0.0', ?, ?)
  `).run(resultId, runId, JSON.stringify({ test: { tags: ['delete'] }, selected_model: { id: 'model-delete' } }), now);
  db.prepare(`
    INSERT INTO metric_samples (id, test_result_id, repetition_index, total_ms, created_at)
    VALUES (?, ?, 0, 42, ?)
  `).run(`metric-${runId}`, resultId, now);
  db.prepare(`
    INSERT INTO evaluation_queue_skips (test_result_id, reason, skipped_at)
    VALUES (?, 'not useful', ?)
  `).run(resultId, now);
  db.prepare(`
    INSERT INTO eval_prompts (id, text, tags, created_at)
    VALUES (?, 'Prompt', '[]', ?)
  `).run(`prompt-${runId}`, now);
  db.prepare(`
    INSERT INTO evaluations (
      id, prompt_id, model_name, server_id, inference_config, answer_text,
      input_tokens, output_tokens, total_tokens, latency_ms, word_count,
      estimated_cost, accuracy_score, relevance_score, coherence_score,
      completeness_score, helpfulness_score, note, source_test_result_id, created_at
    ) VALUES (?, ?, 'model-delete', 'srv-delete', '{}', 'Answer', 1, 1, 2, 42, 1, 0.001, 5, 5, 5, 5, 5, null, ?, ?)
  `).run(`evaluation-${runId}`, `prompt-${runId}`, resultId, now);
}

beforeEach(() => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitb-runs-single-'));
  process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
  resetDbInstance();
  runSchema(fs.readFileSync(SCHEMA_PATH, 'utf8'));
});

afterEach(() => {
  resetDbInstance();
});

describe('runs API', () => {
  it('creates a single run', async () => {
    const app = createServer();
    const server = createInferenceServerRecord({
      inference_server: { display_name: `local-${Date.now()}` },
      endpoints: { base_url: 'http://localhost:11434' },
      runtime: { api: { schema_family: ['openai-compatible'], api_version: null } }
    });
    upsertTestDefinition({
      id: 'test-1',
      version: '1.0.0',
      name: 'Test 1',
      description: 'Basic test',
      category: 'basic',
      tags: [],
      protocols: ['openai_chat_completions'],
      spec_path: 'tests/definitions/test-1.json',
      runner_type: 'json',
      request_template: {},
      assertions: [],
      metric_rules: {}
    });
    const response = await app.inject({
      method: 'POST',
      url: '/runs',
      headers: AUTH_HEADERS,
      payload: { inference_server_id: server.inference_server.server_id, test_id: 'test-1' }
    });

    expect(response.statusCode).toBe(201);
  });

  it('deletes a completed run and its result-owned data', async () => {
    seedServer();
    seedRunWithDependencies({ runId: 'run-delete' });
    const app = createServer();

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/runs/run-delete',
      headers: AUTH_HEADERS
    });

    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/runs/run-delete', headers: AUTH_HEADERS })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/results-view/runs/run-delete', headers: AUTH_HEADERS })).statusCode).toBe(404);
    const listed = await app.inject({ method: 'GET', url: '/runs', headers: AUTH_HEADERS });
    expect(listed.json().some((run: { id: string }) => run.id === 'run-delete')).toBe(false);
    const resultsView = await app.inject({
      method: 'POST',
      url: '/results-view/query',
      headers: AUTH_HEADERS,
      payload: {
        date_from: '2026-05-01T00:00:00.000Z',
        date_to: '2026-05-02T00:00:00.000Z'
      }
    });
    expect(resultsView.json().history.total).toBe(0);

    const db = getDb();
    expect((db.prepare('SELECT COUNT(1) AS count FROM runs WHERE id = ?').get('run-delete') as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(1) AS count FROM test_results WHERE run_id = ?').get('run-delete') as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(1) AS count FROM test_result_documents WHERE run_id = ?').get('run-delete') as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(1) AS count FROM metric_samples WHERE test_result_id = ?').get('result-run-delete') as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(1) AS count FROM evaluation_queue_skips WHERE test_result_id = ?').get('result-run-delete') as { count: number }).count).toBe(0);
    expect(
      (db.prepare('SELECT source_test_result_id FROM evaluations WHERE id = ?').get('evaluation-run-delete') as { source_test_result_id: string | null }).source_test_result_id
    ).toBeNull();
  });

  it('returns 404 when deleting an unknown run', async () => {
    seedServer();
    const app = createServer();

    const response = await app.inject({
      method: 'DELETE',
      url: '/runs/missing-run',
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('Run not found');
  });

  it.each(['queued', 'running'])('blocks deleting %s runs', async (status) => {
    seedServer();
    seedRunWithDependencies({ runId: `run-${status}`, status });
    const app = createServer();

    const response = await app.inject({
      method: 'DELETE',
      url: `/runs/run-${status}`,
      headers: AUTH_HEADERS
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('Active runs cannot be deleted');
    const db = getDb();
    expect((db.prepare('SELECT COUNT(1) AS count FROM runs WHERE id = ?').get(`run-${status}`) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(1) AS count FROM test_results WHERE run_id = ?').get(`run-${status}`) as { count: number }).count).toBe(1);
  });
});
