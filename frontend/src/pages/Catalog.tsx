import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { EmptyState } from '../components/EmptyState.js';
import { HandoffToast, ProgressRibbon } from '../components/Onboarding.js';
import { RegLight } from '../components/RegLight.js';
import { useOnboardingContext } from '../onboarding-context.js';
import { isRibbonDismissed } from '../onboarding.js';
import { catalogSearch, normalizeCatalogTab } from '../navigation.js';
import { InferenceServerHealth } from '../services/connectivity-api.js';
import {
  ApiSchemaFamily,
  AuthType,
  ContainerType,
  GpuVendor,
  InferenceServerInput,
  InferenceServerRecord,
  OsArch,
  OsName,
  archiveInferenceServer,
  createInferenceServer,
  deleteInferenceServer,
  listInferenceServers,
  refreshInferenceServerDiscovery,
  testServerConnection,
  unarchiveInferenceServer,
  updateInferenceServer
} from '../services/inference-servers-api.js';
import { ModelFormat, ModelRecord, listModels } from '../services/models-api.js';
import { relativeTime } from '../utils.js';

type CatalogModel = {
  key: string;
  serverId: string;
  serverName: string;
  serverUrl: string;
  modelId: string;
  displayName: string;
  family: string;
  quantization: string;
  format: string;
  context: string;
  tools: boolean;
  streaming: boolean;
  parameterCount: number | null;
  parameterCountLabel: string | null;
  capabilities: string[];
  filterCapabilities: string[];
  discoveryStatus: 'present' | 'absent' | null;
  sortKey: CatalogModelSortKey;
};

type ServerStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

type DrawerMode = { kind: 'create' } | { kind: 'edit'; server: InferenceServerRecord };
type CatalogModelSortKey = {
  family: string;
  series: string;
  release: number;
  parameterCount: number;
  quantizationRank: number;
  displayName: string;
};
type ProviderPresetId =
  | 'local-manual'
  | 'openai'
  | 'mistral'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'openrouter'
  | 'deepseek'
  | 'xai'
  | 'cerebras';
type ProviderPreset = {
  id: ProviderPresetId;
  label: string;
  providerKind: 'local' | 'cloud';
  displayName: string;
  baseUrl: string;
  software: string;
  version: string;
  schemaFamilies: ApiSchemaFamily[];
  authType: 'none' | 'bearer' | 'header';
  authHeader: string;
  capabilities: {
    streaming: boolean;
    modelsEndpoint: boolean;
    tools: boolean;
    embeddings: boolean;
    jsonSchema: boolean;
    visionInput: boolean;
    audioInput: boolean;
    reasoning: boolean;
    tokenBudget: boolean;
    parallelRequests: boolean;
  };
  platform: {
    gpuVendor: GpuVendor;
    gpuModel: string;
    gpuVramGb: string;
    cpuVendorHint: string;
    cpuModel: string;
    cpuCores: string;
    ramGb: string;
    osName: OsName;
    osVersion: string;
    osArch: OsArch;
    containerType: ContainerType;
    containerImage: string;
  };
};

const SERVER_STAGE_STORAGE_KEY = 'catalog.serverStageCollapsed';
const MODEL_FILTER_STAGE_STORAGE_KEY = 'catalog.modelFilterStageCollapsed';
const MODEL_CAPABILITY_FILTER_OPTIONS = [
  'text',
  'json schema output',
  'tools',
  'embeddings',
  'vision',
  'audio',
  'reasoning',
  'explicit tokens',
  'thinking',
  'coding',
  'instruct',
  'mixture of experts'
];
const MODEL_SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const UNKNOWN_SORT_NUMBER = Number.POSITIVE_INFINITY;
const DEFAULT_CLOUD_PLATFORM: ProviderPreset['platform'] = {
  gpuVendor: 'unknown',
  gpuModel: '',
  gpuVramGb: '',
  cpuVendorHint: 'other',
  cpuModel: '',
  cpuCores: '',
  ramGb: '',
  osName: 'unknown',
  osVersion: '',
  osArch: 'unknown',
  containerType: 'none',
  containerImage: ''
};
const DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES: ProviderPreset['capabilities'] = {
  streaming: true,
  modelsEndpoint: true,
  tools: true,
  embeddings: true,
  jsonSchema: true,
  visionInput: true,
  audioInput: false,
  reasoning: false,
  tokenBudget: false,
  parallelRequests: true
};

function openAiCompatibleCloudPreset(
  id: Exclude<ProviderPresetId, 'local-manual'>,
  label: string,
  baseUrl: string,
  overrides: Partial<ProviderPreset['capabilities']> = {}
): ProviderPreset {
  return {
    id,
    label,
    providerKind: 'cloud',
    displayName: label,
    baseUrl,
    software: label,
    version: '',
    schemaFamilies: ['openai-compatible'],
    authType: 'bearer',
    authHeader: 'Authorization',
    capabilities: { ...DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES, ...overrides },
    platform: DEFAULT_CLOUD_PLATFORM
  };
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'local-manual',
    label: 'Local / custom inference server',
    providerKind: 'local',
    displayName: '',
    baseUrl: '',
    software: '',
    version: '',
    schemaFamilies: ['openai-compatible'],
    authType: 'none',
    authHeader: 'Authorization',
    capabilities: {
      streaming: false,
      modelsEndpoint: false,
      tools: false,
      embeddings: false,
      jsonSchema: false,
      visionInput: false,
      audioInput: false,
      reasoning: false,
      tokenBudget: false,
      parallelRequests: false
    },
    platform: {
      gpuVendor: 'unknown',
      gpuModel: '',
      gpuVramGb: '',
      cpuVendorHint: 'other',
      cpuModel: '',
      cpuCores: '',
      ramGb: '',
      osName: 'unknown',
      osVersion: '',
      osArch: 'unknown',
      containerType: 'none',
      containerImage: ''
    }
  },
  openAiCompatibleCloudPreset('openai', 'OpenAI', 'https://api.openai.com/v1', { reasoning: true, audioInput: true }),
  openAiCompatibleCloudPreset('mistral', 'Mistral', 'https://api.mistral.ai/v1', { reasoning: true }),
  {
    id: 'anthropic' as ProviderPresetId,
    label: 'Anthropic',
    providerKind: 'cloud',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    software: 'Anthropic',
    version: '',
    schemaFamilies: ['anthropic'] as ApiSchemaFamily[],
    authType: 'header' as const,
    authHeader: 'x-api-key',
    capabilities: {
      streaming: true,
      modelsEndpoint: true,
      tools: true,
      embeddings: false,
      jsonSchema: true,
      visionInput: true,
      audioInput: false,
      reasoning: true,
      tokenBudget: true,
      parallelRequests: true
    },
    platform: DEFAULT_CLOUD_PLATFORM
  },
  {
    id: 'gemini' as ProviderPresetId,
    label: 'Google Gemini',
    providerKind: 'cloud',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    software: 'Gemini',
    version: '',
    schemaFamilies: ['gemini'] as ApiSchemaFamily[],
    authType: 'header' as const,
    authHeader: 'x-goog-api-key',
    capabilities: {
      streaming: true,
      modelsEndpoint: true,
      tools: true,
      embeddings: true,
      jsonSchema: true,
      visionInput: true,
      audioInput: true,
      reasoning: true,
      tokenBudget: false,
      parallelRequests: true
    },
    platform: DEFAULT_CLOUD_PLATFORM
  },
  openAiCompatibleCloudPreset('groq', 'Groq', 'https://api.groq.com/openai/v1', { embeddings: false, visionInput: false }),
  openAiCompatibleCloudPreset('together', 'Together AI', 'https://api.together.xyz/v1'),
  openAiCompatibleCloudPreset('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1'),
  openAiCompatibleCloudPreset('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
  openAiCompatibleCloudPreset('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', { embeddings: false, visionInput: false }),
  openAiCompatibleCloudPreset('xai', 'xAI', 'https://api.x.ai/v1', { embeddings: false }),
  openAiCompatibleCloudPreset('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', { embeddings: false, visionInput: false })
];

function parseCsv(value: string | null): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function writeCsv(params: URLSearchParams, key: string, values: Iterable<string>) {
  const list = Array.from(values).filter(Boolean);
  if (list.length) {
    params.set(key, list.join(','));
  } else {
    params.delete(key);
  }
}

