import type { InferenceServerRecord } from './inference-servers-api.js';
import type { ModelRecord } from './models-api.js';

export const RUN_ACCENTS = [
  '#3776ab',
  '#cb6d1a',
  '#5b8a3a',
  '#8a4a9c',
  '#b85c5c',
  '#3a7a7a',
  '#7a6a3a',
  '#5c5c5c'
] as const;

export interface RunTarget {
  inference_server_id: string;
  model_id: string;
}

export interface RunModelOption extends RunTarget {
  display_name: string;
  server_name: string;
  quantisation: string | null;
  context_window_tokens: number | null;
  source: 'discovery' | 'persisted' | 'merged';
}

export interface AccentedRunTarget extends RunTarget {
  stable_letter: string;
  accent_index: number;
  accent: string;
}

export function targetKey(target: RunTarget): string {
  return `${target.inference_server_id}\u0000${target.model_id}`;
}

export function parseRunTargets(search: URLSearchParams): RunTarget[] {
  const targets = search.getAll('target').flatMap((value) => {
    const separator = value.includes('|') ? '|' : ':';
    const index = value.indexOf(separator);
    if (index <= 0) {
      return [];
    }
    const inferenceServerId = value.slice(0, index).trim();
    const modelId = decodeURIComponent(value.slice(index + 1)).trim();
    return inferenceServerId && modelId ? [{ inference_server_id: inferenceServerId, model_id: modelId }] : [];
  });

  const legacyServerId = search.get('serverId')?.trim();
  const legacyModelId = search.get('modelId')?.trim();
  if (legacyServerId && legacyModelId) {
    targets.unshift({ inference_server_id: legacyServerId, model_id: legacyModelId });
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = targetKey(target);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 8);
}

export function serializeRunTargets(targets: RunTarget[]): URLSearchParams {
  const search = new URLSearchParams();
  for (const target of targets.slice(0, 8)) {
    search.append('target', `${target.inference_server_id}:${encodeURIComponent(target.model_id)}`);
  }
  return search;
}

function formatQuantisation(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : null;
    const bits = typeof record.bits === 'number' ? `${record.bits}b` : null;
    return [method, bits].filter(Boolean).join(' ') || null;
  }
  return null;
}

export function mergeRunModelOptions(
  servers: InferenceServerRecord[],
  models: ModelRecord[]
): RunModelOption[] {
  const options = new Map<string, RunModelOption>();
  const runnableServers = servers.filter((server) => server.inference_server.active && !server.inference_server.archived);
  const runnableServerIds = new Set(runnableServers.map((server) => server.inference_server.server_id));
  const serverNames = new Map(
    runnableServers.map((server) => [
      server.inference_server.server_id,
      server.inference_server.display_name
    ])
  );

  for (const server of runnableServers) {
    const serverId = server.inference_server.server_id;
    for (const model of server.discovery.model_list.normalised ?? []) {
      const option: RunModelOption = {
        inference_server_id: serverId,
        model_id: model.model_id,
        display_name: model.display_name ?? model.model_id,
        server_name: server.inference_server.display_name,
        quantisation: formatQuantisation(model.quantisation),
        context_window_tokens: model.context_window_tokens,
        source: 'discovery'
      };
      options.set(targetKey(option), option);
    }
  }

  for (const record of models) {
    if (
      !runnableServerIds.has(record.model.server_id) ||
      record.model.archived ||
      !record.model.active ||
      record.discovery?.discovery_status === 'absent'
    ) {
      continue;
    }
    const key = targetKey({
      inference_server_id: record.model.server_id,
      model_id: record.model.model_id
    });
    const existing = options.get(key);
    options.set(key, {
      inference_server_id: record.model.server_id,
      model_id: record.model.model_id,
      display_name: record.model.display_name || existing?.display_name || record.model.model_id,
      server_name: serverNames.get(record.model.server_id) ?? existing?.server_name ?? record.model.server_id,
      quantisation:
        formatQuantisation(record.architecture.quantisation) ?? existing?.quantisation ?? null,
      context_window_tokens: record.limits.context_window_tokens ?? existing?.context_window_tokens ?? null,
      source: existing ? 'merged' : 'persisted'
    });
  }

  return Array.from(options.values()).sort((a, b) =>
    `${a.server_name} ${a.display_name}`.localeCompare(`${b.server_name} ${b.display_name}`)
  );
}

export function assignRunAccents(targets: RunTarget[]): AccentedRunTarget[] {
  return targets.slice(0, 8).map((target, index) => ({
    ...target,
    stable_letter: String.fromCharCode(65 + index),
    accent_index: index,
    accent: RUN_ACCENTS[index]
  }));
}
