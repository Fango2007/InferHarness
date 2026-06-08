import path from 'path';
import { fileURLToPath } from 'url';

import { getInferenceServerById } from '../models/inference-server.js';
import {
  MODEL_SCHEMA_VERSION,
  ModelArchitecture,
  ModelCapabilities,
  ModelConfiguration,
  ModelDiscovery,
  ModelInfo,
  ModelIdentity,
  ModelLimits,
  ModelModalities,
  ModelPerformance,
  ModelProvider,
  ModelFormat,
  ModelRecord,
  createModel,
  getModelById,
  listModels,
  updateModel
} from '../models/model.js';
import { nowIso } from '../models/repositories.js';
import { extractBaseModelName, guessModelCharacteristics } from './model-name-parser.js';
import { validateWithSchema } from './schema-validator.js';

export interface ModelInput {
  model?: Partial<ModelInfo>;
  identity?: Partial<ModelIdentity>;
  architecture?: Partial<Omit<ModelArchitecture, 'quantisation'>> & {
    quantisation?: Partial<ModelArchitecture['quantisation']>;
  };
  modalities?: Partial<ModelModalities>;
  capabilities?: {
    generation?: Partial<ModelCapabilities['generation']>;
    multimodal?: Partial<ModelCapabilities['multimodal']>;
    reasoning?: Partial<ModelCapabilities['reasoning']>;
    use_case?: Partial<ModelCapabilities['use_case']>;
  };
  limits?: Partial<ModelLimits>;
  performance?: Partial<ModelPerformance>;
  configuration?: Partial<Omit<ModelConfiguration, 'default_parameters' | 'context_strategy'>> & {
    default_parameters?: Partial<ModelConfiguration['default_parameters']>;
    context_strategy?: Partial<ModelConfiguration['context_strategy']>;
  };
  discovery?: Partial<ModelDiscovery>;
  raw?: Record<string, unknown>;
}

export interface DiscoveredModelInput {
  server_id: string;
  model_id: string;
  display_name?: string | null;
  provider?: string | null;
  base_model_name?: string | null;
  default_temperature?: number | null;
  capabilities?: Record<string, boolean>;
  context_window_tokens?: number | null;
  quantisation?: {
    method?: string | null;
    bits?: number | null;
    group_size?: number | null;
    scheme?: string | null;
    variant?: string | null;
    weight_format?: string | null;
  } | null;
  raw?: Record<string, unknown>;
}

export class InvalidModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelError';
  }
}

function resolveSchemaPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../schemas/model-schema.json');
}

function defaultIdentity(): ModelIdentity {
  return {
    provider: 'unknown',
    family: null,
    version: null,
    revision: null,
    checksum: null,
    quantized_provider: null
  };
}

function defaultArchitecture(): ModelArchitecture {
  return {
    type: 'unknown',
    parameter_count: null,
    parameter_count_label: null,
    active_parameter_label: null,
    precision: 'unknown',
    quantisation: { method: 'unknown', bits: null, group_size: null },
    format: null
  };
}

function defaultModalities(): ModelModalities {
  return { input: ['text'], output: ['text'] };
}

function defaultCapabilities(): ModelCapabilities {
  return {
    generation: { text: false, json_schema_output: false, tools: false, embeddings: false },
    multimodal: { vision: false, audio: false },
    reasoning: { supported: false, explicit_tokens: false },
    use_case: { thinking: false, coding: false, instruct: false, mixture_of_experts: false }
  };
}

function defaultLimits(): ModelLimits {
  return {
    context_window_tokens: null,
    max_output_tokens: null,
    max_images: null,
    max_batch_size: null
  };
}

function defaultPerformance(): ModelPerformance {
  return {
    theoretical: { tokens_per_second: null },
    observed: {
      prefill_tps: null,
      generation_tps: null,
      latency_ms_p50: null,
      latency_ms_p95: null,
      measured_at: null
    }
  };
}

