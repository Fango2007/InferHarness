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

export interface BenchmarkFailureSummary {
  failedCount: number;
  totalCount: number;
  categories: string[];
  message: string;
}

interface BenchmarkDocumentLike<TDocument extends Record<string, unknown>> {
  id: string;
  document: TDocument;
}

export function targetKey(target: RunTarget): string {
  return `${target.inference_server_id}\u0000${target.model_id}`;
}

export function findLinkedDatasetManifest<TDataset extends BenchmarkDocumentLike<Record<string, unknown>>>(
  selectedTemplate: BenchmarkDocumentLike<Record<string, unknown>> | null | undefined,
  datasetManifests: TDataset[]
): TDataset | null {
  if (!selectedTemplate) {
    return null;
  }
  const acceptedTemplateIds = new Set([selectedTemplate.id]);
  const documentTemplateId = selectedTemplate.document.template_id;
  if (typeof documentTemplateId === 'string' && documentTemplateId.trim()) {
    acceptedTemplateIds.add(documentTemplateId);
  }

  const matches = datasetManifests.filter((dataset) => {
    const metadata = dataset.document.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }
    const linkedTemplateId = (metadata as Record<string, unknown>).template_id;
    return typeof linkedTemplateId === 'string' && acceptedTemplateIds.has(linkedTemplateId);
  });
  return matches.length === 1 ? matches[0] : null;
}

const FAILURE_METRIC_CATEGORIES: Array<[string, string, (value: unknown) => boolean]> = [
  ['missing_tool_call', 'missing tool call', (value) => value === true],
  ['hallucinated_tool_call', 'unexpected tool call', (value) => value === true],
  ['tool_selected_correctly', 'wrong tool selected', (value) => value === false],
  ['tool_arguments_valid', 'invalid tool arguments', (value) => value === false],
  ['tool_call_assertion_pass', 'tool-call assertion failed', (value) => value === false],
  ['schema_valid', 'schema validation failed', (value) => value === false],
  ['json_valid', 'invalid JSON', (value) => value === false],
  ['exact_match', 'exact match failed', (value) => value === false],
  ['regex_match', 'regex match failed', (value) => value === false]
];

export function summarizeBenchmarkMetricFailures(
  metricResults: Array<Record<string, unknown>> | null | undefined
): BenchmarkFailureSummary | null {
  if (!Array.isArray(metricResults) || metricResults.length === 0) {
    return null;
  }

  const categories = new Set<string>();
  let failedCount = 0;

  for (const row of metricResults) {
    const rowCategories = FAILURE_METRIC_CATEGORIES
      .filter(([metric, , isFailure]) => isFailure(row[metric]))
      .map(([, label]) => label);
    if (rowCategories.length === 0) {
      continue;
    }
    failedCount += 1;
    rowCategories.forEach((category) => categories.add(category));
  }

  if (failedCount === 0) {
    return null;
  }

  const categoryList = Array.from(categories);
  return {
    failedCount,
    totalCount: metricResults.length,
    categories: categoryList,
    message: `functional check failed ${failedCount}/${metricResults.length} items: ${categoryList.join('; ')}`
  };
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
