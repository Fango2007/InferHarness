import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { loadEnv } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '../../..');
const rawEnv = loadEnv(process.env.NODE_ENV ?? 'test', repoRoot, '');
const env = { ...rawEnv, ...process.env };
const API_BASE_URL = env.E2E_API_BASE_URL ?? 'http://localhost:8080';
const API_TOKEN = env.INFERHARNESS_API_TOKEN ?? env.VITE_INFERHARNESS_API_TOKEN;
const authHeaders = API_TOKEN ? { 'x-api-token': API_TOKEN } : undefined;

export interface InferenceServerRecord {
  inference_server: {
    server_id: string;
    display_name: string;
  };
  endpoints: {
    base_url: string;
  };
  runtime: {
    api: {
      schema_family: string[];
    };
    hardware: {
      cpu: { model: string | null; cores: number | null };
      gpu: Array<{ vendor: string; model: string | null; vram_mb: number | null }>;
      ram_mb: number | null;
    };
    platform: {
      os: { name: string; version: string | null; arch: string };
      container: { type: string; image: string | null };
    };
  };
  capabilities: {
    server: { streaming: boolean; models_endpoint: boolean };
    generation: { text: boolean; json_schema_output: boolean; tools: boolean; embeddings: boolean };
    multimodal: {
      vision: { input_images: boolean; output_images: boolean };
      audio: { input_audio: boolean; output_audio: boolean };
    };
    reasoning: { exposed: boolean; token_budget_configurable: boolean };
    concurrency: { parallel_requests: boolean; parallel_tool_calls: boolean; max_concurrent_requests: number | null };
  };
}

export interface ModelRecord {
  model: {
    server_id: string;
    model_id: string;
    display_name: string;
  };
}

async function parseJsonResponse<T>(response: APIResponse, label: string): Promise<T> {
  const contentType = response.headers()['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    const body = await response.text();
    throw new Error(`${label} expected JSON but received ${contentType || 'unknown'}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export async function createInferenceServer(
  request: APIRequestContext,
  overrides?: Partial<{
    display_name: string;
    base_url: string;
    schema_family: string[];
    hardware: { gpu: Array<{ vendor: string; model: string | null; vram_mb: number | null }>; cpu: { model: string | null; cores: number | null }; ram_mb: number | null };
    platform: { os: { name: string; version: string | null; arch: string }; container: { type: string; image: string | null } };
  }>
) {
  const uniqueName = `E2E Server ${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const payload = {
    inference_server: { display_name: overrides?.display_name ?? uniqueName },
    endpoints: { base_url: overrides?.base_url ?? 'http://localhost:11434' },
    runtime: {
      api: { schema_family: overrides?.schema_family ?? ['openai-compatible'], api_version: null },
      ...(overrides?.hardware ? { hardware: overrides.hardware } : {}),
      ...(overrides?.platform ? { platform: overrides.platform } : {}),
    }
  };
  const response = await request.post(`${API_BASE_URL}/inference-servers`, {
    data: payload,
    headers: authHeaders
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`createInferenceServer failed: ${response.status()} ${body}`);
  }
  return parseJsonResponse<InferenceServerRecord>(response, 'createInferenceServer');
}

export async function listInferenceServers(request: APIRequestContext) {
  const response = await request.get(`${API_BASE_URL}/inference-servers`, {
    headers: authHeaders
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`listInferenceServers failed: ${response.status()} ${body}`);
  }
  return parseJsonResponse<InferenceServerRecord[]>(response, 'listInferenceServers');
}

export async function findInferenceServerByName(request: APIRequestContext, name: string) {
  const servers = await listInferenceServers(request);
  return servers.find((server) => server.inference_server.display_name === name) ?? null;
}

export async function archiveInferenceServer(request: APIRequestContext, id: string) {
  const response = await request.post(`${API_BASE_URL}/inference-servers/${id}/archive`, {
    headers: authHeaders
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`archiveInferenceServer failed: ${response.status()} ${body}`);
  }
}

export async function createModel(
  request: APIRequestContext,
  serverId: string,
  overrides?: Partial<{
    model_id: string;
    display_name: string;
    provider: string;
    family: string | null;
    format: string | null;
  }>
) {
  const modelId = overrides?.model_id ?? `e2e-model-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const displayName = overrides?.display_name ?? modelId;
  const response = await request.post(`${API_BASE_URL}/models`, {
    data: {
      model: {
        server_id: serverId,
        model_id: modelId,
        display_name: displayName,
        base_model_name: displayName,
        active: true,
        archived: false
      },
      identity: {
        provider: overrides?.provider ?? 'custom',
        family: overrides?.family ?? null,
        version: null,
        revision: null,
        checksum: null,
        quantized_provider: null
      },
      architecture: {
        format: overrides?.format ?? null
      },
      capabilities: {
        use_case: { thinking: false, coding: false, instruct: true, mixture_of_experts: false }
      }
    },
    headers: authHeaders
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`createModel failed: ${response.status()} ${body}`);
  }
  return parseJsonResponse<ModelRecord>(response, 'createModel');
}

export async function cleanupTemplateIds(
  request: APIRequestContext,
  templateIds: string[]
) {
  if (templateIds.length === 0) {
    return;
  }

  const uniqueTemplateIds = Array.from(new Set(templateIds));
  for (const templateId of uniqueTemplateIds) {
    await request
      .delete(`${API_BASE_URL}/benchmark/documents/test_template/${templateId}`, {
        headers: authHeaders,
        timeout: 5_000
      })
      .catch(() => undefined);
  }
}