function defaultConfiguration(): ModelConfiguration {
  return {
    default_parameters: {
      temperature: null,
      top_p: null,
      top_k: null,
      presence_penalty: null,
      frequency_penalty: null,
      seed: null
    },
    context_strategy: { type: 'custom', window_tokens: null }
  };
}

function defaultDiscovery(): ModelDiscovery {
  return { retrieved_at: nowIso(), source: 'manual' };
}

function mergeIdentity(existing: ModelIdentity | null, updates: Partial<ModelIdentity> | undefined): ModelIdentity {
  return { ...(existing ?? defaultIdentity()), ...(updates ?? {}) };
}

function mergeArchitecture(
  existing: ModelArchitecture | null,
  updates: ModelInput['architecture'] | undefined
): ModelArchitecture {
  const base = existing ?? defaultArchitecture();
  if (!updates) {
    return base;
  }
  const normalizedFormat = normalizeModelFormat((updates as { format?: unknown }).format);
  return {
    ...base,
    ...updates,
    ...(normalizedFormat !== undefined ? { format: normalizedFormat } : {}),
    quantisation: { ...base.quantisation, ...updates.quantisation }
  };
}

function normalizeModelFormat(format: unknown): ModelFormat | null | undefined {
  if (format === undefined) {
    return undefined;
  }
  if (format === null || format === '') {
    return null;
  }
  if (typeof format !== 'string') {
    return format as ModelFormat;
  }
  const normalized = format.trim();
  if (/^gcuf$/i.test(normalized)) {
    return 'GGUF';
  }
  if (/^gguf$/i.test(normalized)) {
    return 'GGUF';
  }
  if (/^mlx$/i.test(normalized)) {
    return 'MLX';
  }
  if (/^gptq$/i.test(normalized)) {
    return 'GPTQ';
  }
  if (/^awq$/i.test(normalized)) {
    return 'AWQ';
  }
  if (/^safetensors$/i.test(normalized)) {
    return 'SafeTensors';
  }
  return normalized as ModelFormat;
}

function mergeModalities(
  existing: ModelModalities | null,
  updates: Partial<ModelModalities> | undefined
): ModelModalities {
  const base = existing ?? defaultModalities();
  if (!updates) {
    return base;
  }
  return {
    input: updates.input ?? base.input,
    output: updates.output ?? base.output
  };
}

function mergeCapabilities(
  existing: ModelCapabilities | null,
  updates: ModelInput['capabilities'] | undefined
): ModelCapabilities {
  const base = existing ?? defaultCapabilities();
  if (!updates) {
    return base;
  }
  return {
    ...base,
    ...updates,
    generation: { ...base.generation, ...updates.generation },
    multimodal: { ...base.multimodal, ...updates.multimodal },
    reasoning: { ...base.reasoning, ...updates.reasoning },
    use_case: { ...base.use_case, ...updates.use_case }
  };
}

function mergeLimits(existing: ModelLimits | null, updates: Partial<ModelLimits> | undefined): ModelLimits {
  return { ...(existing ?? defaultLimits()), ...(updates ?? {}) };
}

function mergePerformance(
  existing: ModelPerformance | null,
  updates: Partial<ModelPerformance> | undefined
): ModelPerformance {
  const base = existing ?? defaultPerformance();
  if (!updates) {
    return base;
  }
  return {
    ...base,
    ...updates,
    theoretical: { ...base.theoretical, ...updates.theoretical },
    observed: { ...base.observed, ...updates.observed }
  };
}

function mergeConfiguration(
  existing: ModelConfiguration | null,
  updates: ModelInput['configuration'] | undefined
): ModelConfiguration {
  const base = existing ?? defaultConfiguration();
  if (!updates) {
    return base;
  }
  return {
    ...base,
    ...updates,
    default_parameters: { ...base.default_parameters, ...updates.default_parameters },
    context_strategy: { ...base.context_strategy, ...updates.context_strategy }
  };
}