function formatParamCount(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e3).toFixed(1)}K`;
}

function formatProvider(provider: string): string {
  if (provider === 'meta') return 'Llama';
  if (provider === 'qwen') return 'Qwen';
  if (provider === 'mistral') return 'Mistral';
  if (provider === 'google') return 'Google';
  if (provider === 'unknown') return 'Custom';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function modelLabel(record: ModelRecord | undefined, modelId: string, displayName: string): string {
  return record?.model.base_model_name?.trim() ?? record?.model.display_name?.trim() ?? (displayName || modelId);
}

function statusFor(server: InferenceServerRecord, health?: InferenceServerHealth): ServerStatus {
  if (server.inference_server.archived || !server.inference_server.active) return 'down';
  if (!health) return 'unknown';
  if (health.ok) return 'healthy';
  return health.response_time_ms != null ? 'degraded' : 'down';
}

function statusLabel(status: ServerStatus): string {
  switch (status) {
    case 'healthy':
      return 'online';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    default:
      return 'unknown';
  }
}

function statusToRegLight(status: ServerStatus): 'healthy' | 'degraded' | 'down' | 'unknown' {
  return status;
}


function gpuLabel(server: InferenceServerRecord): string {
  const labels = server.runtime.hardware.gpu
    .map((gpu) => [gpu.model, gpu.vram_mb ? `${Math.round(gpu.vram_mb / 1024)}GB` : null].filter(Boolean).join(' · '))
    .filter(Boolean);
  return labels.join(', ') || 'GPU unknown';
}

function runtimeLabel(server: InferenceServerRecord): string {
  const name = server.runtime.server_software.name || 'unknown';
  const version = server.runtime.server_software.version;
  return version ? `${name} · ${version}` : name;
}

function visibleModelPills(model: CatalogModel): string[] {
  return [
    model.family,
    model.quantization,
    model.format,
    model.context,
    model.parameterCountLabel
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().toLowerCase() !== 'unknown');
}

function normalizeSortText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_/]+/g, '-')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parameterCountFromText(text: string): number | null {
  const match = text.match(/\b(\d+(?:\.\d+)?)(b|bn|billion|m|million)\b/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  return value * (unit.startsWith('b') ? 1_000_000_000 : 1_000_000);
}

function quantizationRank(text: string): number {
  const normalized = text.toLowerCase();
  if (/\b(?:bf16|fp16|f16)\b/.test(normalized)) return 16;
  if (/\bfp32\b/.test(normalized)) return 32;
  const bitMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*-?\s*bit\b/);
  if (bitMatch) {
    const value = Number.parseFloat(bitMatch[1]);
    return Number.isFinite(value) ? value : 0;
  }
  const qMatch = normalized.match(/\bq(\d+(?:\.\d+)?)/);
  if (qMatch) {
    const value = Number.parseFloat(qMatch[1]);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

function releaseKey(providerFamily: string, text: string): number {
  if (providerFamily === 'Mistral') {
    const dateTokens = Array.from(text.matchAll(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/g))
      .map((match) => match[1])
      .filter((token) => {
        const month = Number.parseInt(token.slice(2), 10);
        return month >= 1 && month <= 12;
      });
    const latest = dateTokens.length ? dateTokens[dateTokens.length - 1] : null;
    if (latest) {
      return (2000 + Number.parseInt(latest.slice(0, 2), 10)) * 100 + Number.parseInt(latest.slice(2), 10);
    }
  }

  if (providerFamily === 'Qwen') {
    const qwenVersion = text.match(/\bqwen\s*-?\s*(\d+(?:\.\d+)?)/i);
    if (qwenVersion) {
      const value = Number.parseFloat(qwenVersion[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  return 0;
}

function modelSeriesName(providerFamily: string, text: string): string {
  let series = text
    .replace(/^\/?[^/]+\//, '')
    .replace(/\b(20)?\d{2}(0[1-9]|1[0-2])\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:b|bn|billion|m|million)\b/gi, ' ')
    .replace(/\ba\d+(?:\.\d+)?\s*(?:b|bn|billion|m|million)\b/gi, ' ')
    .replace(/\b(?:mlx|gguf|gcuf|gptq|awq|safetensors|bf16|fp16|fp32|int4|int8)\b/gi, ' ')
    .replace(/\bq\d+(?:_k_[sml]|_[0-3])?\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*-?\s*bit\b/gi, ' ')
    .replace(/\b(?:instruct|chat)\b/gi, ' ');

  if (providerFamily === 'Qwen') {
    series = series.replace(/\bqwen\s*-?\s*\d+(?:\.\d+)?/i, 'qwen ');
  }

  return normalizeSortText(series) || normalizeSortText(text);
}

function buildModelSortKey(record: ModelRecord | undefined, model: {
  family: string;
  displayName: string;
  modelId: string;
  quantization: string;
  parameterCount: number | null;
  parameterCountLabel: string | null;
}): CatalogModelSortKey {
  const sourceText = [
    record?.model.base_model_name,
    record?.model.model_id,
    model.displayName,
    model.modelId
  ].filter(Boolean).join(' ');
  const parameterCount =
    model.parameterCount
    ?? parameterCountFromText(model.parameterCountLabel ?? '')
    ?? parameterCountFromText(sourceText)
    ?? UNKNOWN_SORT_NUMBER;

  return {
    family: normalizeSortText(model.family),
    series: modelSeriesName(model.family, sourceText),
    release: releaseKey(model.family, sourceText),
    parameterCount,
    quantizationRank: quantizationRank(model.quantization),
    displayName: normalizeSortText(model.displayName)
  };
}

function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  return (
    MODEL_SORT_COLLATOR.compare(a.sortKey.family, b.sortKey.family)
    || MODEL_SORT_COLLATOR.compare(a.sortKey.series, b.sortKey.series)
    || a.sortKey.release - b.sortKey.release
    || a.sortKey.parameterCount - b.sortKey.parameterCount
    || b.sortKey.quantizationRank - a.sortKey.quantizationRank
    || MODEL_SORT_COLLATOR.compare(a.sortKey.displayName, b.sortKey.displayName)
    || MODEL_SORT_COLLATOR.compare(a.modelId, b.modelId)
  );
}

function buildCatalogModels(servers: InferenceServerRecord[], modelRecords: ModelRecord[]): CatalogModel[] {
  const recordMap = new Map(modelRecords.map((record) => [`${record.model.server_id}:${record.model.model_id}`, record]));
  const entries = new Map<string, CatalogModel>();
  const put = (server: InferenceServerRecord, modelId: string, displayName: string, context: number | null, quantLabel?: string | null) => {
    const record = recordMap.get(`${server.inference_server.server_id}:${modelId}`);
    const label = modelLabel(record, modelId, displayName);
    const format = record?.architecture.format ?? 'Unknown';
    const quantization =
      record?.architecture.quantisation.weight_format
      ?? (record?.architecture.quantisation.bits ? `${record.architecture.quantisation.bits}-bit` : null)
      ?? (record?.architecture.precision && record.architecture.precision !== 'unknown' ? record.architecture.precision.toUpperCase() : null)
      ?? (record ? quantLabel : null)
      ?? 'Unknown';
    const parameterCount = record?.architecture.parameter_count ?? null;
    const parameterCountLabel = record?.architecture.parameter_count_label ?? null;
    const displayCapabilityLabels = record
      ? [
          record.capabilities.generation.tools ? 'tools' : null,
          record.capabilities.generation.embeddings ? 'embeddings' : null,
          record.capabilities.multimodal.vision ? 'vision' : null,
          record.capabilities.multimodal.audio ? 'audio' : null,
          record.capabilities.reasoning.supported ? 'reasoning' : null
        ].filter((entry): entry is string => Boolean(entry))
      : [];
    const key = `${server.inference_server.server_id}:${modelId}`;
    entries.set(key, {
      key,
      serverId: server.inference_server.server_id,
      serverName: server.inference_server.display_name,
      serverUrl: server.endpoints.base_url,
      modelId,
      displayName: label,
      family: formatProvider(record?.identity.provider ?? 'unknown'),
      quantization,
      format,
      context: (record?.limits.context_window_tokens ?? context) ? `${record?.limits.context_window_tokens ?? context} ctx` : 'ctx unknown',
      tools: record?.capabilities.generation.tools ?? server.capabilities.generation.tools,
      streaming: server.capabilities.server.streaming,
      parameterCount,
      parameterCountLabel,
      capabilities: record
        ? [
            ...Object.entries(record.capabilities.use_case)
            .filter(([, v]) => v)
            .map(([k]) => k.replace(/_/g, ' ')),
            ...displayCapabilityLabels
          ]
        : [],
      filterCapabilities: record
        ? [
            record.capabilities.generation.text ? 'text' : null,
            record.capabilities.generation.json_schema_output ? 'json schema output' : null,
            record.capabilities.generation.tools ? 'tools' : null,
            record.capabilities.generation.embeddings ? 'embeddings' : null,
            record.capabilities.multimodal.vision ? 'vision' : null,
            record.capabilities.multimodal.audio ? 'audio' : null,
            record.capabilities.reasoning.supported ? 'reasoning' : null,
            record.capabilities.reasoning.explicit_tokens ? 'explicit tokens' : null,
            ...Object.entries(record.capabilities.use_case)
              .filter(([, v]) => v)
              .map(([k]) => k.replace(/_/g, ' '))
          ].filter((entry): entry is string => Boolean(entry))
        : [],
      discoveryStatus: record?.discovery?.discovery_status ?? null,
      sortKey: buildModelSortKey(record, { family: formatProvider(record?.identity.provider ?? 'unknown'), displayName: label, modelId, quantization, parameterCount, parameterCountLabel })
    });
  };

  for (const server of servers) {
    for (const model of server.discovery.model_list.normalised) {
      if (!model.model_id) continue;
      const quantLabel = typeof model.quantisation === 'string'
        ? model.quantisation
        : model.quantisation?.weight_format ?? (model.quantisation?.bits ? `${model.quantisation.bits}-bit` : null);
      put(server, model.model_id, model.display_name ?? model.model_id, model.context_window_tokens, quantLabel);
    }
  }

  for (const record of modelRecords) {
    const server = servers.find((candidate) => candidate.inference_server.server_id === record.model.server_id);
    if (!server) continue;
    put(server, record.model.model_id, record.model.display_name, record.limits.context_window_tokens);
  }

  return Array.from(entries.values()).sort(compareCatalogModels);
}

function toggleSetValue(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

export function Catalog({
  serversSnapshot,
  connectivitySnapshot
}: {
  serversSnapshot: InferenceServerRecord[];
  connectivitySnapshot: Record<string, InferenceServerHealth>;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const onboarding = useOnboardingContext();
  const activeTab = normalizeCatalogTab(searchParams.get('tab'));
  const inspectorServerId = searchParams.get('serverId');
  const inspectorModelId = searchParams.get('modelId');
  const healthView = activeTab === 'servers' && searchParams.get('view') === 'health';
  const onboardingHandoff = searchParams.get('onboarding');

  const [servers, setServers] = useState<InferenceServerRecord[]>(serversSnapshot);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [connectivity, setConnectivity] = useState<Record<string, InferenceServerHealth>>(connectivitySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [onboardingCancelNotice, setOnboardingCancelNotice] = useState<string | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [serverFiltersOpen, setServerFiltersOpen] = useState(false);
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);
  const [serverStageCollapsed, setServerStageCollapsed] = useState(() => localStorage.getItem(SERVER_STAGE_STORAGE_KEY) === 'true');
  const [serverFilters, setServerFilters] = useState({ status: new Set<string>(), runtime: new Set<string>(), gpu: new Set<string>() });

  const selectedServers = useMemo(() => new Set(parseCsv(searchParams.get('servers'))), [searchParams]);
  const selectedFamilies = useMemo(() => new Set(parseCsv(searchParams.get('family'))), [searchParams]);
  const selectedQuantizations = useMemo(() => new Set(parseCsv(searchParams.get('quantization'))), [searchParams]);
  const selectedFormats = useMemo(() => new Set(parseCsv(searchParams.get('format'))), [searchParams]);
  const selectedCapabilities = useMemo(() => new Set(parseCsv(searchParams.get('capabilities'))), [searchParams]);
  const autoSelectedModelServer = useMemo(() => {
    return servers.find((server) => server.inference_server.active && !server.inference_server.archived)
      ?? servers.find((server) => !server.inference_server.archived)
      ?? servers[0]
      ?? null;
  }, [servers]);
  const maxParamCount = useMemo(() => {
    const v = searchParams.get('maxParams');
    return v !== null ? Number(v) : null;
  }, [searchParams]);

  useEffect(() => {
    if (activeTab !== 'models' || !inspectorServerId || !inspectorModelId) return;
    navigate({
      pathname: `/catalog/models/${encodeURIComponent(inspectorModelId)}`,
      search: `?serverId=${encodeURIComponent(inspectorServerId)}`
    }, { replace: true });
  }, [activeTab, inspectorModelId, inspectorServerId, navigate]);

  useEffect(() => {
    if (activeTab !== 'models' || inspectorServerId || inspectorModelId || searchParams.has('servers') || !autoSelectedModelServer) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'models');
    next.set('servers', autoSelectedModelServer.inference_server.server_id);
    setSearchParams(next, { replace: true });
  }, [activeTab, autoSelectedModelServer, inspectorModelId, inspectorServerId, searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('startOnboarding') !== '1') {
      return;
    }
    setDrawer({ kind: 'create' });
  }, [searchParams]);

  async function refreshData(showLoading = false) {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [serverRows, modelRows] = await Promise.all([
        listInferenceServers(),
        listModels()
      ]);
      setServers(serverRows);
      setModels(modelRows);
      setSelectedDetailId((current) => current && serverRows.some((server) => server.inference_server.server_id === current)
        ? current
        : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load catalog');
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    refreshData(true);
    const intervalId = window.setInterval(() => refreshData(false), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => setServers(serversSnapshot), [serversSnapshot]);
  useEffect(() => setConnectivity(connectivitySnapshot), [connectivitySnapshot]);

  useEffect(() => {
    if (searchParams.get('tab') === activeTab) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', activeTab);
    setSearchParams(next, { replace: true });
  }, [activeTab, searchParams, setSearchParams]);

  useEffect(() => {
    localStorage.setItem(SERVER_STAGE_STORAGE_KEY, String(serverStageCollapsed));
  }, [serverStageCollapsed]);

  const catalogModels = useMemo(() => buildCatalogModels(servers, models), [servers, models]);
  const reachable = servers.filter((server) => connectivity[server.inference_server.server_id]?.ok).length;
  const selectedServerRows = servers.filter((server) => selectedServers.has(server.inference_server.server_id));

  const runtimeOptions = useMemo(() => Array.from(new Set(servers.map(runtimeLabel))).sort(), [servers]);
  const gpuOptions = useMemo(() => Array.from(new Set(servers.map(gpuLabel))).sort(), [servers]);
  const familyOptions = useMemo(() => Array.from(new Set(catalogModels.filter((model) => selectedServers.has(model.serverId)).map((model) => model.family))).sort(), [catalogModels, selectedServers]);
  const quantizationOptions = useMemo(() => Array.from(new Set(catalogModels.filter((model) => selectedServers.has(model.serverId)).map((model) => model.quantization))).sort(), [catalogModels, selectedServers]);
  const formatOptions = useMemo(() => Array.from(new Set(catalogModels.filter((model) => selectedServers.has(model.serverId)).map((model) => model.format))).sort(), [catalogModels, selectedServers]);
  const capabilityOptions = MODEL_CAPABILITY_FILTER_OPTIONS;
  const paramCountSteps = useMemo(() => {
    const counts = catalogModels
      .filter((m) => selectedServers.has(m.serverId) && m.parameterCount !== null)
      .map((m) => m.parameterCount as number);
    return Array.from(new Set(counts)).sort((a, b) => a - b);
  }, [catalogModels, selectedServers]);

  const filteredServers = useMemo(() => {
    return servers.filter((server) => {
      if (server.inference_server.archived !== showArchivedOnly) return false;
      const status = statusFor(server, connectivity[server.inference_server.server_id]);
      if (serverFilters.status.size && !serverFilters.status.has(status)) return false;
      if (serverFilters.runtime.size && !serverFilters.runtime.has(runtimeLabel(server))) return false;
      if (serverFilters.gpu.size && !serverFilters.gpu.has(gpuLabel(server))) return false;
      return true;
    });
  }, [connectivity, serverFilters, servers, showArchivedOnly]);
  const selectedDetail = filteredServers.find((server) => server.inference_server.server_id === selectedDetailId) ?? null;
  const showServerSavedHandoff =
    onboarding?.status.active === true &&
    onboardingHandoff === 'server-saved' &&
    !isRibbonDismissed(onboarding.uiState, 'server-saved');

  useEffect(() => {
    if (!selectedDetailId || activeTab !== 'servers') return;
    if (filteredServers.some((server) => server.inference_server.server_id === selectedDetailId)) return;
    setSelectedDetailId(null);
  }, [activeTab, filteredServers, selectedDetailId]);

  const visibleModels = useMemo(() => {
    if (selectedServers.size === 0) return [];
    return catalogModels.filter((model) => {
      if (!selectedServers.has(model.serverId)) return false;
      if (selectedFamilies.size && !selectedFamilies.has(model.family)) return false;
      if (selectedQuantizations.size && !selectedQuantizations.has(model.quantization)) return false;
      if (selectedFormats.size && !selectedFormats.has(model.format)) return false;
      if (selectedCapabilities.size && !model.filterCapabilities.some((c) => selectedCapabilities.has(c))) return false;
      if (maxParamCount !== null && model.parameterCount !== null && model.parameterCount > maxParamCount) return false;
      return true;
    });
  }, [catalogModels, maxParamCount, selectedCapabilities, selectedFamilies, selectedFormats, selectedQuantizations, selectedServers]);

  function updateQuery(mutator: (params: URLSearchParams) => void, replace = false) {
    const next = new URLSearchParams(searchParams);
    mutator(next);
    setSearchParams(next, { replace });
  }

  function toggleServerSelection(serverId: string) {
    const next = toggleSetValue(selectedServers, serverId);
    updateQuery((params) => {
      params.set('tab', 'models');
      writeCsv(params, 'servers', next);
    });
  }

  function toggleModelFilter(key: 'family' | 'quantization' | 'format' | 'capabilities', value: string) {
    const current = key === 'family' ? selectedFamilies
      : key === 'quantization' ? selectedQuantizations
      : key === 'format' ? selectedFormats
      : selectedCapabilities;
    const nextSet = toggleSetValue(current, value);
    updateQuery((params) => writeCsv(params, key, nextSet));
  }

  function setMaxParamFilter(value: number | null) {
    updateQuery((params) => {
      if (value === null) params.delete('maxParams');
      else params.set('maxParams', String(value));
    });
  }

  function changeTab(tab: string) {
    updateQuery((params) => {
      params.set('tab', tab);
      params.delete('view');
      params.delete('serverId');
      params.delete('modelId');
    });
  }

  function notifyServersUpdated() {
    window.dispatchEvent(new CustomEvent('inference-servers:updated'));
  }

  function closeDrawer() {
    const cancellingOnboardingServer =
      drawer?.kind === 'create' &&
      searchParams.get('startOnboarding') === '1' &&
      onboarding?.status.active === true;
    setDrawer(null);
    if (!cancellingOnboardingServer) {
      return;
    }
    onboarding.dismissSetup();
    setOnboardingCancelNotice('Onboarding stopped. No server was created, and the app is back in normal mode.');
    updateQuery((params) => {
      params.delete('startOnboarding');
      params.delete('onboarding');
    }, true);
  }

  function useFirstVisibleModel() {
    const model = visibleModels.find((entry) => entry.discoveryStatus !== 'absent');
    if (!model) {
      updateQuery((params) => {
        params.set('tab', 'models');
        if (servers[0]) writeCsv(params, 'servers', [servers[0].inference_server.server_id]);
      });
      return;
    }
    onboarding.dismissRibbon('server-saved');
    const params = new URLSearchParams();
    params.set('target', `${model.serverId}:${encodeURIComponent(model.modelId)}`);
    navigate({ pathname: '/run', search: `?${params.toString()}` });
  }

  async function handleDelete(server: InferenceServerRecord) {
    if (!window.confirm(`Delete inference server "${server.inference_server.display_name}"? This cannot be undone.`)) return;
    await deleteInferenceServer(server.inference_server.server_id);
    setDrawer(null);
    notifyServersUpdated();
    await refreshData();
  }

  return (
    <>
      <MergedPageHeader
        title="Catalog"
        subtitle={`Servers and models · ${reachable} reachable · ${catalogModels.length} models discovered`}
        tabs={[
          { id: 'servers', label: 'Servers', sub: `${servers.length}` },
          { id: 'models', label: 'Models', sub: `${catalogModels.length}` }
        ]}
        activeTab={activeTab}
        onTabChange={changeTab}
      />
      {onboardingCancelNotice ? (
        <div className="catalog-notice" role="status">
          <span>{onboardingCancelNotice}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOnboardingCancelNotice(null)}>Dismiss</button>
        </div>
      ) : null}
      {showServerSavedHandoff ? (
        <ProgressRibbon
          id="server-saved"
          step={1}
          doneLabel="server saved · model discovery complete"
          fact={`${catalogModels.length} models discovered`}
          nextLabel="Use first available model"
          onNext={useFirstVisibleModel}
          onDismiss={onboarding.dismissRibbon}
        />
      ) : null}
      {error ? <div className="catalog-error error">{error}</div> : null}
      {loading ? <p className="catalog-loading muted">Loading catalog...</p> : null}
      {activeTab === 'servers' ? (
        healthView ? (
          <ServersHealthPanel servers={servers} connectivity={connectivity} />
        ) : (
          <ServersCatalog
            servers={filteredServers}
            allServers={servers}
            connectivity={connectivity}
            selectedDetail={selectedDetail}
            selectedDetailId={selectedDetailId}
            runtimeOptions={runtimeOptions}
            gpuOptions={gpuOptions}
            serverFilters={serverFilters}
            serverFiltersOpen={serverFiltersOpen}
            showArchivedOnly={showArchivedOnly}
            setServerFilters={setServerFilters}
            onToggleServerFilters={() => setServerFiltersOpen((current) => !current)}
            onToggleArchivedOnly={() => setShowArchivedOnly((current) => !current)}
            onSelectDetail={setSelectedDetailId}
            onEdit={(server) => setDrawer({ kind: 'edit', server })}
            onArchive={async (server) => {
              const nextArchivedState = !server.inference_server.archived;
              if (server.inference_server.archived) {
                await unarchiveInferenceServer(server.inference_server.server_id);
              } else {
                await archiveInferenceServer(server.inference_server.server_id);
              }
              notifyServersUpdated();
              await refreshData();
              setShowArchivedOnly(nextArchivedState);
              setSelectedDetailId(server.inference_server.server_id);
            }}
            onAdd={() => setDrawer({ kind: 'create' })}
            onReprobe={async (serverId) => {
              await refreshInferenceServerDiscovery(serverId);
              await refreshData();
            }}
            onRefreshAll={async () => {
              await Promise.allSettled(
                servers
                  .filter((s) => !s.inference_server.archived && s.inference_server.active)
                  .map((s) => refreshInferenceServerDiscovery(s.inference_server.server_id))
              );
              await refreshData();
            }}
          />
        )
      ) : (
        <ModelsCatalog
          servers={servers}
          selectedServers={selectedServers}
          selectedServerRows={selectedServerRows}
          visibleModels={visibleModels}
          allModelCount={catalogModels.length}
          familyOptions={familyOptions}
          quantizationOptions={quantizationOptions}
          formatOptions={formatOptions}
          selectedFamilies={selectedFamilies}
          selectedQuantizations={selectedQuantizations}
          selectedFormats={selectedFormats}
          serverStageCollapsed={serverStageCollapsed}
          setServerStageCollapsed={setServerStageCollapsed}
          onToggleServer={toggleServerSelection}
          onClearServers={() => updateQuery((params) => {
            params.set('servers', '');
            params.delete('family');
            params.delete('quantization');
            params.delete('format');
            params.delete('capabilities');
            params.delete('maxParams');
          })}
          onToggleFilter={toggleModelFilter}
          onClearModelFilters={() => updateQuery((params) => {
            params.delete('family');
            params.delete('quantization');
            params.delete('format');
            params.delete('capabilities');
            params.delete('maxParams');
          })}
          selectedCapabilities={selectedCapabilities}
          maxParamCount={maxParamCount}
          paramCountSteps={paramCountSteps}
          capabilityOptions={capabilityOptions}
          onToggleCapability={(v) => toggleModelFilter('capabilities', v)}
          onSetMaxParam={setMaxParamFilter}
          onInspect={(serverId, modelId) => navigate({ pathname: `/catalog/models/${encodeURIComponent(modelId)}`, search: `?serverId=${encodeURIComponent(serverId)}` })}
          onUseModel={(serverId, modelId) => {
            const params = new URLSearchParams();
            params.set('target', `${serverId}:${encodeURIComponent(modelId)}`);
            navigate({ pathname: '/run', search: `?${params.toString()}` });
          }}
        />
      )}
      {showServerSavedHandoff ? (
        <HandoffToast
          title="Server saved"
          body={`${catalogModels.length} models are ready. Continue with the first available model, or choose another from the list.`}
          primary="Use first available model"
          secondary="Stay here"
          onPrimary={useFirstVisibleModel}
          onSecondary={() => onboarding.dismissRibbon('server-saved')}
          onDismiss={() => onboarding.dismissRibbon('server-saved')}
        />
      ) : null}
      {drawer ? (
        <ServerDrawer
          mode={drawer}
          onClose={() => setDrawer(null)}
          onCancel={closeDrawer}
          onDelete={drawer.kind === 'edit' ? () => handleDelete(drawer.server) : undefined}
          onSaved={async (server, openModels) => {
            setOnboardingCancelNotice(null);
            notifyServersUpdated();
            await refreshData();
            if (openModels || searchParams.get('startOnboarding') === '1') {
              updateQuery((params) => {
                params.set('tab', 'models');
                params.set('onboarding', 'server-saved');
                params.delete('startOnboarding');
                writeCsv(params, 'servers', [server.inference_server.server_id]);
              });
            }
          }}
        />
      ) : null}
    </>
  );
}

function FilterGroup({ title, options, selected, onToggle }: { title: string; options: string[]; selected: Set<string>; onToggle: (value: string) => void }) {
  return (
    <div className="catalog-filter-group">
      <div className="label--uppercase">{title}</div>
      {options.length === 0 ? <p className="muted">No values</p> : null}
      {options.map((option) => (
        <label key={option} className="catalog-checkbox">
          <input type="checkbox" checked={selected.has(option)} onChange={() => onToggle(option)} />
          <span>{option}</span>
        </label>
      ))}
    </div>
  );
}

function ParameterSlider({ steps, value, onChange }: { steps: number[]; value: number | null; onChange: (v: number | null) => void }) {
  if (steps.length === 0) return null;
  const max = steps.length - 1;
  let currentIdx = max;
  if (value !== null) {
    for (let i = 0; i <= max; i++) {
      if (steps[i] <= value) currentIdx = i;
    }
  }
  const label = currentIdx === max ? 'All' : `≤ ${formatParamCount(steps[currentIdx])}`;
  return (
    <div className="catalog-filter-group">
      <div className="catalog-param-slider-header">
        <div className="label--uppercase">Parameters</div>
        <span className="catalog-param-slider-label">{label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={currentIdx}
        onChange={(e) => {
          const idx = Number(e.target.value);
          onChange(idx === max ? null : steps[idx]);
        }}
      />
    </div>
  );
}

function ServersCatalog(props: {
  servers: InferenceServerRecord[];
  allServers: InferenceServerRecord[];
  connectivity: Record<string, InferenceServerHealth>;
  selectedDetail: InferenceServerRecord | null;
  selectedDetailId: string | null;
  runtimeOptions: string[];
  gpuOptions: string[];
  serverFilters: { status: Set<string>; runtime: Set<string>; gpu: Set<string> };
  serverFiltersOpen: boolean;
  showArchivedOnly: boolean;
  setServerFilters: (filters: { status: Set<string>; runtime: Set<string>; gpu: Set<string> }) => void;
  onToggleServerFilters: () => void;
  onToggleArchivedOnly: () => void;
  onSelectDetail: (serverId: string | null) => void;
  onEdit: (server: InferenceServerRecord) => void;
  onArchive: (server: InferenceServerRecord) => void;
  onAdd: () => void;
  onReprobe: (serverId: string) => Promise<void>;
  onRefreshAll: () => Promise<void>;
}) {
  const [reprobingIds, setReprobingIds] = useState<Set<string>>(new Set());
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  if (props.allServers.length === 0) {
    return <NoServersState onAdd={props.onAdd} />;
  }
  return (
    <section className={`catalog-page catalog-servers ${props.serverFiltersOpen ? 'has-filters' : ''} ${props.selectedDetail ? 'has-detail' : ''}`}>
      {props.serverFiltersOpen ? (
        <aside className="catalog-rail">
          <FilterGroup
            title="Status"
            options={['healthy', 'degraded', 'down', 'unknown']}
            selected={props.serverFilters.status}
            onToggle={(value) => props.setServerFilters({ ...props.serverFilters, status: toggleSetValue(props.serverFilters.status, value) })}
          />
          <FilterGroup
            title="Runtime"
            options={props.runtimeOptions}
            selected={props.serverFilters.runtime}
            onToggle={(value) => props.setServerFilters({ ...props.serverFilters, runtime: toggleSetValue(props.serverFilters.runtime, value) })}
          />
          <FilterGroup
            title="GPU"
            options={props.gpuOptions}
            selected={props.serverFilters.gpu}
            onToggle={(value) => props.setServerFilters({ ...props.serverFilters, gpu: toggleSetValue(props.serverFilters.gpu, value) })}
          />
        </aside>
      ) : null}
      <main className="catalog-main">
        <div className="catalog-section-title">
          <div>
            <h2>Inference servers</h2>
            <p>{props.servers.length} shown · {props.allServers.filter((server) => !server.inference_server.archived).length} active · {props.allServers.filter((server) => server.inference_server.archived).length} archived</p>
          </div>
          <div className="catalog-section-actions">
            <button type="button" className={`btn btn--ghost btn--sm ${props.serverFiltersOpen ? 'is-active' : ''}`} onClick={props.onToggleServerFilters}>Filter</button>
            <button type="button" className={`btn btn--ghost btn--sm ${props.showArchivedOnly ? 'is-active' : ''}`} onClick={props.onToggleArchivedOnly}>Archived</button>
            <button type="button" className="btn btn--sm" onClick={props.onAdd}>+ Add server</button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh all servers"
              title="Refresh all servers"
              disabled={isRefreshingAll}
              onClick={async () => {
                setIsRefreshingAll(true);
                try { await props.onRefreshAll(); }
                finally { setIsRefreshingAll(false); }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="1 20 1 14 7 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
        {props.servers.length === 0 ? (
          <div className="catalog-empty">
            <EmptyState
              title={props.showArchivedOnly ? 'No archived servers' : 'No matching servers'}
              body={props.showArchivedOnly ? 'Archived servers appear here when they are available.' : 'Adjust the server filters to show more entries.'}
            />
          </div>
        ) : (
          <div className="catalog-server-grid">
            {props.servers.map((server) => {
              const status = statusFor(server, props.connectivity[server.inference_server.server_id]);
              return (
                <div
                  key={server.inference_server.server_id}
                  role="button"
                  tabIndex={0}
                  className={`catalog-server-card ${props.selectedDetailId === server.inference_server.server_id ? 'is-selected' : ''}`}
                  aria-pressed={props.selectedDetailId === server.inference_server.server_id}
                  onClick={() => props.onSelectDetail(props.selectedDetailId === server.inference_server.server_id ? null : server.inference_server.server_id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectDetail(props.selectedDetailId === server.inference_server.server_id ? null : server.inference_server.server_id); } }}
                >
                  <span className="catalog-card-top">
                    <strong>{server.inference_server.display_name}</strong>
                    <RegLight
                      state={statusToRegLight(status)}
                      label={statusLabel(status)}
                      latencyMs={props.connectivity[server.inference_server.server_id]?.response_time_ms}
                      lastProbe={props.connectivity[server.inference_server.server_id]?.checked_at ?? server.discovery.retrieved_at}
                      statusCode={props.connectivity[server.inference_server.server_id]?.status_code}
                      error={props.connectivity[server.inference_server.server_id]?.error}
                    />
                  </span>
                  <span className="catalog-url">{server.endpoints.base_url}</span>
                  <span className="catalog-card-meta">
                    <span>{runtimeLabel(server)}</span>
                    <span className="catalog-pill">{gpuLabel(server)}</span>
                  </span>
                  <span className="catalog-card-footer">
                    <span>{server.discovery.model_list.normalised.length} models</span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Refresh models"
                      title="Refresh models"
                      disabled={reprobingIds.has(server.inference_server.server_id)}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const id = server.inference_server.server_id;
                        setReprobingIds((prev) => new Set(prev).add(id));
                        try { await props.onReprobe(id); }
                        finally { setReprobingIds((prev) => { const next = new Set(prev); next.delete(id); return next; }); }
                      }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <polyline points="23 4 23 10 17 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points="1 20 1 14 7 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </main>
      {props.selectedDetail ? (
        <aside className="catalog-detail-rail">
          <div className="panel-header">
            <h3>{props.selectedDetail.inference_server.display_name}</h3>
            <RegLight
              state={statusToRegLight(statusFor(props.selectedDetail, props.connectivity[props.selectedDetail.inference_server.server_id]))}
              label={statusLabel(statusFor(props.selectedDetail, props.connectivity[props.selectedDetail.inference_server.server_id]))}
              compact
              latencyMs={props.connectivity[props.selectedDetail.inference_server.server_id]?.response_time_ms}
              lastProbe={props.connectivity[props.selectedDetail.inference_server.server_id]?.checked_at ?? props.selectedDetail.discovery.retrieved_at}
              statusCode={props.connectivity[props.selectedDetail.inference_server.server_id]?.status_code}
              error={props.connectivity[props.selectedDetail.inference_server.server_id]?.error}
            />
          </div>
          <div className="kv"><span>Base URL</span><strong>{props.selectedDetail.endpoints.base_url}</strong></div>
          <div className="kv"><span>Runtime</span><strong>{runtimeLabel(props.selectedDetail)}</strong></div>
          <div className="kv"><span>GPU</span><strong>{gpuLabel(props.selectedDetail)}</strong></div>
          <div className="kv"><span>Models</span><strong>{props.selectedDetail.discovery.model_list.normalised.length}</strong></div>
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={() => props.onEdit(props.selectedDetail!)}>Edit</button>
            <button type="button" className="btn btn--ghost" onClick={() => props.onArchive(props.selectedDetail!)}>
              {props.selectedDetail.inference_server.archived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        </aside>
      ) : null}
    </section>
  );
}

function ModelsCatalog(props: {
  servers: InferenceServerRecord[];
  selectedServers: Set<string>;
  selectedServerRows: InferenceServerRecord[];
  visibleModels: CatalogModel[];
  allModelCount: number;
  familyOptions: string[];
  quantizationOptions: string[];
  formatOptions: string[];
  capabilityOptions: string[];
  selectedFamilies: Set<string>;
  selectedQuantizations: Set<string>;
  selectedFormats: Set<string>;
  selectedCapabilities: Set<string>;
  maxParamCount: number | null;
  paramCountSteps: number[];
  serverStageCollapsed: boolean;
  setServerStageCollapsed: (value: boolean) => void;
  onToggleServer: (serverId: string) => void;
  onClearServers: () => void;
  onToggleFilter: (key: 'family' | 'quantization' | 'format' | 'capabilities', value: string) => void;
  onClearModelFilters: () => void;
  onToggleCapability: (value: string) => void;
  onSetMaxParam: (value: number | null) => void;
  onInspect: (serverId: string, modelId: string) => void;
  onUseModel: (serverId: string, modelId: string) => void;
}) {
  const [modelFilterStageCollapsed, setModelFilterStageCollapsed] = useState(() => localStorage.getItem(MODEL_FILTER_STAGE_STORAGE_KEY) === 'true');
  const selectedModelFilterCount = props.selectedFamilies.size + props.selectedQuantizations.size + props.selectedFormats.size + props.selectedCapabilities.size + (props.maxParamCount !== null ? 1 : 0);

  useEffect(() => {
    localStorage.setItem(MODEL_FILTER_STAGE_STORAGE_KEY, String(modelFilterStageCollapsed));
  }, [modelFilterStageCollapsed]);

  if (props.servers.length === 0) {
    return <NoServersState />;
  }
  return (
    <section className={`catalog-page catalog-models ${props.serverStageCollapsed && props.selectedServers.size ? 'stage-collapsed' : ''} ${modelFilterStageCollapsed && props.selectedServers.size ? 'filter-collapsed' : ''}`}>
      <aside className="catalog-server-stage">
        {props.serverStageCollapsed && props.selectedServers.size ? (
          <>
            <button type="button" className="catalog-stage-expand" onClick={() => props.setServerStageCollapsed(false)}>›</button>
            <div className="catalog-vertical-label">Servers · {props.selectedServers.size} selected</div>
            <div className="catalog-server-tiles">
              {props.selectedServerRows.map((server) => (
                <button key={server.inference_server.server_id} type="button" title={server.inference_server.display_name} onClick={() => props.onToggleServer(server.inference_server.server_id)}>
                  {server.inference_server.display_name.slice(0, 2).toUpperCase()}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="catalog-stage-number">1</div>
            <div className="catalog-rail-header">
              <div>
                <strong>Servers</strong>
                <span>{props.selectedServers.size} selected</span>
              </div>
              {props.selectedServers.size ? <button type="button" className="btn btn--ghost btn--sm" onClick={props.onClearServers}>Clear</button> : null}
            </div>
            {props.selectedServers.size ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => props.setServerStageCollapsed(true)}>Collapse</button> : null}
            <div className="catalog-server-picker">
              {props.servers.map((server) => (
                <label key={server.inference_server.server_id} className={`server-filter-row ${props.selectedServers.has(server.inference_server.server_id) ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={props.selectedServers.has(server.inference_server.server_id)} onChange={() => props.onToggleServer(server.inference_server.server_id)} />
                  <span>
                    <strong>{server.inference_server.display_name}</strong>
                    <small>{server.endpoints.base_url}</small>
                    <small>{runtimeLabel(server)} · {gpuLabel(server)}</small>
                  </span>
                  <b>{server.discovery.model_list.normalised.length}</b>
                </label>
              ))}
            </div>
          </>
        )}
      </aside>
      {props.selectedServers.size ? (
        <aside className="catalog-rail catalog-model-filter-stage">
          {modelFilterStageCollapsed ? (
            <>
              <button type="button" className="catalog-stage-expand" onClick={() => setModelFilterStageCollapsed(false)}>›</button>
              <div className="catalog-vertical-label">Models · {selectedModelFilterCount} selected</div>
              <div className="catalog-server-tiles">
                {selectedModelFilterCount ? (
                  [
                    props.selectedFamilies.size ? 'FA' : null,
                    props.selectedQuantizations.size ? 'QU' : null,
                    props.selectedFormats.size ? 'FO' : null,
                    props.selectedCapabilities.size ? 'CA' : null,
                    props.maxParamCount !== null ? 'PA' : null
                  ].filter(Boolean).map((label) => (
                    <button key={label} type="button" title={label ?? ''} onClick={() => setModelFilterStageCollapsed(false)}>{label}</button>
                  ))
                ) : (
                  <button type="button" title="All" onClick={() => setModelFilterStageCollapsed(false)}>AL</button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="catalog-stage-number">2</div>
              <div className="catalog-rail-header">
                <div>
                  <strong>Models</strong>
                  <span>{selectedModelFilterCount} selected</span>
                </div>
                {selectedModelFilterCount ? <button type="button" className="btn btn--ghost btn--sm" onClick={props.onClearModelFilters}>Clear</button> : null}
              </div>
              <button type="button" className="btn btn--ghost btn--sm catalog-stage-collapse" onClick={() => setModelFilterStageCollapsed(true)}>Collapse</button>
              <FilterGroup title="Family" options={props.familyOptions} selected={props.selectedFamilies} onToggle={(value) => props.onToggleFilter('family', value)} />
              <FilterGroup title="Quantization" options={props.quantizationOptions} selected={props.selectedQuantizations} onToggle={(value) => props.onToggleFilter('quantization', value)} />
              <FilterGroup title="Format" options={props.formatOptions} selected={props.selectedFormats} onToggle={(value) => props.onToggleFilter('format', value)} />
              <FilterGroup title="Capabilities" options={props.capabilityOptions} selected={props.selectedCapabilities} onToggle={props.onToggleCapability} />
              <ParameterSlider steps={props.paramCountSteps} value={props.maxParamCount} onChange={props.onSetMaxParam} />
            </>
          )}
        </aside>
      ) : (
        <aside className="catalog-rail catalog-placeholder">Select a server first</aside>
      )}
      <main className="catalog-main">
        <div className="catalog-section-title">
          <div>
            <h2>Models</h2>
            <p>{props.visibleModels.length} of {props.allModelCount} · {props.selectedServers.size} selected servers</p>
          </div>
        </div>
        {props.selectedServers.size === 0 ? (
          <div className="catalog-empty">
            <EmptyState
              title="Select a server to see its models"
              body="Models are scoped to the servers that host them. Select one or more servers from the rail."
            />
          </div>
        ) : props.visibleModels.length === 0 ? (
          <div className="catalog-empty">
            <EmptyState
              title="No models discovered"
              body={`${props.selectedServerRows.map((server) => server.inference_server.display_name).join(', ')} returned 0 matching models.`}
              actions={null}
            />
          </div>
        ) : (
          <div className="catalog-model-grid">
            {props.visibleModels.map((model) => {
              const absent = model.discoveryStatus === 'absent';
              const pills = visibleModelPills(model);
              return (
                <article key={model.key} className={`catalog-model-card${absent ? ' is-absent' : ''}`}>
                  <div className="catalog-card-top">
                    <strong>{model.displayName}</strong>
                    {absent
                      ? <span className="catalog-absent-badge">unavailable</span>
                      : <span className="catalog-select-dot">✓</span>}
                  </div>
                  <div className="catalog-model-pills">
                    {pills.map((pill, index) => <span key={`${pill}-${index}`}>{pill}</span>)}
                  </div>
                  <p>{[...model.capabilities.slice(0, 4), model.streaming ? 'streaming' : null].filter(Boolean).join(' · ') || 'standard generation'}</p>
                  <div className="catalog-card-footer">
                    <span className="server-chip">{model.serverName}</span>
                    <div className="catalog-card-actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => props.onInspect(model.serverId, model.modelId)} disabled={absent}>Inspect</button>
                      <button type="button" className="btn btn--sm" onClick={() => props.onUseModel(model.serverId, model.modelId)} disabled={absent}>Use in Run</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </section>
  );
}

function ServersHealthPanel({ servers, connectivity }: { servers: InferenceServerRecord[]; connectivity: Record<string, InferenceServerHealth> }) {
  const counts = servers.reduce<Record<ServerStatus, number>>((acc, server) => {
    acc[statusFor(server, connectivity[server.inference_server.server_id])]++;
    return acc;
  }, { healthy: 0, degraded: 0, down: 0, unknown: 0 });
  return (
    <section className="catalog-page catalog-health">
      <main className="catalog-main">
        <div className="catalog-section-title">
          <div>
            <h2>Servers · health</h2>
            <p>{counts.down} down · {counts.degraded} degraded · {counts.healthy} healthy</p>
          </div>
        </div>
        <div className="health-legend">
          {(['healthy', 'degraded', 'down', 'unknown'] as ServerStatus[]).map((status) => (
            <span key={status}><RegLight state={statusToRegLight(status)} label={status} compact /> {status}</span>
          ))}
        </div>
        <div className="health-tile-grid">
          {servers.map((server) => {
            const health = connectivity[server.inference_server.server_id];
            const status = statusFor(server, health);
            return (
              <div key={server.inference_server.server_id} className="health-tile">
                <RegLight
                  state={statusToRegLight(status)}
                  label={statusLabel(status)}
                  compact
                  latencyMs={health?.response_time_ms}
                  lastProbe={health?.checked_at ?? server.discovery.retrieved_at}
                  statusCode={health?.status_code}
                  error={health?.error}
                />
                <strong>{server.inference_server.display_name}</strong>
              </div>
            );
          })}
        </div>
        <div className="health-table">
          <div className="health-row health-row--head"><span>Server</span><span>Latency</span><span>Last probe</span><span>Status</span></div>
          {servers.map((server) => {
            const health = connectivity[server.inference_server.server_id];
            const status = statusFor(server, health);
            return (
              <div key={server.inference_server.server_id} className="health-row">
                <span>
                  <RegLight
                    state={statusToRegLight(status)}
                    label={statusLabel(status)}
                    compact
                    latencyMs={health?.response_time_ms}
                    lastProbe={health?.checked_at ?? server.discovery.retrieved_at}
                    statusCode={health?.status_code}
                    error={health?.error}
                  />
                  <strong>{server.inference_server.display_name}</strong><small>{server.endpoints.base_url}</small>
                </span>
                <span>{health?.response_time_ms != null ? `${health.response_time_ms}ms` : '-'}</span>
                <span>{relativeTime(health?.checked_at)}</span>
                <span>{health?.status_code ?? statusLabel(status)}</span>
              </div>
            );
          })}
        </div>
      </main>
    </section>
  );
}

function NoServersState({ onAdd }: { onAdd?: () => void }) {
  return (
    <section className="catalog-page catalog-servers">
      <main className="catalog-main">
        <div className="catalog-section-title">
          <div>
            <h2>Inference servers</h2>
            <p>0 shown · 0 active · 0 archived</p>
          </div>
          {onAdd ? (
            <div className="catalog-section-actions">
              <button type="button" className="btn btn--sm" onClick={onAdd}>+ Add server</button>
            </div>
          ) : null}
        </div>
        <div className="catalog-server-grid">
          <button type="button" className="catalog-server-card catalog-server-card--empty" onClick={onAdd}>
            <span className="catalog-card-top">
              <strong>Add your first server</strong>
              <span className="catalog-empty-status">offline</span>
            </span>
            <span className="catalog-url">https://api.example.com/v1</span>
            <span className="catalog-card-meta">
              <span>OpenAI-compatible, Ollama, Anthropic, Gemini, or custom</span>
              <span className="catalog-pill">GPU unknown</span>
            </span>
            <span className="catalog-card-footer">
              <span>0 models discovered</span>
              <span className="btn btn--sm">+ Add server</span>
            </span>
          </button>
        </div>
      </main>
    </section>
  );
}

const SOFTWARE_OPTIONS = [
  'vLLM', 'Ollama', 'LM Studio', 'llama.cpp', 'Inferencer',
  'oLLM', 'Nemotron', 'PowerInfer',
  'TGI', 'LocalAI', 'TabbyAPI', 'KoboldCpp', 'MLC-LLM', 'TensorRT-LLM',
  'Aphrodite Engine', 'ExLlamaV2', 'Jan', 'GPT4All', 'Llamafile',
];

const GPU_MODELS: Record<GpuVendor, string[]> = {
  nvidia: [
    'H200 SXM', 'H100 SXM5 80GB', 'H100 PCIe 80GB',
    'A100 SXM4 80GB', 'A100 PCIe 40GB', 'L40S', 'A40', 'A10G',
    'RTX 5090 32GB', 'RTX 5080 16GB', 'RTX 5070 Ti 16GB', 'RTX 5070 12GB', 'RTX 5060 Ti 16GB', 'RTX 5060 8GB',
    'RTX 4090', 'RTX 4080 Super', 'RTX 4080', 'RTX 4070 Ti Super', 'RTX 4070 Super', 'RTX 4070',
    'RTX 6000 Ada 48GB', 'RTX 5000 Ada 32GB', 'RTX 4500 Ada 24GB', 'RTX 4000 Ada 20GB', 'RTX 4000 SFF Ada 20GB',
    'RTX 3090 Ti', 'RTX 3090',
    'T4', 'V100 32GB', 'V100 16GB',
  ],
  amd: [
    'MI300X', 'MI250X', 'MI210',
    'RX 7900 XTX', 'RX 7900 XT', 'RX 6900 XT', 'Radeon Pro W7900',
  ],
  apple: [
    'M4 Ultra', 'M4 Max', 'M4 Pro', 'M4',
    'M3 Ultra', 'M3 Max', 'M3 Pro', 'M3',
    'M2 Ultra', 'M2 Max', 'M2 Pro', 'M2',
    'M1 Ultra', 'M1 Max', 'M1 Pro', 'M1',
  ],
  intel: ['Arc A770 16GB', 'Arc A750 8GB', 'Arc A380 6GB', 'Iris Xe Max'],
  google: ['TPU v5p', 'TPU v5e', 'TPU v4', 'TPU v3'],
  unknown: [],
};

const CPU_MODELS: Record<string, string[]> = {
  apple: [
    'M5 Ultra', 'M5 Max', 'M5 Pro', 'M5',
    'M4 Ultra', 'M4 Max', 'M4 Pro', 'M4',
    'M3 Ultra', 'M3 Max', 'M3 Pro', 'M3',
    'M2 Ultra', 'M2 Max', 'M2 Pro', 'M2',
    'M1 Ultra', 'M1 Max', 'M1 Pro', 'M1',
  ],
  intel: [
    'Core i9-14900K', 'Core i9-13900K', 'Core i7-14700K', 'Core i7-13700K',
    'Core i5-14600K', 'Core i5-13600K',
    'Xeon W9-3595X', 'Xeon W7-3465X', 'Xeon Platinum 8592+', 'Xeon Gold 6438Y+',
  ],
  amd: [
    'Ryzen 9 9950X', 'Ryzen 9 7950X3D', 'Ryzen 9 7950X', 'Ryzen 9 7900X',
    'Ryzen 7 9700X', 'Ryzen 7 7800X3D', 'Ryzen 5 7600X',
    'EPYC 9654', 'EPYC 9554', 'EPYC 7763', 'EPYC 7742',
  ],
  arm: [
    'Ampere Altra Q80-30', 'Ampere Altra Max M128-30',
    'AWS Graviton4', 'AWS Graviton3', 'AWS Graviton2',
  ],
  other: [],
};

const OS_VERSIONS: Record<OsName, string[]> = {
  linux: [
    'Ubuntu 24.04 LTS', 'Ubuntu 22.04 LTS', 'Ubuntu 20.04 LTS',
    'Debian 12 (Bookworm)', 'Debian 11 (Bullseye)',
    'Fedora 41', 'RHEL 9.4', 'Rocky Linux 9.4', 'AlmaLinux 9.4',
    'Arch Linux', 'Alpine 3.21',
  ],
  macos: [
    '15.4 (Sequoia)', '15.3 (Sequoia)', '15.2 (Sequoia)',
    '14.7 (Sonoma)', '14.6 (Sonoma)',
    '13.7 (Ventura)',
  ],
  windows: [
    'Windows 11 24H2', 'Windows 11 23H2',
    'Windows Server 2025', 'Windows Server 2022', 'Windows Server 2019',
  ],
  unknown: [],
};

function ServerDrawer({ mode, onClose, onCancel, onSaved, onDelete }: {
  mode: DrawerMode;
  onClose: () => void;
  onCancel: () => void;
  onSaved: (server: InferenceServerRecord, openModels: boolean) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const editing = mode.kind === 'edit' ? mode.server : null;

  // ── Inference server fields ──
  const [providerPresetId, setProviderPresetId] = useState<ProviderPresetId>('local-manual');
  const [displayName, setDisplayName] = useState(editing?.inference_server.display_name ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.endpoints.base_url ?? '');
  const [software, setSoftware] = useState(editing?.runtime.server_software.name ?? '');
  const [version, setVersion] = useState(editing?.runtime.server_software.version ?? '');
  const [schemaFamilies, setSchemaFamilies] = useState<ApiSchemaFamily[]>(editing?.runtime.api.schema_family ?? ['openai-compatible']);
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'header'>(editing?.auth.type === 'custom' ? 'header' : editing?.auth.type === 'bearer' ? 'bearer' : 'none');
  const [authHeader, setAuthHeader] = useState(editing?.auth.header_name ?? 'Authorization');
  const [authToken, setAuthToken] = useState('');

  // ── Capabilities ──
  const caps = editing?.capabilities;
  const [capStreaming,        setCapStreaming]        = useState(caps?.server?.streaming ?? false);
  const [capModelsEndpoint,   setCapModelsEndpoint]   = useState(caps?.server?.models_endpoint ?? false);
  const [capTools,            setCapTools]            = useState(caps?.generation?.tools ?? false);
  const [capEmbeddings,       setCapEmbeddings]       = useState(caps?.generation?.embeddings ?? false);
  const [capJsonSchema,       setCapJsonSchema]       = useState(caps?.generation?.json_schema_output ?? false);
  const [capVisionInput,      setCapVisionInput]      = useState(caps?.multimodal?.vision?.input_images ?? false);
  const [capAudioInput,       setCapAudioInput]       = useState(caps?.multimodal?.audio?.input_audio ?? false);
  const [capReasoning,        setCapReasoning]        = useState(caps?.reasoning?.exposed ?? false);
  const [capTokenBudget,      setCapTokenBudget]      = useState(caps?.reasoning?.token_budget_configurable ?? false);
  const [capParallelRequests, setCapParallelRequests] = useState(caps?.concurrency?.parallel_requests ?? false);

  // ── GPU ──
  const [gpuVendor, setGpuVendor] = useState<GpuVendor>(editing?.runtime.hardware.gpu[0]?.vendor ?? 'unknown');
  const [gpuModel,  setGpuModel]  = useState(editing?.runtime.hardware.gpu[0]?.model ?? '');
  const [gpuVramGb, setGpuVramGb] = useState(
    editing?.runtime.hardware.gpu[0]?.vram_mb != null
      ? String(editing.runtime.hardware.gpu[0].vram_mb / 1024) : ''
  );
  const [gpuCores,         setGpuCores]         = useState(
    editing?.runtime.hardware.gpu[0]?.gpu_cores != null
      ? String(editing.runtime.hardware.gpu[0].gpu_cores) : ''
  );
  const [neuralEngineTops, setNeuralEngineTops] = useState(
    editing?.runtime.hardware.gpu[0]?.neural_engine_tops != null
      ? String(editing.runtime.hardware.gpu[0].neural_engine_tops) : ''
  );

  // ── CPU & RAM ──
  const [cpuVendorHint, setCpuVendorHint] = useState(editing?.runtime.hardware.gpu[0]?.vendor === 'apple' ? 'apple' : 'other');
  const [cpuModel,  setCpuModel]  = useState(editing?.runtime.hardware.cpu.model ?? '');
  const [cpuCores,  setCpuCores]  = useState(
    editing?.runtime.hardware.cpu.cores != null ? String(editing.runtime.hardware.cpu.cores) : ''
  );
  const [ramGb, setRamGb] = useState(
    editing?.runtime.hardware.ram_mb != null ? String(editing.runtime.hardware.ram_mb / 1024) : ''
  );

  // ── Platform ──
  const [osName,         setOsName]         = useState<OsName>(editing?.runtime.platform?.os.name ?? 'unknown');
  const [osVersion,      setOsVersion]      = useState(editing?.runtime.platform?.os.version ?? '');
  const [osArch,         setOsArch]         = useState<OsArch>(editing?.runtime.platform?.os.arch ?? 'unknown');
  const [containerType,  setContainerType]  = useState<ContainerType>(editing?.runtime.platform?.container.type ?? 'none');
  const [containerImage, setContainerImage] = useState(editing?.runtime.platform?.container.image ?? '');

  // ── Probe state ──
  const [busy,       setBusy]       = useState(false);
  const [probeState, setProbeState] = useState<'idle' | 'probing' | 'probe-ok' | 'probe-failed'>('idle');
  const [probeError, setProbeError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const selectedProviderPreset = PROVIDER_PRESETS.find((entry) => entry.id === providerPresetId) ?? PROVIDER_PRESETS[0];
  const hostingFieldsDisabled = !editing && selectedProviderPreset.providerKind === 'cloud';

  function toggleFamily(value: ApiSchemaFamily) {
    setSchemaFamilies((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function applyProviderPreset(presetId: ProviderPresetId) {
    const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId) ?? PROVIDER_PRESETS[0];
    setProviderPresetId(preset.id);
    setDisplayName(preset.displayName);
    setBaseUrl(preset.baseUrl);
    setSoftware(preset.software);
    setVersion(preset.version);
    setSchemaFamilies(preset.schemaFamilies);
    setAuthType(preset.authType);
    setAuthHeader(preset.authHeader);
    setAuthToken('');
    setCapStreaming(preset.capabilities.streaming);
    setCapModelsEndpoint(preset.capabilities.modelsEndpoint);
    setCapTools(preset.capabilities.tools);
    setCapEmbeddings(preset.capabilities.embeddings);
    setCapJsonSchema(preset.capabilities.jsonSchema);
    setCapVisionInput(preset.capabilities.visionInput);
    setCapAudioInput(preset.capabilities.audioInput);
    setCapReasoning(preset.capabilities.reasoning);
    setCapTokenBudget(preset.capabilities.tokenBudget);
    setCapParallelRequests(preset.capabilities.parallelRequests);
    setGpuVendor(preset.platform.gpuVendor);
    setGpuModel(preset.platform.gpuModel);
    setGpuVramGb(preset.platform.gpuVramGb);
    setGpuCores('');
    setNeuralEngineTops('');
    setCpuVendorHint(preset.platform.cpuVendorHint);
    setCpuModel(preset.platform.cpuModel);
    setCpuCores(preset.platform.cpuCores);
    setRamGb(preset.platform.ramGb);
    setOsName(preset.platform.osName);
    setOsVersion(preset.platform.osVersion);
    setOsArch(preset.platform.osArch);
    setContainerType(preset.platform.containerType);
    setContainerImage(preset.platform.containerImage);
    setProbeState('idle');
    setProbeError(null);
    setDiscovered([]);
  }

  function buildInput(): InferenceServerInput {
    const authPayload: InferenceServerInput['auth'] = {
      type: authType === 'header' ? 'custom' as AuthType : authType,
      header_name: authHeader || 'Authorization'
    };
    if (authType === 'none') {
      authPayload.token = null;
      authPayload.token_env = null;
    } else if (authToken.trim()) {
      authPayload.token = authToken.trim();
      authPayload.token_env = null;
    }
    const input: InferenceServerInput = {
      inference_server: { display_name: displayName, active: true, archived: false },
      endpoints: { base_url: baseUrl },
      runtime: {
        server_software: { name: software.trim() || 'unknown', version: version.trim() || null, build: null },
        api: { schema_family: schemaFamilies.length ? schemaFamilies : ['custom'], api_version: null },
        hardware: {
          cpu: { model: cpuModel.trim() || null, cores: cpuCores ? parseInt(cpuCores, 10) : null },
          gpu: gpuModel.trim()
            ? [{ vendor: gpuVendor, model: gpuModel.trim(), vram_mb: gpuVramGb ? Math.round(parseFloat(gpuVramGb) * 1024) : null, gpu_cores: gpuCores ? parseInt(gpuCores, 10) : null, neural_engine_tops: neuralEngineTops ? parseFloat(neuralEngineTops) : null }]
            : [],
          ram_mb: ramGb ? Math.round(parseFloat(ramGb) * 1024) : null,
        },
        platform: {
          os: { name: osName, version: osVersion.trim() || null, arch: osArch },
          container: {
            type: containerType,
            image: containerType !== 'none' && containerType !== 'unknown' ? containerImage.trim() || null : null,
          },
        },
      },
      auth: authPayload,
      capabilities: {
        server:     { streaming: capStreaming, models_endpoint: capModelsEndpoint },
        generation: { text: true, json_schema_output: capJsonSchema, tools: capTools, embeddings: capEmbeddings },
        multimodal: {
          vision: { input_images: capVisionInput, output_images: false },
          audio:  { input_audio: capAudioInput,   output_audio: false },
        },
        reasoning:   { exposed: capReasoning, token_budget_configurable: capTokenBudget },
        concurrency: { parallel_requests: capParallelRequests, parallel_tool_calls: false, max_concurrent_requests: null },
        enforcement: 'server',
      }
    };
    if (!editing) {
      input.raw = {
        provider_preset: selectedProviderPreset.id,
        provider_kind: selectedProviderPreset.providerKind
      };
    }
    return input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProbeError(null);
    setProbeState('probing');
    try {
      const input = buildInput();
      const result = await testServerConnection({
        server_id: editing?.inference_server.server_id,
        base_url: input.endpoints?.base_url ?? baseUrl,
        schema_family: (input.runtime?.api?.schema_family as string[]) ?? ['openai-compatible'],
        auth: {
          type: input.auth?.type ?? 'none',
          header_name: input.auth?.header_name ?? 'Authorization',
          token: input.auth?.token,
          token_env: input.auth?.token_env
        }
      });
      setDiscovered(result.models);
      if (result.ok) {
        setProbeState('probe-ok');
      } else {
        setProbeState('probe-failed');
        setProbeError(result.error ?? 'Connection failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    try {
      const input = buildInput();
      let server = editing
        ? await updateInferenceServer(editing.inference_server.server_id, input)
        : await createInferenceServer(input);
      try {
        server = await refreshInferenceServerDiscovery(server.inference_server.server_id);
      } catch {
        // discovery failure doesn't block save
      }
      await onSaved(server, false);
    } finally {
      onClose();
    }
  }

  async function handleDeleteClick() {
    if (!onDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unable to delete inference server');
      setDeleteBusy(false);
    }
  }

  return (
    <div className="drawer-overlay" role="dialog" aria-modal="true">
      <aside className="server-drawer">
        <div className="drawer-header">
          <div>
            <span className="label--uppercase">{editing ? 'Edit' : 'Add'}</span>
            <h2>{editing ? `Edit · ${editing.inference_server.display_name}` : 'Add inference server'}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}>x</button>
        </div>
        <form onSubmit={handleSubmit} className="drawer-body">
          <div className="drawer-columns">

            {/* ── LEFT: Inference Server ── */}
            <div className="drawer-col">
              <div className="form-field-label">Connection</div>
              {!editing ? (
                <label>Connection type
                  <select data-testid="provider-preset-select" value={providerPresetId} onChange={(event) => applyProviderPreset(event.target.value as ProviderPresetId)}>
                    {PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
              <label>Base URL<input className="input--mono" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" required /></label>
              <div className="drawer-two-col">
                <label>Software
                  <input list="software-list" value={software} onChange={(event) => setSoftware(event.target.value)} placeholder="vLLM" />
                  <datalist id="software-list">
                    {SOFTWARE_OPTIONS.map((s) => <option key={s} value={s} />)}
                  </datalist>
                </label>
                <label>Version<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.6.3" /></label>
              </div>

              <div className="form-field-label">API</div>
              <div>
                <div className="form-field-label">Families</div>
                <div className="chip-field">
                  {([
                    ['openai-compatible', 'OpenAI'],
                    ['ollama', 'Ollama'],
                    ['anthropic', 'Anthropic'],
                    ['gemini', 'Gemini'],
                    ['custom', 'Custom']
                  ] as Array<[ApiSchemaFamily, string]>).map(([value, label]) => (
                    <label key={value} className="catalog-checkbox">
                      <input type="checkbox" checked={schemaFamilies.includes(value)} onChange={() => toggleFamily(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label>Auth type<select value={authType} onChange={(event) => setAuthType(event.target.value as 'none' | 'bearer' | 'header')}>
                <option value="none">None</option>
                <option value="bearer">Bearer</option>
                <option value="header">Header</option>
              </select></label>
              {authType !== 'none' ? (
                <>
                  <label>Auth header name<input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} /></label>
                  <label>Auth token<input type="password" value={authToken} onChange={(event) => setAuthToken(event.target.value)} placeholder={editing?.auth.token_present ? 'Stored token unchanged' : ''} /></label>
                </>
              ) : null}

              <div className="form-field-label">Capabilities</div>
              <div className="chip-field">
                {([
                  ['Streaming',         capStreaming,        setCapStreaming],
                  ['Models endpoint',   capModelsEndpoint,   setCapModelsEndpoint],
                  ['Tool calls',        capTools,            setCapTools],
                  ['Embeddings',        capEmbeddings,       setCapEmbeddings],
                  ['JSON schema',       capJsonSchema,       setCapJsonSchema],
                  ['Vision input',      capVisionInput,      setCapVisionInput],
                  ['Audio input',       capAudioInput,       setCapAudioInput],
                  ['Reasoning',         capReasoning,        setCapReasoning],
                  ['Token budget',      capTokenBudget,      setCapTokenBudget],
                  ['Parallel requests', capParallelRequests, setCapParallelRequests],
                ] as Array<[string, boolean, (v: boolean) => void]>).map(([label, value, setter]) => (
                  <label key={label} className="catalog-checkbox">
                    <input type="checkbox" checked={value} onChange={(event) => setter(event.target.checked)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              {probeState !== 'idle' ? (
                <div className={`probe-panel probe-panel--${probeState === 'probe-ok' ? 'ok' : probeState === 'probe-failed' ? 'failed' : probeState}`}>
                  <strong>{probeState === 'probing' ? 'Testing connection...' : probeState === 'probe-ok' ? 'Connection OK' : 'Connection failed'}</strong>
                  {probeError ? <p>{probeError}</p> : null}
                  {discovered.length ? <ul>{discovered.slice(0, 8).map((model) => <li key={model}>{model}</li>)}</ul> : null}
                </div>
              ) : null}
            </div>

            {/* ── RIGHT: Hosting Server ── */}
            <fieldset className={`drawer-col drawer-col--hosting ${hostingFieldsDisabled ? 'is-disabled' : ''}`} disabled={hostingFieldsDisabled}>
              <div className="form-field-label">GPU</div>
              {hostingFieldsDisabled ? (
                <p className="drawer-disabled-note">
                  Hosted AI providers do not expose reliable hardware or platform details. InferHarness will store this server with unknown hosting metadata.
                </p>
              ) : null}
              <label>GPU vendor
                <select value={gpuVendor} onChange={(event) => {
                  const v = event.target.value as GpuVendor;
                  setGpuVendor(v);
                  if (v === 'apple') {
                    setCpuVendorHint('apple');
                    setOsName('macos');
                    setOsArch('arm64');
                  }
                }}>
                  <option value="unknown">Unknown</option>
                  <option value="nvidia">NVIDIA</option>
                  <option value="amd">AMD</option>
                  <option value="apple">Apple</option>
                  <option value="intel">Intel</option>
                  <option value="google">Google</option>
                </select>
              </label>
              <label>GPU model
                <input list="gpu-model-list" value={gpuModel} onChange={(event) => {
                  setGpuModel(event.target.value);
                  if (gpuVendor === 'apple') setCpuModel(event.target.value);
                }} placeholder="RTX 4090" />
                <datalist id="gpu-model-list">
                  {GPU_MODELS[gpuVendor].map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
              <label>VRAM (GB)<input type="number" min="0" step="0.5" value={gpuVramGb} onChange={(event) => setGpuVramGb(event.target.value)} placeholder="24" /></label>
              {gpuVendor === 'apple' ? (
                <div className="drawer-two-col">
                  <label>GPU cores<input type="number" min="1" step="1" value={gpuCores} onChange={(event) => setGpuCores(event.target.value)} placeholder="40" /></label>
                  <label>Neural Engine (TOPS)<input type="number" min="0" step="1" value={neuralEngineTops} onChange={(event) => setNeuralEngineTops(event.target.value)} placeholder="38" /></label>
                </div>
              ) : null}

              <div className="form-field-label">CPU & Memory</div>
              <label>CPU vendor
                <select value={cpuVendorHint} onChange={(event) => setCpuVendorHint(event.target.value)}>
                  <option value="other">Other / Unknown</option>
                  <option value="apple">Apple</option>
                  <option value="intel">Intel</option>
                  <option value="amd">AMD</option>
                  <option value="arm">ARM / Cloud</option>
                </select>
              </label>
              <label>CPU model
                <input list="cpu-model-list" value={cpuModel} onChange={(event) => setCpuModel(event.target.value)} placeholder="Core i9-14900K" />
                <datalist id="cpu-model-list">
                  {CPU_MODELS[cpuVendorHint].map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
              <div className="drawer-two-col">
                <label>Cores<input type="number" min="1" step="1" value={cpuCores} onChange={(event) => setCpuCores(event.target.value)} /></label>
                <label>RAM (GB)<input type="number" min="0" step="0.5" value={ramGb} onChange={(event) => setRamGb(event.target.value)} /></label>
              </div>

              <div className="form-field-label">Platform</div>
              <div className="drawer-two-col">
                <label>OS
                  <select data-testid="os-name-select" value={osName} onChange={(event) => { setOsName(event.target.value as OsName); setOsVersion(''); }}>
                    <option value="unknown">Unknown</option>
                    <option value="linux">Linux</option>
                    <option value="macos">macOS</option>
                    <option value="windows">Windows</option>
                  </select>
                </label>
                <label>Arch
                  <select data-testid="os-arch-select" value={osArch} onChange={(event) => setOsArch(event.target.value as OsArch)}>
                    <option value="unknown">Unknown</option>
                    <option value="arm64">arm64</option>
                    <option value="x86_64">x86_64</option>
                  </select>
                </label>
              </div>
              <label>OS version
                <input list="os-version-list" value={osVersion} onChange={(event) => setOsVersion(event.target.value)} placeholder="22.04 LTS" />
                <datalist id="os-version-list">
                  {OS_VERSIONS[osName].map((v) => <option key={v} value={v} />)}
                </datalist>
              </label>

              <div className="form-field-label">Container</div>
              <label>Type
                <select value={containerType} onChange={(event) => setContainerType(event.target.value as ContainerType)}>
                  <option value="none">None</option>
                  <option value="docker">Docker</option>
                  <option value="podman">Podman</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>
              {containerType !== 'none' && containerType !== 'unknown' ? (
                <label>Image<input className="input--mono" value={containerImage} onChange={(event) => setContainerImage(event.target.value)} placeholder="ghcr.io/org/image:latest" /></label>
              ) : null}
            </fieldset>

          </div>

          <div className="drawer-footer">
            <div>
              {onDelete ? <button type="button" className="btn btn--danger" onClick={handleDeleteClick} disabled={deleteBusy}>{deleteBusy ? 'Deleting...' : 'Delete server'}</button> : <span />}
              {deleteError ? <div className="error">{deleteError}</div> : null}
            </div>
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
              {probeState === 'probe-ok' || probeState === 'probe-failed' ? (
                <button type="button" className={probeState === 'probe-failed' ? 'btn btn--ghost' : undefined} onClick={handleSave} disabled={busy}>
                  {busy ? 'Saving...' : probeState === 'probe-ok' ? (editing ? 'Save changes' : 'Save to Catalog') : 'Save anyway'}
                </button>
              ) : null}
              <button type="submit" disabled={busy || !displayName || !baseUrl}>
                {busy && probeState === 'probing' ? 'Testing...' : 'Test connection'}
              </button>
            </div>
          </div>
        </form>
      </aside>
    </div>
  );
}
