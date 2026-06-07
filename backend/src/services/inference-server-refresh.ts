import os from 'os';

import { InferenceServerRecord } from '../models/inference-server.js';
import { nowIso } from '../models/repositories.js';
import { updateInferenceServerRecord } from './inference-servers-repository.js';
import { buildInferenceServerAuthHeaders } from './inference-server-auth.js';
import { probeServer } from './inference-server-probe.js';
import { upsertDiscoveredModelRecord, markAbsentServerModels } from './models-repository.js';

export class InferenceServerRefreshError extends Error {
  details: {
    server_id: string;
    attempted_url: string;
    status_code?: number;
    message?: string;
    timestamp: string;
  };

  constructor(details: {
    server_id: string;
    attempted_url: string;
    status_code?: number;
    message?: string;
    timestamp: string;
  }) {
    super(details.message ?? 'Inference server refresh failed');
    this.name = 'InferenceServerRefreshError';
    this.details = details;
  }
}

function parseOsName(platform: string): 'macos' | 'linux' | 'windows' | 'unknown' {
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

function parseOsArch(arch: string): 'arm64' | 'x86_64' | 'unknown' {
  if (arch === 'arm64') {
    return 'arm64';
  }
  if (arch === 'x64') {
    return 'x86_64';
  }
  return 'unknown';
}

export function refreshRuntime(server: InferenceServerRecord): InferenceServerRecord | null {
  const cpuInfo = os.cpus() ?? [];
  const cpuModel = cpuInfo[0]?.model ?? null;
  const cpuCores = cpuInfo.length ? cpuInfo.length : null;
  const updated = updateInferenceServerRecord(server.inference_server.server_id, {
    runtime: {
      ...server.runtime,
      retrieved_at: nowIso(),
      source: 'client',
      platform: {
        os: { name: parseOsName(os.platform()), version: os.release() ?? null, arch: parseOsArch(os.arch()) },
        container: server.runtime.platform.container
      },
      hardware: {
        ...server.runtime.hardware,
        cpu: { model: cpuModel, cores: cpuCores },
        ram_mb: Math.round(os.totalmem() / (1024 * 1024))
      }
    }
  });
  return updated;
}


export async function refreshDiscovery(server: InferenceServerRecord): Promise<InferenceServerRecord> {
  const schemaFamilies = Array.isArray(server.runtime.api.schema_family)
    ? server.runtime.api.schema_family
    : [server.runtime.api.schema_family];
  const supportedFamilies = schemaFamilies.filter((family) => family !== 'custom');
  if (supportedFamilies.length === 0) {
    throw new InferenceServerRefreshError({
      server_id: server.inference_server.server_id,
      attempted_url: server.endpoints.base_url,
      message: 'Discovery not supported for custom schema_family',
      timestamp: nowIso()
    });
  }

  const probeResult = await probeServer({
    base_url: server.endpoints.base_url,
    schema_families: supportedFamilies,
    auth_headers: buildInferenceServerAuthHeaders(server)
  });

  if (!probeResult.ok || probeResult.models.length === 0) {
    throw new InferenceServerRefreshError({
      server_id: server.inference_server.server_id,
      attempted_url: probeResult.attempted_url ?? server.endpoints.base_url,
      status_code: probeResult.status_code ?? undefined,
      message: probeResult.error ?? `Discovery request failed for ${supportedFamilies.join(', ')}`,
      timestamp: nowIso()
    });
  }

  const normalised = probeResult.models;
  const payload = probeResult.raw ?? {};
  const updated = updateInferenceServerRecord(server.inference_server.server_id, {
    discovery: {
      retrieved_at: nowIso(),
      ttl_seconds: server.discovery.ttl_seconds,
      model_list: {
        raw: payload,
        normalised
      }
    }
  });
  if (!updated) {
    throw new InferenceServerRefreshError({
      server_id: server.inference_server.server_id,
      attempted_url: server.endpoints.base_url,
      message: 'Unable to persist discovery response',
      timestamp: nowIso()
    });
  }
  for (const model of normalised) {
    upsertDiscoveredModelRecord({
      server_id: server.inference_server.server_id,
      model_id: model.model_id,
      display_name: model.display_name,
      provider: model.provider,
      base_model_name: model.base_model_name,
      default_temperature: model.default_temperature,
      capabilities: model.capabilities,
      context_window_tokens: model.context_window_tokens,
      quantisation: model.quantisation,
      raw: { discovery_model: model.raw ?? model }
    });
  }
  markAbsentServerModels(
    server.inference_server.server_id,
    new Set(normalised.map((m) => m.model_id))
  );
  return updated;
}