function mergeDiscovery(
  existing: ModelDiscovery | null,
  updates: Partial<ModelDiscovery> | undefined
): ModelDiscovery {
  return { ...(existing ?? defaultDiscovery()), ...(updates ?? {}) };
}

function validateModelRecord(record: ModelRecord): void {
  const schemaResult = validateWithSchema(resolveSchemaPath(), record);
  if (schemaResult.ok) {
    return;
  }
  const detail = schemaResult.issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  throw new InvalidModelError(`Schema validation failed: ${detail}`);
}

function isBlankText(value: string | null | undefined): boolean {
  return value == null || value.trim() === '' || value.trim().toLowerCase() === 'unknown';
}

function normaliseProvider(value: string | null | undefined): ModelProvider | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mistralai' || normalized === 'mistral') {
    return 'mistral';
  }
  if (normalized === 'openai') {
    return 'openai';
  }
  return null;
}

function isCloudModelProvider(provider: ModelProvider | null): boolean {
  return Boolean(provider && provider !== 'custom' && provider !== 'unknown');
}

function fullPrecisionForCloudProvider(
  discoveryProvider: ModelProvider | null,
  guessed: ReturnType<typeof guessModelCharacteristics>,
  input: DiscoveredModelInput
): ModelArchitecture['precision'] | null {
  const hasQuantization =
    Boolean(input.quantisation) ||
    Boolean(guessed.quantisation.method) ||
    Boolean(guessed.quantisation.bits != null) ||
    Boolean(guessed.format);
  if (hasQuantization || !isCloudModelProvider(discoveryProvider)) {
    return null;
  }
  return 'bf16';
}

function providerCapabilities(input: DiscoveredModelInput): ModelInput['capabilities'] {
  const capabilities = input.capabilities ?? {};
  const lowerId = input.model_id.toLowerCase();
  const lowerDisplay = (input.display_name ?? '').toLowerCase();
  const text = Boolean(capabilities.completion_chat);
  const embeddings = /\bembed/.test(lowerId) || /\bembed/.test(lowerDisplay);
  const audioInput = Boolean(capabilities.audio || capabilities.audio_transcription || capabilities.audio_transcription_realtime);
  const audioOutput = Boolean(capabilities.audio_speech);
  const vision = Boolean(capabilities.vision);
  const reasoning = Boolean(capabilities.reasoning);
  const coding = Boolean(capabilities.completion_fim) || /\b(codestral|devstral|code|coder)\b/.test(`${lowerId} ${lowerDisplay}`);

  return {
    generation: {
      text,
      tools: Boolean(capabilities.function_calling),
      embeddings
    },
    multimodal: {
      vision,
      audio: audioInput || audioOutput
    },
    reasoning: {
      supported: reasoning
    },
    use_case: {
      thinking: reasoning,
      coding
    }
  };
}

function providerModalities(input: DiscoveredModelInput): Partial<ModelModalities> {
  const capabilities = input.capabilities ?? {};
  const lowerId = input.model_id.toLowerCase();
  const lowerDisplay = (input.display_name ?? '').toLowerCase();
  const embeds = /\bembed/.test(lowerId) || /\bembed/.test(lowerDisplay);
  const inputModalities = new Set<string>(['text']);
  const outputModalities = new Set<string>(embeds ? ['embedding'] : ['text']);
  if (capabilities.vision) inputModalities.add('image');
  if (capabilities.audio || capabilities.audio_transcription || capabilities.audio_transcription_realtime) inputModalities.add('audio');
  if (capabilities.audio_speech) outputModalities.add('audio');
  return {
    input: Array.from(inputModalities),
    output: Array.from(outputModalities)
  };
}

