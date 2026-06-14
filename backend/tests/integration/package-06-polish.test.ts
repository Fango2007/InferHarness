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

function seedServer(serverId = 'srv-queue') {
  const db = getDb();
  const now = '2026-05-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO inference_servers (
      server_id, display_name, active, archived, created_at, updated_at, runtime,
      endpoints, auth, capabilities, discovery, raw
    ) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId,
    'Queue Server',
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

function seedQueueResult(id = 'queue-result-a') {
  const db = getDb();
  const now = '2026-05-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO runs (
      id, inference_server_id, suite_id, test_id, profile_id, profile_version,
      status, started_at, ended_at, environment_snapshot, retention_days
    ) VALUES ('run-queue', 'srv-queue', null, 'template-queue', null, null, 'completed', ?, ?, ?, 30)
  `).run(
    now,
    now,
    JSON.stringify({ effective_config: { model: 'model-a', temperature: 0.2, top_p: 0.9, max_tokens: 128, quantization_level: 'Q4', stream: true } })
  );
  db.prepare(`
    INSERT INTO test_results (
      id, run_id, test_id, verdict, failure_reason, metrics, artefacts, raw_events,
      repetition_stats, started_at, ended_at
    ) VALUES (?, 'run-queue', 'template-queue', 'pass', null, ?, ?, '[]', ?, ?, ?)
  `).run(
    id,
    JSON.stringify({ latency_ms: 42, prompt_tokens: 7, completion_tokens: 9, total_tokens: 16, estimated_cost: 0.001 }),
    JSON.stringify({ response_body: 'Paris is rainy.' }),
    JSON.stringify({ repetitions: 1 }),
    now,
    now
  );
  db.prepare(`
    INSERT INTO test_result_documents (test_result_id, run_id, test_id, schema_version, document, created_at)
    VALUES (?, 'run-queue', 'template-queue', '1.0.0', ?, ?)
  `).run(
    id,
    JSON.stringify({ prompt: 'Weather in Paris?', test: { tags: ['queue'] }, selected_model: { id: 'model-a' } }),
    now
  );
}

describe('package 06 backend contracts', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitb-package-06-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    runSchema(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    seedServer();
  });

  afterEach(() => {
    resetDbInstance();
  });

  it('supports inference parameter preset CRUD', async () => {
    const app = createServer();
    const created = await app.inject({
      method: 'POST',
      url: '/inference-param-presets',
      headers: AUTH_HEADERS,
      payload: {
        name: 'Queue defaults',
        parameters: { temperature: 0.2, top_p: 0.9, max_tokens: 128, quantization_level: 'Q4', stream: true }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().parameters.stream).toBe(true);

    const listed = await app.inject({ method: 'GET', url: '/inference-param-presets', headers: AUTH_HEADERS });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/inference-param-presets/${created.json().id}`,
      headers: AUTH_HEADERS,
      payload: { parameters: { temperature: 0.5, top_p: null, max_tokens: null, quantization_level: null, stream: false } }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().parameters.temperature).toBe(0.5);

    const deleted = await app.inject({ method: 'DELETE', url: `/inference-param-presets/${created.json().id}`, headers: AUTH_HEADERS });
    expect(deleted.statusCode).toBe(204);
  });

  it('moves queue items through pending, done, and duplicate-score states', async () => {
    seedQueueResult();
    const app = createServer();

    const pending = await app.inject({ method: 'GET', url: '/evaluation-queue', headers: AUTH_HEADERS });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().counts.pending).toBe(1);
    expect(pending.json().items[0].test_result_id).toBe('queue-result-a');

    const detail = await app.inject({ method: 'GET', url: '/evaluation-queue/queue-result-a', headers: AUTH_HEADERS });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().prompt_text).toBe('Weather in Paris?');
    expect(detail.json().inference_config.temperature).toBe(0.2);

    const score = await app.inject({
      method: 'POST',
      url: '/evaluation-queue/queue-result-a/score',
      headers: AUTH_HEADERS,
      payload: {
        accuracy_score: 5,
        relevance_score: 4,
        coherence_score: 5,
        completeness_score: 4,
        helpfulness_score: 5,
        note: 'Good answer'
      }
    });
    expect(score.statusCode).toBe(201);
    expect(score.json().source_test_result_id).toBe('queue-result-a');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/evaluation-queue/queue-result-a/score',
      headers: AUTH_HEADERS,
      payload: { accuracy_score: 5, relevance_score: 5, coherence_score: 5, completeness_score: 5, helpfulness_score: 5 }
    });
    expect(duplicate.statusCode).toBe(409);

    const done = await app.inject({ method: 'GET', url: '/evaluation-queue?status=done', headers: AUTH_HEADERS });
    expect(done.statusCode).toBe(200);
    expect(done.json().counts.done).toBe(1);
    expect(done.json().items[0].status).toBe('done');
  });

  it('persists skipped queue items', async () => {
    seedQueueResult('queue-result-skip');
    const app = createServer();
    const skipped = await app.inject({
      method: 'POST',
      url: '/evaluation-queue/queue-result-skip/skip',
      headers: AUTH_HEADERS,
      payload: { reason: 'not useful' }
    });
    expect(skipped.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/evaluation-queue?status=skipped', headers: AUTH_HEADERS });
    expect(list.statusCode).toBe(200);
    expect(list.json().counts.skipped).toBe(1);
    expect(list.json().items[0].test_result_id).toBe('queue-result-skip');
  });
});

describe('package 06 migrations', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  afterEach(() => {
    resetDbInstance();
  });

  it('starts against a legacy evaluations table without source_test_result_id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitb-package-06-legacy-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    const db = getDb();
    db.exec(`
      CREATE TABLE inference_servers (
        server_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        runtime TEXT NOT NULL,
        endpoints TEXT NOT NULL,
        auth TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        discovery TEXT NOT NULL,
        raw TEXT NOT NULL
      );
      CREATE TABLE eval_prompts (
        id TEXT NOT NULL PRIMARY KEY,
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE evaluations (
        id TEXT NOT NULL PRIMARY KEY,
        prompt_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        server_id TEXT NOT NULL,
        inference_config TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms REAL,
        word_count INTEGER,
        estimated_cost REAL,
        accuracy_score INTEGER NOT NULL CHECK (accuracy_score BETWEEN 1 AND 5),
        relevance_score INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
        coherence_score INTEGER NOT NULL CHECK (coherence_score BETWEEN 1 AND 5),
        completeness_score INTEGER NOT NULL CHECK (completeness_score BETWEEN 1 AND 5),
        helpfulness_score INTEGER NOT NULL CHECK (helpfulness_score BETWEEN 1 AND 5),
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (prompt_id) REFERENCES eval_prompts(id),
        FOREIGN KEY (server_id) REFERENCES inference_servers(server_id)
      );
    `);

    const app = createServer();
    const columns = (getDb().prepare('PRAGMA table_info(evaluations)').all() as Array<{ name: string }>).map((column) => column.name);
    const indexes = (getDb().prepare('PRAGMA index_list(evaluations)').all() as Array<{ name: string }>).map((index) => index.name);
    expect(columns).toContain('source_test_result_id');
    expect(indexes).toContain('idx_evaluations_source_test_result');
    await app.close();
  });
});
