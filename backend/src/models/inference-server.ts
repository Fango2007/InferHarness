import { getDb } from './db.js';
import { nowIso, parseJson, serializeJson } from './repositories.js';

export type RuntimeSource = 'server' | 'client' | 'mixed';
export type ApiSchemaFamily = 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini' | 'custom';
export type OsName = 'macos' | 'linux' | 'windows' | 'unknown';
export type OsArch = 'arm64' | 'x86_64' | 'unknown';
export type ContainerType = 'docker' | 'podman' | 'none' | 'unknown';
export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'google' | 'unknown';
export type AuthType = 'none' | 'bearer' | 'basic' | 'oauth' | 'custom';
export type CapabilityEnforcement = 'server';

export interface InferenceServerIdentity {
  server_id: string;
  display_name: string;
  active: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface RuntimeInfo {
  retrieved_at: string;
  source: RuntimeSource;
  server_software: { name: string; version: string | null; build: string | null };
  api: { schema_family: ApiSchemaFamily[]; api_version: string | null };
  platform: {
    os: { name: OsName; version: string | null; arch: OsArch };
    container: { type: ContainerType; image: string | null };
  };
  hardware: {
    cpu: { model: string | null; cores: number | null };
    gpu: Array<{ vendor: GpuVendor; model: string | null; vram_mb: number | null; gpu_cores: number | null; neural_engine_tops: number | null }>;
    ram_mb: number | null;
  };
}

export interface EndpointsInfo {
  base_url: string;
  health_url: string | null;
  https: boolean;
}

export interface AuthInfo {
  type: AuthType;
  header_name: string;
  token_env: string | null;
  token?: string | null;
  token_present?: boolean;
}

export interface CapabilitiesInfo {
  server: { streaming: boolean; models_endpoint: boolean };
  generation: { text: boolean; json_schema_output: boolean; tools: boolean; embeddings: boolean };
  multimodal: {
    vision: { input_images: boolean; output_images: boolean };
    audio: { input_audio: boolean; output_audio: boolean };
  };
  reasoning: { exposed: boolean; token_budget_configurable: boolean };
  concurrency: {
    parallel_requests: boolean;
    parallel_tool_calls: boolean;
    max_concurrent_requests: number | null;
  };
  enforcement: CapabilityEnforcement;
}

export interface DiscoveryInfo {
  retrieved_at: string;
  ttl_seconds: number;
  model_list: {
    raw: Record<string, unknown>;
    normalised: Array<{
      model_id: string;
      display_name: string | null;
      context_window_tokens: number | null;
      quantisation: {
        method: string;
        bits: number | null;
        group_size: number | null;
        scheme?: string | null;
        variant?: string | null;
        weight_format?: string | null;
      } | string | null;
      provider?: string | null;
      base_model_name?: string | null;
      default_temperature?: number | null;
      capabilities?: Record<string, boolean>;
      raw?: Record<string, unknown>;
    }>;
  };
}

export interface InferenceServerRecord {
  inference_server: InferenceServerIdentity;
  runtime: RuntimeInfo;
  endpoints: EndpointsInfo;
  auth: AuthInfo;
  capabilities: CapabilitiesInfo;
  discovery: DiscoveryInfo;
  raw: Record<string, unknown>;
}

function defaultRuntime(): RuntimeInfo {
  const now = nowIso();
  return {
    retrieved_at: now,
    source: 'client',
    server_software: { name: 'unknown', version: null, build: null },
    api: { schema_family: ['custom'], api_version: null },
    platform: {
      os: { name: 'unknown', version: null, arch: 'unknown' },
      container: { type: 'unknown', image: null }
    },
    hardware: { cpu: { model: null, cores: null }, gpu: [], ram_mb: null }
  };
}

function defaultEndpoints(): EndpointsInfo {
  return { base_url: 'http://localhost:8080', health_url: null, https: false };
}

function defaultAuth(): AuthInfo {
  return { type: 'none', header_name: 'Authorization', token_env: null, token: null };
}

function defaultCapabilities(): CapabilitiesInfo {
  return {
    server: { streaming: false, models_endpoint: false },
    generation: { text: false, json_schema_output: false, tools: false, embeddings: false },
    multimodal: {
      vision: { input_images: false, output_images: false },
      audio: { input_audio: false, output_audio: false }
    },
    reasoning: { exposed: false, token_budget_configurable: false },
    concurrency: { parallel_requests: false, parallel_tool_calls: false, max_concurrent_requests: null },
    enforcement: 'server'
  };
}

function defaultDiscovery(): DiscoveryInfo {
  return {
    retrieved_at: nowIso(),
    ttl_seconds: Math.round(Number(process.env.INFERHARNESS_CONTEXT_PROBE_TIMEOUT_MS || 300000) / 1000),
    model_list: { raw: {}, normalised: [] }
  };
}

function mapRow(row: {
  server_id: string;
  display_name: string;
  active: number;
  archived: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  runtime: string | null;
  endpoints: string | null;
  auth: string | null;
  capabilities: string | null;
  discovery: string | null;
  raw: string | null;
}): InferenceServerRecord {
  return {
    inference_server: {
      server_id: row.server_id,
      display_name: row.display_name,
      active: Boolean(row.active),
      archived: Boolean(row.archived),
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at
    },
    runtime: (parseJson(row.runtime ?? '') as RuntimeInfo) ?? defaultRuntime(),
    endpoints: (parseJson(row.endpoints ?? '') as EndpointsInfo) ?? defaultEndpoints(),
    auth: { ...defaultAuth(), ...((parseJson(row.auth ?? '') as AuthInfo) ?? {}) },
    capabilities: (parseJson(row.capabilities ?? '') as CapabilitiesInfo) ?? defaultCapabilities(),
    discovery: (parseJson(row.discovery ?? '') as DiscoveryInfo) ?? defaultDiscovery(),
    raw: (parseJson(row.raw ?? '') as Record<string, unknown>) ?? {}
  };
}

export function listInferenceServers(): InferenceServerRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM inference_servers ORDER BY display_name ASC')
    .all() as Array<{
    server_id: string;
    display_name: string;
    active: number;
    archived: number;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    runtime: string | null;
    endpoints: string | null;
    auth: string | null;
    capabilities: string | null;
    discovery: string | null;
    raw: string | null;
  }>;
  return rows.map(mapRow);
}