function inferredModelInput(input: DiscoveredModelInput): ModelInput {
  const guessed = guessModelCharacteristics(input.model_id);
  const providerCaps = providerCapabilities(input);
  const discoveryProvider = normaliseProvider(input.provider);
  const provider = discoveryProvider ?? guessed.provider ?? 'unknown';
  const inferredPrecision = guessed.precision ?? fullPrecisionForCloudProvider(discoveryProvider, guessed, input) ?? 'unknown';
  const discoveredMethod = input.quantisation?.method;
  const quantisationMethod =
    discoveredMethod && discoveredMethod !== 'unknown'
      ? discoveredMethod
      : guessed.quantisation.method ?? (inferredPrecision === 'bf16' ? 'none' : 'unknown');
  return {
    model: {
      model_id: input.model_id,
      server_id: input.server_id,
      display_name: input.display_name?.trim() || input.model_id,
      base_model_name: input.base_model_name?.trim() || extractBaseModelName(input.model_id)
    },
    identity: {
      provider,
      quantized_provider: guessed.quantized_provider
    },
    architecture: {
      parameter_count: guessed.parameter_count,
      parameter_count_label: guessed.parameter_count_label,
      active_parameter_label: guessed.active_parameter_label,
      precision: inferredPrecision,
      format: guessed.format,
      quantisation: {
        method: quantisationMethod as ModelArchitecture['quantisation']['method'],
        bits: input.quantisation?.bits ?? guessed.quantisation.bits,
        group_size: input.quantisation?.group_size ?? null,
        scheme: (input.quantisation?.scheme ?? null) as ModelArchitecture['quantisation']['scheme'],
        variant: (input.quantisation?.variant ?? null) as ModelArchitecture['quantisation']['variant'],
        weight_format: input.quantisation?.weight_format ?? null
      }
    },
    capabilities: {
      ...providerCaps,
      use_case: {
        thinking: Boolean(providerCaps?.use_case?.thinking || guessed.use_case.thinking),
        coding: Boolean(providerCaps?.use_case?.coding || guessed.use_case.coding),
        instruct: guessed.use_case.instruct,
        mixture_of_experts: guessed.use_case.mixture_of_experts
      }
    },
    modalities: providerModalities(input),
    limits: {
      context_window_tokens: input.context_window_tokens ?? null
    },
    configuration: typeof input.default_temperature === 'number'
      ? { default_parameters: { temperature: input.default_temperature } }
      : undefined,
    discovery: {
      retrieved_at: nowIso(),
      source: 'server',
      discovery_status: 'present'
    },
    raw: input.raw ?? {}
  };
}

