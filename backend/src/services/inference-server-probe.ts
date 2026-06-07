import { QuantisationDescriptor, extractQuantisationLabel, normaliseQuantisationFromLabel } from './quantisation-normalizer.js';
import { backendFetch } from './inference-proxy.js';

const DEFAULT_TIMEOUT_MS = 5000;

export interface NormalizedProbeModel {
  model_id: string;
  display_name: string | null;
  context_window_tokens: number | null;
  quantisation: QuantisationDescriptor | null;
  provider?: string | null;
  base_model_name?: string | null;
  default_temperature?: number | null;
  capabilities?: Record<string, boolean>;
  raw?: Record<string, unknown>;
}

export interface ProbeParams {
  base_url: string;
  schema_families: string[];
  auth_headers: Record<string, string>;
  timeout_ms?: number;
  parseModels?: boolean; // default true; false = lightweight health check (no model parsing)
}

export interface ProbeResult {
  ok: boolean;
  attempted_url: string | null;
  status_code: number | null;
  response_time_ms: number | null;
  models: NormalizedProbeModel[];
  raw: Record<string, unknown> | null;
  error?: string;
}

function isMistralProvider(provider: string | null | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === 'mistralai' || normalized === 'mistral';
}

function keepCanonicalMistralModels(models: NormalizedProbeModel[]): NormalizedProbeModel[] {
  const kept: NormalizedProbeModel[] = [];
  const seenMistralNames = new Set<string>();
  for (const model of models) {
    if (!isMistralProvider(model.provider)) {
      kept.push(model);
      continue;
    }
    const canonicalName = model.base_model_name?.trim();
    if (!canonicalName || model.model_id !== canonicalName || seenMistralNames.has(canonicalName)) {
      continue;
    }
    seenMistralNames.add(canonicalName);
    kept.push(model);
  }
  return kept;
}

export function normalizeOpenAiModels(payload: Record<string, unknown>): NormalizedProbeModel[] {
  const entries = Array.isArray(payload.data) ? payload.data : [];
  const models = (entries as Record<string, unknown>[])
    .map((entry) => {
      const modelId = typeof entry.id === 'string' ? entry.id : '';
      const provider = typeof entry.owned_by === 'string' && entry.owned_by.trim()
        ? entry.owned_by.trim()
        : null;
      const capabilities = entry.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)
        ? Object.fromEntries(
            Object.entries(entry.capabilities as Record<string, unknown>)
              .filter(([, value]) => typeof value === 'boolean')
          ) as Record<string, boolean>
        : undefined;
      const displayName = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name
        : modelId || null;
      const contextWindow =
        typeof entry.context_window === 'number'
          ? entry.context_window
          : typeof entry.context_length === 'number'
            ? entry.context_length
            : typeof entry.max_context_length === 'number'
              ? entry.max_context_length
              : null;
      const label = modelId ? extractQuantisationLabel(modelId) : null;
      return {
        model_id: modelId,
        display_name: displayName,
        context_window_tokens: contextWindow,
        quantisation: label ? normaliseQuantisationFromLabel(label) : null,
        provider,
        base_model_name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
        default_temperature: typeof entry.default_model_temperature === 'number' ? entry.default_model_temperature : null,
        capabilities,
        raw: entry
      };
    })
    .filter((entry) => entry.model_id && !entry.model_id.startsWith('<remote>/'));
  return keepCanonicalMistralModels(models);
}

export function normalizeOllamaModels(payload: Record<string, unknown>): NormalizedProbeModel[] {
  const entries = Array.isArray(payload.models) ? payload.models : [];
  return (entries as Record<string, unknown>[])
    .map((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : '';
      const details = (entry.details as Record<string, unknown>) ?? {};
      const label =
        typeof details.quantization === 'string'
          ? details.quantization
          : name
            ? extractQuantisationLabel(name)
            : null;
      return {
        model_id: name,
        display_name: name || null,
        context_window_tokens:
          typeof details.context_length === 'number' ? details.context_length : null,
        quantisation: label ? normaliseQuantisationFromLabel(label) : null
      };
    })
    .filter((entry) => entry.model_id);
}

export async function probeServer(params: ProbeParams): Promise<ProbeResult> {
  const { base_url, schema_families, auth_headers } = params;
  const timeoutMs = params.timeout_ms ?? Number(process.env.CONNECTIVITY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  const supportedFamilies = schema_families.filter((f) => f !== 'custom');
  if (supportedFamilies.length === 0) {
    return {
      ok: false,
      attempted_url: base_url,
      status_code: null,
      response_time_ms: null,
      models: [],
      raw: null,
      error: 'No supported schema families'
    };
  }

  const modelMap = new Map<string, NormalizedProbeModel>();
  const rawPayloads: Record<string, unknown> = {};
  const errors: string[] = [];
  let firstAttemptedUrl: string | null = null;
  let lastStatusCode: number | null = null;
  const startedAt = Date.now();

  for (const schemaFamily of supportedFamilies) {
    const path = schemaFamily === 'openai-compatible' ? '/v1/models' : '/api/tags';
    const url = new URL(path, base_url).toString();
    if (!firstAttemptedUrl) firstAttemptedUrl = url;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await backendFetch(url, { method: 'GET', headers: auth_headers, signal: controller.signal });
    } catch (error) {
      errors.push(`${schemaFamily}: ${error instanceof Error ? error.message : 'Network error'}`);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    lastStatusCode = response.status;
    if (!response.ok) {
      errors.push(`${schemaFamily}: HTTP ${response.status}`);
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const body = await response.text();
      errors.push(`${schemaFamily}: expected JSON, got ${contentType || 'unknown'} (${body.slice(0, 200)})`);
      continue;
    }

    if (params.parseModels === false) {
      await response.body?.cancel();
      return {
        ok: true,
        attempted_url: url,
        status_code: response.status,
        response_time_ms: Date.now() - startedAt,
        models: [],
        raw: null
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    rawPayloads[schemaFamily] = payload;
    const normalised = schemaFamily === 'openai-compatible'
      ? normalizeOpenAiModels(payload)
      : normalizeOllamaModels(payload);
    for (const entry of normalised) {
      if (!modelMap.has(entry.model_id)) {
        modelMap.set(entry.model_id, entry);
      }
    }
  }

  const response_time_ms = Date.now() - startedAt;
  const models = Array.from(modelMap.values());

  if (errors.length > 0 && models.length === 0) {
    return {
      ok: false,
      attempted_url: firstAttemptedUrl,
      status_code: lastStatusCode,
      response_time_ms,
      models: [],
      raw: null,
      error: errors.join('; ')
    };
  }

  const raw = supportedFamilies.length === 1
    ? (rawPayloads[supportedFamilies[0]] ?? null) as Record<string, unknown> | null
    : rawPayloads;

  return {
    ok: true,
    attempted_url: firstAttemptedUrl,
    status_code: lastStatusCode,
    response_time_ms,
    models,
    raw
  };
}
