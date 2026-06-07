import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb } from '../models/db.js';
import {
  ApiSchemaFamily,
  AuthInfo,
  CapabilitiesInfo,
  DiscoveryInfo,
  EndpointsInfo,
  InferenceServerRecord,
  OsArch,
  OsName,
  RuntimeInfo,
  createInferenceServer,
  getInferenceServerById,
  listInferenceServers,
  updateInferenceServer
} from '../models/inference-server.js';
import { nowIso } from '../models/repositories.js';
import { validateWithSchema } from './schema-validator.js';

export interface InferenceServerInput {
  inference_server?: Partial<InferenceServerRecord['inference_server']>;
  runtime?: Partial<RuntimeInfo>;
  endpoints?: Partial<EndpointsInfo>;
  auth?: Partial<AuthInfo>;
  capabilities?: Partial<CapabilitiesInfo>;
  discovery?: Partial<DiscoveryInfo>;
  raw?: Record<string, unknown>;
}

export class InvalidBaseUrlError extends Error {
  constructor(value: string) {
    super(`Invalid base URL: ${value}`);
    this.name = 'InvalidBaseUrlError';
  }
}

export class InvalidInferenceServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInferenceServerError';
  }
}

export class InferenceServerNotFoundError extends Error {
  constructor(id: string) {
    super(`Inference server not found: ${id}`);
    this.name = 'InferenceServerNotFoundError';
  }
}

const schemaFamilies: ApiSchemaFamily[] = ['openai-compatible', 'ollama', 'custom'];

function normalizeSchemaFamilies(input: unknown): ApiSchemaFamily[] {
  if (!input) {
    return [];
  }
  const rawList = Array.isArray(input) ? input : [input];
  const normalized: ApiSchemaFamily[] = [];
  for (const entry of rawList) {
    if (typeof entry !== 'string') {
      throw new InvalidInferenceServerError('runtime.api.schema_family must be a string array');
    }
    if (!normalized.includes(entry as ApiSchemaFamily)) {
      normalized.push(entry as ApiSchemaFamily);
    }
  }
  return normalized;
}

function parseOsName(platform: string): OsName {
  if (platform === 'darwin') {
    return 'macos';
  }
  if (platform === 'win32') {
    return 'windows';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  return 'unknown';
}

function parseOsArch(arch: string): OsArch {
  if (arch === 'arm64') {
    return 'arm64';
  }
  if (arch === 'x64') {
    return 'x86_64';
  }
  return 'unknown';
}

function validateBaseUrl(value: string): { normalized: string; https: boolean } {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid protocol');
    }
    return { normalized: parsed.toString().replace(/\/$/, ''), https: parsed.protocol === 'https:' };
  } catch {
    throw new InvalidBaseUrlError(value);
  }
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

function defaultRuntime(schemaFamiliesValue: ApiSchemaFamily[]): RuntimeInfo {
  const cpuInfo = os.cpus() ?? [];
  const cpuModel = cpuInfo[0]?.model ?? null;
  const cpuCores = cpuInfo.length ? cpuInfo.length : null;
  return {
    retrieved_at: nowIso(),
    source: 'client',
    server_software: { name: 'unknown', version: null, build: null },
    api: { schema_family: schemaFamiliesValue, api_version: null },
    platform: {
      os: { name: parseOsName(os.platform()), version: os.release() ?? null, arch: parseOsArch(os.arch()) },
      container: { type: 'unknown', image: null }
    },
    hardware: {
      cpu: { model: cpuModel, cores: cpuCores },
      gpu: [],
      ram_mb: Math.round(os.totalmem() / (1024 * 1024))
    }
  };
}

function defaultEndpoints(baseUrl: string): EndpointsInfo {
  const { normalized, https } = validateBaseUrl(baseUrl);
  return { base_url: normalized, health_url: null, https };
}

function defaultAuth(): AuthInfo {
  return { type: 'none', header_name: 'Authorization', token_env: null, token: null };
}

function defaultDiscovery(): DiscoveryInfo {
  return {
    retrieved_at: nowIso(),
    ttl_seconds: Math.round(Number(process.env.INFERHARNESS_CONTEXT_PROBE_TIMEOUT_MS || 300000) / 1000),
    model_list: { raw: {}, normalised: [] }
  };
}

function resolveSchemaPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../schemas/inferencer-server-schema.json');
}

function validateRecord(record: InferenceServerRecord): void {
  const schemaResult = validateWithSchema(resolveSchemaPath(), record);
  if (schemaResult.ok) {
    return;
  }
  const detail = schemaResult.issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  throw new InvalidInferenceServerError(`Schema validation failed: ${detail}`);
}

function mergeRuntime(
  existing: RuntimeInfo | null,
  updates: Partial<RuntimeInfo> | undefined,
  schemaFamiliesValue: ApiSchemaFamily[]
): RuntimeInfo {
  const base = existing ?? defaultRuntime(schemaFamiliesValue);
  if (!updates) {
    return base;
  }
  const merged: RuntimeInfo = {
    ...base,
    ...updates,
    server_software: { ...base.server_software, ...updates.server_software },
    api: { ...base.api, ...updates.api },
    platform: {
      os: { ...base.platform.os, ...updates.platform?.os },
      container: { ...base.platform.container, ...updates.platform?.container }
    },
    hardware: {
      ...base.hardware,
      ...updates.hardware,
      cpu: { ...base.hardware.cpu, ...updates.hardware?.cpu },
      gpu: updates.hardware?.gpu ?? base.hardware.gpu
    }
  };
  return merged;
}

function mergeCapabilities(
  existing: CapabilitiesInfo | null,
  updates: Partial<CapabilitiesInfo> | undefined
): CapabilitiesInfo {
  const base = existing ?? defaultCapabilities();
  if (!updates) {
    return base;
  }
  return {
    ...base,
    ...updates,
    server: { ...base.server, ...updates.server },
    generation: { ...base.generation, ...updates.generation },
    multimodal: {
      vision: { ...base.multimodal.vision, ...updates.multimodal?.vision },
      audio: { ...base.multimodal.audio, ...updates.multimodal?.audio }
    },
    reasoning: { ...base.reasoning, ...updates.reasoning },
    concurrency: { ...base.concurrency, ...updates.concurrency }
  };
}

function mergeDiscovery(
  existing: DiscoveryInfo | null,
  updates: Partial<DiscoveryInfo> | undefined
): DiscoveryInfo {
  const base = existing ?? defaultDiscovery();
  if (!updates) {
    return base;
  }
  return {
    ...base,
    ...updates,
    model_list: {
      raw: updates.model_list?.raw ?? base.model_list.raw,
      normalised: updates.model_list?.normalised ?? base.model_list.normalised
    }
  };
}

export function isDiscoveryCacheValid(discovery: DiscoveryInfo, nowMs = Date.now()): boolean {
  const retrievedMs = Date.parse(discovery.retrieved_at);
  if (Number.isNaN(retrievedMs)) {
    return false;
  }
  return nowMs < retrievedMs + discovery.ttl_seconds * 1000;
}

export function fetchInferenceServers(filters?: {
  active?: boolean;
  archived?: boolean;
  schema_family?: ApiSchemaFamily;
}): InferenceServerRecord[] {
  const servers = listInferenceServers();
  return servers.filter((server) => {
    if (filters?.active !== undefined && server.inference_server.active !== filters.active) {
      return false;
    }
    if (filters?.archived !== undefined && server.inference_server.archived !== filters.archived) {
      return false;
    }
    if (
      filters?.schema_family &&
      !server.runtime.api.schema_family.includes(filters.schema_family)
    ) {
      return false;
    }
    return true;
  });
}

export function fetchInferenceServer(id: string): InferenceServerRecord | null {
  return getInferenceServerById(id);
}