function fillMissingModelInput(existing: ModelRecord, inferred: ModelInput): ModelInput {
  const updates: ModelInput = {};
  if (isBlankText(existing.model.base_model_name) && inferred.model?.base_model_name) {
    updates.model = { base_model_name: inferred.model.base_model_name };
  }
  if (isBlankText(existing.identity.provider) && inferred.identity?.provider) {
    updates.identity = { ...(updates.identity ?? {}), provider: inferred.identity.provider };
  }
  if (isBlankText(existing.identity.quantized_provider) && inferred.identity?.quantized_provider) {
    updates.identity = { ...(updates.identity ?? {}), quantized_provider: inferred.identity.quantized_provider };
  }
  if (existing.architecture.parameter_count == null && inferred.architecture?.parameter_count != null) {
    updates.architecture = { ...(updates.architecture ?? {}), parameter_count: inferred.architecture.parameter_count };
  }
  if (isBlankText(existing.architecture.parameter_count_label) && inferred.architecture?.parameter_count_label) {
    updates.architecture = { ...(updates.architecture ?? {}), parameter_count_label: inferred.architecture.parameter_count_label };
  }
  if (isBlankText(existing.architecture.active_parameter_label) && inferred.architecture?.active_parameter_label) {
    updates.architecture = { ...(updates.architecture ?? {}), active_parameter_label: inferred.architecture.active_parameter_label };
  }
  if (existing.architecture.format == null && inferred.architecture?.format) {
    updates.architecture = { ...(updates.architecture ?? {}), format: inferred.architecture.format };
  }
  if (
    (existing.architecture.precision === 'unknown' || existing.architecture.precision == null) &&
    inferred.architecture?.precision &&
    inferred.architecture.precision !== 'unknown'
  ) {
    updates.architecture = { ...(updates.architecture ?? {}), precision: inferred.architecture.precision };
  }
  if (inferred.architecture?.quantisation) {
    const quantUpdates: Partial<ModelArchitecture['quantisation']> = {};
    const current = existing.architecture.quantisation;
    const inferredQuant = inferred.architecture.quantisation;
    if ((current.method === 'unknown' || current.method == null) && inferredQuant.method && inferredQuant.method !== 'unknown') {
      quantUpdates.method = inferredQuant.method;
    }
    if (current.bits == null && inferredQuant.bits != null) {
      quantUpdates.bits = inferredQuant.bits;
    }
    if (current.group_size == null && inferredQuant.group_size != null) {
      quantUpdates.group_size = inferredQuant.group_size;
    }
    if (current.scheme == null && inferredQuant.scheme != null) {
      quantUpdates.scheme = inferredQuant.scheme;
    }
    if (current.variant == null && inferredQuant.variant != null) {
      quantUpdates.variant = inferredQuant.variant;
    }
    if (isBlankText(current.weight_format) && inferredQuant.weight_format) {
      quantUpdates.weight_format = inferredQuant.weight_format;
    }
    if (Object.keys(quantUpdates).length) {
      updates.architecture = { ...(updates.architecture ?? {}), quantisation: quantUpdates };
    }
  }
  if (existing.limits.context_window_tokens == null && inferred.limits?.context_window_tokens != null) {
    updates.limits = { context_window_tokens: inferred.limits.context_window_tokens };
  }
  if (
    existing.configuration.default_parameters.temperature == null &&
    inferred.configuration?.default_parameters?.temperature != null
  ) {
    updates.configuration = {
      default_parameters: {
        temperature: inferred.configuration.default_parameters.temperature
      }
    };
  }
  const generationUpdates: Partial<ModelCapabilities['generation']> = {};
  for (const key of ['text', 'tools', 'embeddings'] as const) {
    if (!existing.capabilities.generation[key] && inferred.capabilities?.generation?.[key]) {
      generationUpdates[key] = true;
    }
  }
  const multimodalUpdates: Partial<ModelCapabilities['multimodal']> = {};
  for (const key of ['vision', 'audio'] as const) {
    if (!existing.capabilities.multimodal[key] && inferred.capabilities?.multimodal?.[key]) {
      multimodalUpdates[key] = true;
    }
  }
  const reasoningUpdates: Partial<ModelCapabilities['reasoning']> = {};
  if (!existing.capabilities.reasoning.supported && inferred.capabilities?.reasoning?.supported) {
    reasoningUpdates.supported = true;
  }
  const useCaseUpdates: Partial<ModelCapabilities['use_case']> = {};
  for (const key of ['thinking', 'coding', 'instruct', 'mixture_of_experts'] as const) {
    if (!existing.capabilities.use_case[key] && inferred.capabilities?.use_case?.[key]) {
      useCaseUpdates[key] = true;
    }
  }
  if (
    Object.keys(generationUpdates).length ||
    Object.keys(multimodalUpdates).length ||
    Object.keys(reasoningUpdates).length ||
    Object.keys(useCaseUpdates).length
  ) {
    updates.capabilities = {
      ...(Object.keys(generationUpdates).length ? { generation: generationUpdates } : {}),
      ...(Object.keys(multimodalUpdates).length ? { multimodal: multimodalUpdates } : {}),
      ...(Object.keys(reasoningUpdates).length ? { reasoning: reasoningUpdates } : {}),
      ...(Object.keys(useCaseUpdates).length ? { use_case: useCaseUpdates } : {})
    };
  }
  const modalityUpdates: Partial<ModelModalities> = {};
  if (inferred.modalities?.input?.some((entry) => !existing.modalities.input.includes(entry))) {
    modalityUpdates.input = Array.from(new Set([...existing.modalities.input, ...inferred.modalities.input]));
  }
  if (inferred.modalities?.output?.some((entry) => !existing.modalities.output.includes(entry))) {
    modalityUpdates.output = Array.from(new Set([...existing.modalities.output, ...inferred.modalities.output]));
  }
  if (Object.keys(modalityUpdates).length) {
    updates.modalities = modalityUpdates;
  }
  return updates;
}

