import crypto from 'crypto';

import {
  createBenchmarkInstantiation,
  createBenchmarkResult,
  getBenchmarkInstantiation,
  getBenchmarkResult
} from '../models/benchmark.js';
import { getInferenceServerById } from '../models/inference-server.js';
import { getModelById } from '../models/model.js';
import { nowIso } from '../models/repositories.js';
import {
  BenchmarkKind,
  benchmarkKindFromDocument,
  sha256Document,
  validateBenchmarkDocument
} from './benchmark-schemas.js';

export class BenchmarkValidationError extends Error {
  issues: Array<{ message: string; path?: string }>;

  constructor(message: string, issues: Array<{ message: string; path?: string }> = []) {
    super(message);
    this.name = 'BenchmarkValidationError';
    this.issues = issues;
  }
}

export class BenchmarkNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkNotFoundError';
  }
}

export interface BuildDatasetManifestInput {
  dataset_id: string;
  source: {
    source_type: 'inline' | 'file' | 'url';
    format: 'json' | 'jsonl' | 'csv';
    path?: string;
    url?: string;
    description?: string;
  };
  snapshot_policy?: 'embedded' | 'manifest_only' | 'compressed_blob';
  items?: Array<Record<string, unknown>>;
  item_count?: number;
  dataset_hash?: string;
  item_manifest_ref?: Record<string, unknown> | null;
  snapshot_blob_ref?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface InstantiateBenchmarkInput {
  template: Record<string, unknown>;
  server_id: string;
  model_id: string;
  dataset: BuildDatasetManifestInput | Record<string, unknown>;
  runtime_profile?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertValid(kind: BenchmarkKind, document: Record<string, unknown>): void {
  const validation = validateBenchmarkDocument(kind, document);
  if (!validation.ok) {
    throw new BenchmarkValidationError(
      `Invalid benchmark ${kind} document`,
      validation.issues
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

function redactAuth(auth: Record<string, unknown>): Record<string, unknown> {
  return {
    ...auth,
    token: null,
    token_present: Boolean(auth.token || auth.token_present)
  };
}

function modelProfileModel(model: ReturnType<typeof getModelById>): Record<string, unknown> {
  if (!model) {
    return {};
  }
  return {
    model_id: model.model.model_id,
    server_id: model.model.server_id,
    display_name: model.model.display_name,
    base_model_name: model.model.base_model_name
  };
}

function minimalServerRuntime(server: ReturnType<typeof getInferenceServerById>): Record<string, unknown> {
  if (!server) {
    return {};
  }
  return {
    retrieved_at: server.runtime.retrieved_at,
    source: server.runtime.source,
    server_software: server.runtime.server_software,
    api: server.runtime.api
  };
}

export function buildDatasetManifest(input: BuildDatasetManifestInput): Record<string, unknown> {
  const snapshotPolicy = input.snapshot_policy ?? 'manifest_only';
  if (snapshotPolicy === 'compressed_blob' && !input.snapshot_blob_ref) {
    throw new BenchmarkValidationError('compressed_blob datasets require snapshot_blob_ref in this checkpoint.');
  }
  const items = input.items ?? [];
  const itemCount = input.item_count ?? items.length;
  const itemHashes =
    items.length > 0
      ? items.map((item, index) => ({
          item_id: String(item.id ?? index),
          hash: sha256Document(item)
        }))
      : undefined;
  const datasetHash =
    input.dataset_hash ??
    sha256Document({
      source: input.source,
      canonicalization_version: 'dataset_canonical_v1',
      item_count: itemCount,
      items
    });

  const manifest = stripUndefined({
    kind: 'dataset_manifest',
    schema_version: 'benchmark_dataset_manifest_v1',
    dataset_id: input.dataset_id,
    source: input.source,
    canonicalization_version: 'dataset_canonical_v1',
    snapshot_policy: snapshotPolicy,
    dataset_hash: datasetHash,
    item_count: itemCount,
    items: snapshotPolicy === 'embedded' ? items : undefined,
    item_hashes: itemHashes,
    item_manifest_ref: input.item_manifest_ref,
    snapshot_blob_ref: input.snapshot_blob_ref,
    metadata: input.metadata
  });
  assertValid('dataset_manifest', manifest);
  return manifest;
}

export function captureModelSnapshot(serverId: string, modelId: string): Record<string, unknown> {
  const model = getModelById(serverId, modelId);
  if (!model) {
    throw new BenchmarkNotFoundError(`Model not found: ${serverId}/${modelId}`);
  }
  const server = getInferenceServerById(serverId);
  if (!server) {
    throw new BenchmarkNotFoundError(`Inference server not found: ${serverId}`);
  }

  const snapshot = {
    kind: 'model_snapshot',
    schema_version: 'benchmark_model_snapshot_v1',
    model: model.model,
    identity: model.identity,
    architecture: model.architecture,
    modalities: model.modalities,
    model_capabilities: model.capabilities,
    limits: model.limits,
    performance: model.performance,
    configuration: model.configuration,
    inference_server: server.inference_server,
    runtime: server.runtime,
    endpoints: server.endpoints,
    auth: redactAuth(server.auth as unknown as Record<string, unknown>),
    capabilities: server.capabilities,
    discovery: server.discovery,
    raw: server.raw,
    model_metadata: {},
    snapshot_quality: {
      completeness: 'partial',
      sources: ['server_config', 'user_declared'],
      warnings: []
    }
  };
  assertValid('model_snapshot', snapshot);
  return snapshot;
}

function buildModelProfile(serverId: string, modelId: string): Record<string, unknown> {
  const model = getModelById(serverId, modelId);
  const server = getInferenceServerById(serverId);
  if (!model) {
    throw new BenchmarkNotFoundError(`Model not found: ${serverId}/${modelId}`);
  }
  if (!server) {
    throw new BenchmarkNotFoundError(`Inference server not found: ${serverId}`);
  }
  const profile = stripUndefined({
    kind: 'model_profile',
    schema_version: 'benchmark_model_profile_v1',
    profile_id: `${serverId}:${modelId}`,
    model: modelProfileModel(model),
    identity: model.identity,
    architecture: model.architecture,
    model_capabilities: model.capabilities,
    inference_server: server.inference_server,
    runtime: minimalServerRuntime(server),
    endpoints: server.endpoints,
    auth: redactAuth(server.auth as unknown as Record<string, unknown>),
    capabilities: server.capabilities,
    discovery: server.discovery,
    raw: server.raw
  });
  assertValid('model_profile', profile);
  return profile;
}

function requiredCapability(template: Record<string, unknown>, key: string): boolean {
  const required = template.required_capabilities as Record<string, unknown> | undefined;
  return required?.[key] === true;
}

function assertCapabilities(template: Record<string, unknown>, snapshot: Record<string, unknown>): void {
  const serverCaps = snapshot.capabilities as {
    generation?: Record<string, boolean>;
    server?: Record<string, boolean>;
  };
  const modelCaps = snapshot.model_capabilities as {
    generation?: Record<string, boolean>;
  };
  const failures: string[] = [];
  if (requiredCapability(template, 'tool_calling') && !modelCaps.generation?.tools && !serverCaps.generation?.tools) {
    failures.push('Tool calling is enabled for this benchmark, but the selected model/server is not marked as tool-capable. Disable tool calling or enable Tools on the model/server.');
  }
  if (requiredCapability(template, 'structured_output') && !modelCaps.generation?.json_schema_output && !serverCaps.generation?.json_schema_output) {
    failures.push('Structured output is enabled for this benchmark, but the selected model/server is not marked as structured-output capable. Disable structured output or enable JSON schema output on the model/server.');
  }
  if (requiredCapability(template, 'streaming') && !serverCaps.server?.streaming) {
    failures.push('Streaming is enabled for this run, but the selected server is not marked as streaming-capable. Disable Stream or enable Streaming on the server.');
  }
  if (failures.length > 0) {
    throw new BenchmarkValidationError('Benchmark required capabilities are not satisfied.', failures.map((message) => ({ message })));
  }
}

export function resolveOperationSpec(
  template: Record<string, unknown>,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const operation = String(template.operation ?? 'chat_completion');
  const runtime = snapshot.runtime as { api?: { schema_family?: string[] } };
  const endpoints = snapshot.endpoints as { base_url?: string };
  const schemaFamily = runtime.api?.schema_family ?? [];
  const baseUrl = endpoints.base_url ?? '';

  if (operation !== 'chat_completion') {
    throw new BenchmarkValidationError(`Only chat_completion operation resolution is supported in this checkpoint.`);
  }
  if (!baseUrl) {
    throw new BenchmarkValidationError('Benchmark operation resolution requires an inference server base URL.');
  }
  if (schemaFamily.includes('ollama')) {
    return {
      method: 'POST',
      url: new URL('/api/chat', baseUrl).toString(),
      endpoint: '/api/chat',
      protocol: 'ollama_chat',
      operation,
      supports_streaming: Boolean((snapshot.capabilities as { server?: { streaming?: boolean } }).server?.streaming),
      supports_usage: false
    };
  }
  if (schemaFamily.includes('openai-compatible')) {
    return {
      method: 'POST',
      url: new URL('/v1/chat/completions', baseUrl).toString(),
      endpoint: '/v1/chat/completions',
      protocol: 'openai_chat',
      operation,
      supports_streaming: Boolean((snapshot.capabilities as { server?: { streaming?: boolean } }).server?.streaming),
      supports_usage: false
    };
  }
  throw new BenchmarkValidationError(`Unsupported API schema family for chat_completion: ${schemaFamily.join(',') || 'none'}`);
}

function runtimeParameters(runtimeProfile: Record<string, unknown> | undefined): Record<string, unknown> {
  return ((runtimeProfile?.runtime_parameters as Record<string, unknown> | undefined) ?? {});
}

function executionPolicy(runtimeProfile: Record<string, unknown> | undefined): Record<string, unknown> {
  return ((runtimeProfile?.execution_policy as Record<string, unknown> | undefined) ?? {});
}

export function buildBenchmarkInstantiationDocument(input: InstantiateBenchmarkInput): Record<string, unknown> {
  assertValid('test_template', input.template);
  if (input.runtime_profile) {
    assertValid('runtime_profile', input.runtime_profile);
  }
  const modelProfile = buildModelProfile(input.server_id, input.model_id);
  const modelSnapshot = captureModelSnapshot(input.server_id, input.model_id);
  assertCapabilities(input.template, modelSnapshot);
  const operationSpec = resolveOperationSpec(input.template, modelSnapshot);
  const dataset =
    'kind' in input.dataset && (input.dataset as Record<string, unknown>).kind === 'dataset_manifest'
      ? input.dataset as Record<string, unknown>
      : buildDatasetManifest(input.dataset as BuildDatasetManifestInput);
  assertValid('dataset_manifest', dataset);

  const instantiation = stripUndefined({
    kind: 'test_instantiation',
    schema_version: 'benchmark_test_instantiation_v1',
    instantiation_id: randomId('bti'),
    created_at: nowIso(),
    template: {
      template_id: String(input.template.template_id),
      template_version: String(input.template.template_version),
      template_hash: sha256Document(input.template),
      snapshot: input.template
    },
    model_profile: modelProfile,
    model_snapshot: modelSnapshot,
    model_snapshot_hash: sha256Document(modelSnapshot),
    operation_spec: operationSpec,
    runtime_parameters: runtimeParameters(input.runtime_profile),
    execution_policy: executionPolicy(input.runtime_profile),
    dataset,
    metadata: input.metadata
  });
  assertValid('test_instantiation', instantiation);
  return instantiation;
}

export function persistBenchmarkInstantiation(input: InstantiateBenchmarkInput) {
  const document = buildBenchmarkInstantiationDocument(input);
  const id = String(document.instantiation_id);
  return createBenchmarkInstantiation({
    id,
    schema_version: String(document.schema_version),
    document_hash: sha256Document(document),
    template_id: String((document.template as Record<string, unknown>).template_id),
    template_version: String((document.template as Record<string, unknown>).template_version),
    server_id: input.server_id,
    model_id: input.model_id,
    dataset_hash: String((document.dataset as Record<string, unknown>).dataset_hash),
    document
  });
}

export function persistBenchmarkResult(document: Record<string, unknown>) {
  assertValid('test_run_result', document);
  const instantiationId = String(document.instantiation_id);
  if (!getBenchmarkInstantiation(instantiationId)) {
    throw new BenchmarkNotFoundError(`Benchmark instantiation not found: ${instantiationId}`);
  }
  return createBenchmarkResult({
    id: String(document.run_id),
    schema_version: String(document.schema_version),
    document_hash: sha256Document(document),
    instantiation_id: instantiationId,
    run_id: String(document.run_id),
    status: String(document.status),
    document
  });
}

export function validateAnyBenchmarkDocument(document: unknown, explicitKind?: BenchmarkKind) {
  const kind = explicitKind ?? benchmarkKindFromDocument(document);
  if (!kind) {
    throw new BenchmarkValidationError('Unable to determine benchmark schema kind.', [
      { message: 'Provide a supported kind or a document with kind/schema_version.' }
    ]);
  }
  return validateBenchmarkDocument(kind, document);
}

export { getBenchmarkInstantiation, getBenchmarkResult };
