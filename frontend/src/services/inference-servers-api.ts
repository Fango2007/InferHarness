import { apiDelete, apiGet, apiPatch, apiPost } from './api.js';

export type RuntimeSource = 'server' | 'client' | 'mixed';
export type ApiSchemaFamily = 'openai-compatible' | 'ollama' | 'anthropic' | 'gemini' | 'custom';
export type OsName = 'macos' | 'linux' | 'windows' | 'unknown';
export type OsArch = 'arm64' | 'x86_64' | 'unknown';
export type ContainerType = 'docker' | 'podman' | 'none' | 'unknown';
export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'google' | 'unknown';
export type AuthType = 'none' | 'bearer' | 'basic' | 'oauth' | 'custom';

export interface InferenceServerRecord {
  inference_server: {
    server_id: string;
    display_name: string;
    active: boolean;
    archived: boolean;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  };
  runtime: {
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
  };
  endpoints: {
    base_url: string;
    health_url: string | null;
    https: boolean;
  };
  auth: {
    type: AuthType;
    header_name: string;
    token_env: string | null;
    token?: string | null;
    token_present?: boolean;
  };
  capabilities: {
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
    enforcement: 'server';
  };
  discovery: {
    retrieved_at: string;
    ttl_seconds: number;
    model_list: {
      raw: Record<string, unknown>;
      normalised: Array<{
        model_id: string;
        display_name: string | null;
        context_window_tokens: number | null;
        quantisation:
          | {
              method: string;
              bits: number | null;
              group_size: number | null;
              scheme?: string | null;
              variant?: string | null;
              weight_format?: string | null;
            }
          | string
          | null;
        provider?: string | null;
        base_model_name?: string | null;
        default_temperature?: number | null;
        capabilities?: Record<string, boolean>;
        raw?: Record<string, unknown>;
      }>;
    };
  };
  raw: Record<string, unknown>;
}

export interface InferenceServerInput {
  inference_server?: Partial<InferenceServerRecord['inference_server']>;
  runtime?: Partial<InferenceServerRecord['runtime']>;
  endpoints?: Partial<InferenceServerRecord['endpoints']>;
  auth?: Partial<InferenceServerRecord['auth']>;
  capabilities?: Partial<InferenceServerRecord['capabilities']>;
  discovery?: Partial<InferenceServerRecord['discovery']>;
  raw?: Record<string, unknown>;
}

export async function listInferenceServers(filters?: {
  active?: boolean;
  archived?: boolean;
  schema_family?: ApiSchemaFamily;
}): Promise<InferenceServerRecord[]> {
  const params = new URLSearchParams();
  if (filters?.active !== undefined) {
    params.set('active', String(filters.active));
  }
  if (filters?.archived !== undefined) {
    params.set('archived', String(filters.archived));
  }
  if (filters?.schema_family) {
    params.set('schema_family', filters.schema_family);
  }
  const query = params.toString();
  return apiGet<InferenceServerRecord[]>(`/inference-servers${query ? `?${query}` : ''}`);
}

export async function createInferenceServer(input: InferenceServerInput): Promise<InferenceServerRecord> {
  return apiPost<InferenceServerRecord>('/inference-servers', input);
}

export async function updateInferenceServer(
  id: string,
  updates: InferenceServerInput
): Promise<InferenceServerRecord> {
  return apiPatch<InferenceServerRecord>(`/inference-servers/${id}`, updates);
}

export async function archiveInferenceServer(id: string): Promise<InferenceServerRecord> {
  return apiPost<InferenceServerRecord>(`/inference-servers/${id}/archive`, {});
}

export async function unarchiveInferenceServer(id: string): Promise<InferenceServerRecord> {
  return apiPost<InferenceServerRecord>(`/inference-servers/${id}/unarchive`, {});
}

export async function deleteInferenceServer(id: string): Promise<void> {
  await apiDelete(`/inference-servers/${id}`);
}

export async function refreshInferenceServerRuntime(id: string): Promise<InferenceServerRecord> {
  return apiPost<InferenceServerRecord>(`/inference-servers/${id}/refresh-runtime`, {});
}

export async function refreshInferenceServerDiscovery(id: string): Promise<InferenceServerRecord> {
  return apiPost<InferenceServerRecord>(`/inference-servers/${id}/refresh-discovery`, {});
}

export interface ProbeConnectionInput {
  server_id?: string;
  base_url: string;
  schema_family: string[];
  auth: { type: string; header_name: string; token?: string | null; token_env?: string | null };
  timeout_ms?: number;
}

export interface ProbeConnectionResult {
  ok: boolean;
  status_code: number | null;
  response_time_ms: number | null;
  models: string[];
  error: string | null;
}

export async function testServerConnection(input: ProbeConnectionInput): Promise<ProbeConnectionResult> {
  return apiPost<ProbeConnectionResult>('/inference-servers/probe', input);
}