export function fetchModels(filters?: {
  active?: boolean;
  archived?: boolean;
  server_id?: string;
  provider?: ModelProvider;
}): ModelRecord[] {
  const models = listModels();
  return models.filter((model) => {
    if (filters?.active !== undefined && model.model.active !== filters.active) {
      return false;
    }
    if (filters?.archived !== undefined && model.model.archived !== filters.archived) {
      return false;
    }
    if (filters?.server_id && model.model.server_id !== filters.server_id) {
      return false;
    }
    if (filters?.provider && model.identity.provider !== filters.provider) {
      return false;
    }
    return true;
  });
}

export function fetchModel(serverId: string, modelId: string): ModelRecord | null {
  return getModelById(serverId, modelId);
}

export function createModelRecord(input: ModelInput): ModelRecord {
  const modelInfo = input.model;
  if (!modelInfo?.model_id) {
    throw new InvalidModelError('model.model_id is required');
  }
  if (!modelInfo.server_id) {
    throw new InvalidModelError('model.server_id is required');
  }
  const modelId = modelInfo.model_id.trim();
  const serverId = modelInfo.server_id.trim();
  if (!modelId) {
    throw new InvalidModelError('model.model_id is required');
  }
  if (!serverId) {
    throw new InvalidModelError('model.server_id is required');
  }
  if (!getInferenceServerById(serverId)) {
    throw new InvalidModelError(`inference server not found: ${serverId}`);
  }
  const displayName = modelInfo.display_name?.trim() || modelId;
  if (getModelById(serverId, modelId)) {
    throw new InvalidModelError(`model already exists: ${serverId}/${modelId}`);
  }

  const now = nowIso();
  const inferredBaseName =
    input.model?.base_model_name !== undefined
      ? (input.model.base_model_name ?? null)
      : extractBaseModelName(modelId);
  const record: ModelRecord = {
    model_schema_version: MODEL_SCHEMA_VERSION,
    model: {
      model_id: modelId,
      server_id: serverId,
      display_name: displayName,
      active: modelInfo.active ?? true,
      archived: modelInfo.archived ?? false,
      created_at: now,
      updated_at: now,
      archived_at: modelInfo.archived_at ?? null,
      base_model_name: inferredBaseName
    },
    identity: mergeIdentity(null, input.identity),
    architecture: mergeArchitecture(null, input.architecture),
    modalities: mergeModalities(null, input.modalities),
    capabilities: mergeCapabilities(null, input.capabilities),
    limits: mergeLimits(null, input.limits),
    performance: mergePerformance(null, input.performance),
    configuration: mergeConfiguration(null, input.configuration),
    discovery: mergeDiscovery(null, input.discovery),
    raw: input.raw ?? {}
  };
  if (record.model.archived && !record.model.archived_at) {
    record.model.archived_at = now;
  }
  validateModelRecord(record);
  return createModel(record);
}