export function createInferenceServerRecord(input: InferenceServerInput): InferenceServerRecord {
  const displayName = input.inference_server?.display_name?.trim() ?? '';
  const schemaFamilyList = normalizeSchemaFamilies(input.runtime?.api?.schema_family);
  const endpointsInput = input.endpoints?.base_url ? input.endpoints : null;
  if (!endpointsInput?.base_url) {
    throw new InvalidInferenceServerError('endpoints.base_url is required');
  }
  const { normalized, https } = validateBaseUrl(endpointsInput.base_url);
  const endpoints = { ...defaultEndpoints(normalized), ...input.endpoints, base_url: normalized, https };

  const serverId = input.inference_server?.server_id ?? crypto.randomUUID();
  if (getInferenceServerById(serverId)) {
    throw new InvalidInferenceServerError(`server_id already exists: ${serverId}`);
  }

  const auth = { ...defaultAuth(), ...input.auth };
  const capabilities = mergeCapabilities(null, input.capabilities);
  const runtime = mergeRuntime(null, input.runtime, schemaFamilyList);
  const discovery = mergeDiscovery(null, input.discovery);
  const raw = input.raw ?? {};
  const inferenceServer: InferenceServerRecord = {
    inference_server: {
      server_id: serverId,
      display_name: displayName,
      active: input.inference_server?.active ?? true,
      archived: input.inference_server?.archived ?? false,
      created_at: nowIso(),
      updated_at: nowIso(),
      archived_at: input.inference_server?.archived_at ?? null
    },
    runtime,
    endpoints,
    auth,
    capabilities,
    discovery,
    raw
  };
  if (inferenceServer.inference_server.archived && !inferenceServer.inference_server.archived_at) {
    inferenceServer.inference_server.archived_at = nowIso();
  }
  validateRecord(inferenceServer);
  return createInferenceServer(inferenceServer);
}

export function updateInferenceServerRecord(
  id: string,
  updates: InferenceServerInput
): InferenceServerRecord | null {
  const existing = getInferenceServerById(id);
  if (!existing) {
    return null;
  }
  const { server_id: _serverId, created_at: _createdAt, ...identityUpdates } =
    updates.inference_server ?? {};
  const schemaFamilyList = normalizeSchemaFamilies(
    updates.runtime?.api?.schema_family ?? existing.runtime.api.schema_family
  );
  if (updates.endpoints?.base_url) {
    const { normalized, https } = validateBaseUrl(updates.endpoints.base_url);
    updates.endpoints.base_url = normalized;
    updates.endpoints.https = https;
  }
  const updated: InferenceServerRecord = {
    ...existing,
    inference_server: {
      ...existing.inference_server,
      ...identityUpdates
    },
    endpoints: { ...existing.endpoints, ...updates.endpoints },
    auth: { ...defaultAuth(), ...existing.auth, ...updates.auth },
    runtime: mergeRuntime(existing.runtime, updates.runtime, schemaFamilyList),
    capabilities: mergeCapabilities(existing.capabilities, updates.capabilities),
    discovery: mergeDiscovery(existing.discovery, updates.discovery),
    raw: updates.raw ?? existing.raw
  };

  if (updates.inference_server?.display_name) {
    updated.inference_server.display_name = updates.inference_server.display_name.trim();
  }
  if (updated.inference_server.archived && !updated.inference_server.archived_at) {
    updated.inference_server.archived_at = nowIso();
  }
  if (!updated.inference_server.archived) {
    updated.inference_server.archived_at = null;
  }
  validateRecord(updated);
  return updateInferenceServer(id, updated);
}

export function archiveInferenceServer(id: string): InferenceServerRecord | null {
  const existing = getInferenceServerById(id);
  if (!existing) {
    return null;
  }
  return updateInferenceServerRecord(id, {
    inference_server: { active: false, archived: true, archived_at: nowIso() }
  });
}

export function unarchiveInferenceServer(id: string): InferenceServerRecord | null {
  const existing = getInferenceServerById(id);
  if (!existing) {
    return null;
  }
  return updateInferenceServerRecord(id, {
    inference_server: { archived: false, archived_at: null }
  });
}

export function canDeleteInferenceServer(id: string): { ok: boolean; reason?: string } {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(1) as count FROM runs WHERE inference_server_id = ?')
    .get(id) as {
    count: number;
  };
  if (row.count > 0) {
    return { ok: false, reason: 'Inference server has existing runs' };
  }
  return { ok: true };
}

export function requireInferenceServer(id: string): InferenceServerRecord {
  const server = getInferenceServerById(id);
  if (!server) {
    throw new InferenceServerNotFoundError(id);
  }
  return server;
}
