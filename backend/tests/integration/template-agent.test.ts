import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { getDb, resetDbInstance, runSchema } from '../../src/models/db.js';

const mockBackendFetch = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/inference-proxy.js', () => ({
  backendFetch: mockBackendFetch
}));

const AUTH_HEADERS = { 'x-api-token': 'test-token' };
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(moduleDir, '../../src/models/schema.sql');
const TEMPLATE_FIXTURE = path.resolve(moduleDir, '../contract/fixtures/benchmark/test_template.valid.json');

function seedServerAndModel(baseUrl = 'http://127.0.0.1:1') {
  const db = getDb();
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO inference_servers (
      server_id, display_name, active, archived, created_at, updated_at, runtime,
      endpoints, auth, capabilities, discovery, raw
    ) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'agent-server',
    'Agent Server',
    now,
    now,
    JSON.stringify({ api: { schema_family: ['openai-compatible'], api_version: '1.0.0' } }),
    JSON.stringify({ base_url: baseUrl, health_url: null, https: false }),
    JSON.stringify({ type: 'none', header_name: 'Authorization', token_env: null }),
    JSON.stringify({
      server: { streaming: false, models_endpoint: true },
      generation: { text: true, json_schema_output: true, tools: false, embeddings: false }
    }),
    JSON.stringify({ model_list: { normalised: [] } }),
    JSON.stringify({})
  );
  db.prepare(`
    INSERT INTO models (
      server_id, model_id, display_name, active, archived, created_at, updated_at,
      archived_at, base_model_name, model_schema_version, identity, architecture,
      modalities, capabilities, limits, performance, configuration, discovery, raw
    ) VALUES (?, ?, ?, 1, 0, ?, ?, null, null, '1.2.0', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'agent-server',
    'agent-model',
    'Agent Model',
    now,
    now,
    JSON.stringify({ provider: 'custom' }),
    JSON.stringify({ type: 'unknown', precision: 'unknown', quantisation: { method: 'unknown', bits: null, group_size: null }, format: null }),
    JSON.stringify({ input: ['text'], output: ['text'] }),
    JSON.stringify({ generation: { text: true, json_schema_output: true, tools: false, embeddings: false } }),
    JSON.stringify({ context_window_tokens: 8192, max_output_tokens: 4096, max_images: null, max_batch_size: null }),
    JSON.stringify({ theoretical: { tokens_per_second: null }, observed: {} }),
    JSON.stringify({ default_parameters: {}, context_strategy: { type: 'custom', window_tokens: null } }),
    JSON.stringify({ retrieved_at: now, source: 'test' }),
    JSON.stringify({})
  );
}

function mockAgentResponse(content: string) {
  mockBackendFetch.mockResolvedValue(new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ));
}

describe('template agent settings and route', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitb-template-agent-'));
    process.env.INFERHARNESS_DB_PATH = path.join(tmpDir, 'test.sqlite');
    resetDbInstance();
    runSchema(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    mockBackendFetch.mockReset();
  });

  afterEach(() => {
    resetDbInstance();
  });

  it('persists the selected template agent model in app settings', async () => {
    seedServerAndModel();
    const app = createServer();

    const saved = await app.inject({
      method: 'PATCH',
      url: '/system/settings/template-agent-model',
      headers: AUTH_HEADERS,
      payload: { server_id: 'agent-server', model_id: 'agent-model' }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().template_agent_model).toEqual({ server_id: 'agent-server', model_id: 'agent-model' });

    const settings = await app.inject({ method: 'GET', url: '/system/settings', headers: AUTH_HEADERS });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().template_agent_model.model_id).toBe('agent-model');
  });

  it('rate limits template agent settings reads', async () => {
    const app = createServer();
    for (let index = 0; index < 60; index += 1) {
      const response = await app.inject({ method: 'GET', url: '/system/settings', headers: AUTH_HEADERS });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: 'GET', url: '/system/settings', headers: AUTH_HEADERS });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'Too many requests' });
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('runs the agent and returns a validated draft without saving it', async () => {
    const draft = JSON.parse(fs.readFileSync(TEMPLATE_FIXTURE, 'utf8')) as Record<string, unknown>;
    mockAgentResponse(JSON.stringify({
      status: 'draft_ready',
      reply: 'Draft ready for review.',
      template: draft
    }));
    seedServerAndModel('http://agent.local');
    const app = createServer();
    await app.inject({
      method: 'PATCH',
      url: '/system/settings/template-agent-model',
      headers: AUTH_HEADERS,
      payload: { server_id: 'agent-server', model_id: 'agent-model' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/template-agent',
      headers: AUTH_HEADERS,
      payload: { mode: 'create', message: 'Create a benchmark for concise code explanations.' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('draft_ready');
    expect(response.json().template.template_id).toBe(draft.template_id);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM benchmark_documents').get()).toEqual({ count: 0 });
    expect(mockBackendFetch).toHaveBeenCalledWith('http://agent.local/v1/chat/completions', expect.any(Object));
  });

  it('passes through challenge questions when the request is underspecified', async () => {
    mockAgentResponse(JSON.stringify({
      status: 'needs_input',
      reply: 'I need more detail before drafting.',
      questions: ['What behavior should the benchmark measure?']
    }));
    seedServerAndModel('http://agent.local');
    const app = createServer();
    await app.inject({
      method: 'PATCH',
      url: '/system/settings/template-agent-model',
      headers: AUTH_HEADERS,
      payload: { server_id: 'agent-server', model_id: 'agent-model' }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/benchmark/template-agent',
      headers: AUTH_HEADERS,
      payload: { mode: 'create', message: 'Make a benchmark.' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('needs_input');
    expect(response.json().questions).toEqual(['What behavior should the benchmark measure?']);
  });
});