export function updateModelRecord(
  serverId: string,
  modelId: string,
  updates: ModelInput
): ModelRecord | null {
  const existing = getModelById(serverId, modelId);
  if (!existing) {
    return null;
  }
  const { model_id: _modelId, server_id: _serverId, created_at: _createdAt, ...modelUpdates } =
    updates.model ?? {};

  const updated: ModelRecord = {
    ...existing,
    model: {
      ...existing.model,
      ...modelUpdates
    },
    model_schema_version: MODEL_SCHEMA_VERSION,
    identity: mergeIdentity(existing.identity, updates.identity),
    architecture: mergeArchitecture(existing.architecture, updates.architecture),
    modalities: mergeModalities(existing.modalities, updates.modalities),
    capabilities: mergeCapabilities(existing.capabilities, updates.capabilities),
    limits: mergeLimits(existing.limits, updates.limits),
    performance: mergePerformance(existing.performance, updates.performance),
    configuration: mergeConfiguration(existing.configuration, updates.configuration),
    discovery: mergeDiscovery(existing.discovery, updates.discovery),
    raw: updates.raw ?? existing.raw
  };

  if (updates.model?.display_name) {
    updated.model.display_name = updates.model.display_name.trim();
  }
  if (updated.model.archived && !updated.model.archived_at) {
    updated.model.archived_at = nowIso();
  }
  if (!updated.model.archived) {
    updated.model.archived_at = null;
  }
  updated.model.updated_at = nowIso();
  validateModelRecord(updated);
  return updateModel(serverId, modelId, updated);
}

export function upsertModelRecord(input: ModelInput): ModelRecord {
  const modelInfo = input.model;
  if (!modelInfo?.model_id || !modelInfo.server_id) {
    throw new InvalidModelError('model.model_id and model.server_id are required');
  }
  const modelId = modelInfo.model_id.trim();
  const serverId = modelInfo.server_id.trim();
  if (!modelId || !serverId) {
    throw new InvalidModelError('model.model_id and model.server_id are required');
  }
  const existing = getModelById(serverId, modelId);
  if (existing) {
    const updated = updateModelRecord(serverId, modelId, {
      ...input,
      model: { ...modelInfo, model_id: modelId, server_id: serverId }
    });
    if (!updated) {
      throw new InvalidModelError('Unable to update model record');
    }
    return updated;
  }
  return createModelRecord({
    ...input,
    model: { ...modelInfo, model_id: modelId, server_id: serverId }
  });
}

export function upsertDiscoveredModelRecord(input: DiscoveredModelInput): ModelRecord {
  const inferred = inferredModelInput(input);
  const existing = getModelById(input.server_id, input.model_id);
  if (!existing) {
    return createModelRecord(inferred);
  }
  const updates = fillMissingModelInput(existing, inferred);
  updates.discovery = inferred.discovery;
  if (input.raw) {
    updates.raw = { ...existing.raw, ...input.raw };
  }
  const updated = updateModelRecord(input.server_id, input.model_id, updates);
  if (!updated) {
    throw new InvalidModelError('Unable to update discovered model record');
  }
  return updated;
}

export function markAbsentServerModels(serverId: string, presentModelIds: Set<string>): void {
  const serverModels = fetchModels({ server_id: serverId });
  for (const model of serverModels) {
    if (model.discovery.source !== 'server') continue;
    if (presentModelIds.has(model.model.model_id)) continue;
    if (model.discovery.discovery_status === 'absent') continue;
    updateModelRecord(serverId, model.model.model_id, { discovery: { discovery_status: 'absent' } });
  }
}

export function archiveModel(serverId: string, modelId: string): ModelRecord | null {
  const existing = getModelById(serverId, modelId);
  if (!existing) {
    return null;
  }
  return updateModelRecord(serverId, modelId, {
    model: { active: false, archived: true, archived_at: nowIso() }
  });
}

export function unarchiveModel(serverId: string, modelId: string): ModelRecord | null {
  const existing = getModelById(serverId, modelId);
  if (!existing) {
    return null;
  }
  return updateModelRecord(serverId, modelId, {
    model: { archived: false, archived_at: null }
  });
}