export function getInferenceServerById(id: string): InferenceServerRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM inference_servers WHERE server_id = ?')
    .get(id) as
    | {
        server_id: string;
        display_name: string;
        active: number;
        archived: number;
        created_at: string;
        updated_at: string;
        archived_at: string | null;
        runtime: string | null;
        endpoints: string | null;
        auth: string | null;
        capabilities: string | null;
        discovery: string | null;
        raw: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return mapRow(row);
}

export function createInferenceServer(
  input: Omit<InferenceServerRecord, 'inference_server'> & {
    inference_server: Omit<InferenceServerIdentity, 'created_at' | 'updated_at'>;
  }
): InferenceServerRecord {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO inference_servers (
      server_id, display_name, active, archived, created_at, updated_at, archived_at,
      runtime, endpoints, auth, capabilities, discovery, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.inference_server.server_id,
    input.inference_server.display_name,
    input.inference_server.active ? 1 : 0,
    input.inference_server.archived ? 1 : 0,
    now,
    now,
    input.inference_server.archived_at,
    serializeJson(input.runtime),
    serializeJson(input.endpoints),
    serializeJson(input.auth),
    serializeJson(input.capabilities),
    serializeJson(input.discovery),
    serializeJson(input.raw)
  );

  return {
    ...input,
    inference_server: {
      ...input.inference_server,
      created_at: now,
      updated_at: now
    }
  };
}

export function updateInferenceServer(
  id: string,
  updates: Partial<InferenceServerRecord>
): InferenceServerRecord | null {
  const existing = getInferenceServerById(id);
  if (!existing) {
    return null;
  }
  const db = getDb();
  const now = nowIso();
  const merged: InferenceServerRecord = {
    ...existing,
    ...updates,
    inference_server: {
      ...existing.inference_server,
      ...updates.inference_server,
      updated_at: now
    }
  };

  db.prepare(
    `UPDATE inference_servers
     SET display_name = ?, active = ?, archived = ?, updated_at = ?, archived_at = ?,
         runtime = ?, endpoints = ?, auth = ?, capabilities = ?, discovery = ?, raw = ?
     WHERE server_id = ?`
  ).run(
    merged.inference_server.display_name,
    merged.inference_server.active ? 1 : 0,
    merged.inference_server.archived ? 1 : 0,
    merged.inference_server.updated_at,
    merged.inference_server.archived_at,
    serializeJson(merged.runtime),
    serializeJson(merged.endpoints),
    serializeJson(merged.auth),
    serializeJson(merged.capabilities),
    serializeJson(merged.discovery),
    serializeJson(merged.raw),
    id
  );

  return merged;
}

export function deleteInferenceServer(id: string): boolean {
  const db = getDb();
  const deleted = db.transaction(() => {
    db.prepare(`
      DELETE FROM benchmark_test_run_results WHERE instantiation_id IN (
        SELECT id FROM benchmark_test_instantiations WHERE server_id = ?
      )
    `).run(id);
    db.prepare('DELETE FROM benchmark_test_instantiations WHERE server_id = ?').run(id);
    db.prepare(`
      DELETE FROM metric_samples WHERE test_result_id IN (
        SELECT id FROM test_results WHERE run_id IN (
          SELECT id FROM runs WHERE inference_server_id = ?
        )
      )
    `).run(id);
    db.prepare(`
      DELETE FROM test_result_documents WHERE run_id IN (
        SELECT id FROM runs WHERE inference_server_id = ?
      )
    `).run(id);
    db.prepare(`
      DELETE FROM test_results WHERE run_id IN (
        SELECT id FROM runs WHERE inference_server_id = ?
      )
    `).run(id);
    db.prepare('DELETE FROM runs WHERE inference_server_id = ?').run(id);
    db.prepare('DELETE FROM evaluations WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE server_id = ?').run(id);
    const result = db.prepare('DELETE FROM inference_servers WHERE server_id = ?').run(id);
    return result.changes > 0;
  })();
  return deleted;
}
