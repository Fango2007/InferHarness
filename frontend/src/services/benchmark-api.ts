import { apiDelete, apiGet, apiPost } from './api.js';
import type { InferenceParams } from './inference-param-presets-api.js';
import type { RunTarget } from './run-unified-utils.js';

export interface BenchmarkInstantiationRecord {
  id: string;
  schema_version: string;
  document_hash: string;
  template_id: string;
  template_version: string;
  server_id: string;
  model_id: string;
  dataset_hash: string;
  status: string;
  document: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkResultRecord {
  id: string;
  schema_version: string;
  document_hash: string;
  instantiation_id: string;
  run_id: string;
  status: string;
  document: BenchmarkRunResultDocument;
  created_at: string;
}

export type BenchmarkDocumentKind = 'test_template' | 'runtime_profile' | 'dataset_manifest' | 'benchmark_plan';

export interface BenchmarkDocumentRecord<TDocument extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: BenchmarkDocumentKind;
  schema_version: string;
  document: TDocument;
  created_at: string;
  updated_at: string;
}

export type BenchmarkLibraryStatus = 'built_in' | 'user' | 'customized' | 'deleted' | 'invalid' | 'conflict';

export interface BenchmarkLibraryEntry {
  kind: BenchmarkDocumentKind;
  id: string;
  status: BenchmarkLibraryStatus;
  source: 'built_in' | 'user' | 'tombstone';
  path: string;
  hash?: string;
  db_hash?: string | null;
  message?: string;
}

export interface BenchmarkLibraryStatusReport {
  built_in_root: string;
  user_root: string;
  entries: BenchmarkLibraryEntry[];
}

export interface BenchmarkLibraryInstallReport {
  installed: BenchmarkLibraryEntry[];
  skipped: BenchmarkLibraryEntry[];
  invalid: BenchmarkLibraryEntry[];
  deleted: BenchmarkLibraryEntry[];
}

export type BenchmarkOperation = 'chat_completion' | 'completion' | 'embedding' | 'list_models' | 'healthcheck';

export interface BenchmarkTestTemplateDocument extends Record<string, unknown> {
  kind: 'test_template';
  schema_version: 'benchmark_test_template_v1';
  template_id: string;
  template_version: string;
  name?: string;
  description?: string;
  operation: BenchmarkOperation;
  required_capabilities?: Record<string, boolean>;
  input_contract?: Record<string, unknown>;
  stages: Array<Record<string, unknown>>;
  metrics: string[];
  aggregations: string[];
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export type BenchmarkTestTemplateRecord = BenchmarkDocumentRecord<BenchmarkTestTemplateDocument>;

export interface BenchmarkRuntimeProfileDocument extends Record<string, unknown> {
  kind: 'runtime_profile';
  schema_version: 'benchmark_runtime_profile_v1';
  profile_id: string;
  runtime_parameters?: Record<string, unknown>;
  execution_policy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface BenchmarkDatasetManifestDocument extends Record<string, unknown> {
  kind: 'dataset_manifest';
  schema_version: 'benchmark_dataset_manifest_v1';
  dataset_id: string;
  source: Record<string, unknown>;
  canonicalization_version?: string;
  snapshot_policy: 'embedded' | 'manifest_only' | 'compressed_blob';
  dataset_hash?: string;
  item_count?: number;
  items?: Array<Record<string, unknown>>;
  item_hashes?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkPlanDocument extends Record<string, unknown> {
  kind: 'benchmark_plan';
  schema_version: 'benchmark_plan_v1';
  plan_id: string;
  template_ref: string;
  dataset_ref: string;
  runtime_profile_ref: string;
  model_profile_refs: string[];
  execution: {
    mode: 'sequential' | 'parallel';
    continue_on_model_error: boolean;
    concurrency?: number;
  };
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface BenchmarkRunResultDocument {
  kind: 'test_run_result';
  schema_version: 'benchmark_test_run_result_v1';
  run_id: string;
  instantiation_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  raw_responses: Array<Record<string, unknown>>;
  normalized_responses: Array<{
    answer_text?: string;
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    stream?: Record<string, unknown> | null;
    [key: string]: unknown;
  }>;
  metric_results: Array<{
    elapsed_ms?: number | null;
    first_token_ms?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    [key: string]: unknown;
  }>;
  errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface BuildBenchmarkSmokeInput {
  target: RunTarget;
  prompt: string;
  systemPrompt?: string | null;
  inferenceParams: InferenceParams;
  timeoutSec: string;
  seed: string;
  dataset?: BenchmarkDatasetInput;
  template?: BenchmarkTestTemplateDocument;
}

export type BenchmarkDatasetFormat = 'json' | 'jsonl' | 'csv';

export type BenchmarkDatasetInput =
  | { mode: 'inline'; prompt: string; systemPrompt?: string | null }
  | { mode: 'manifest_only'; manifest: Record<string, unknown> };

export interface CreateBenchmarkInstantiationPayload {
  template: Record<string, unknown>;
  server_id: string;
  model_id: string;
  runtime_profile: Record<string, unknown>;
  dataset: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface PrepareBenchmarkDatasetManifestInput {
  dataset_id: string;
  source: {
    source_type: 'file' | 'inline';
    format: BenchmarkDatasetFormat;
    path?: string;
  };
  items?: Array<Record<string, unknown>>;
  snapshot_policy?: 'embedded' | 'manifest_only';
  metadata?: Record<string, unknown>;
}

function optionalNumber(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildBenchmarkSmokePayload(input: BuildBenchmarkSmokeInput): CreateBenchmarkInstantiationPayload {
  const stream = input.inferenceParams.stream === true;
  const timeoutValue = Number(input.timeoutSec);
  const seedValue = Number(input.seed);
  const runtimeParameters: Record<string, unknown> = {
    temperature: optionalNumber(input.inferenceParams.temperature),
    top_p: optionalNumber(input.inferenceParams.top_p),
    max_tokens: optionalNumber(input.inferenceParams.max_tokens),
    stream
  };
  if (Number.isFinite(timeoutValue) && timeoutValue > 0) {
    runtimeParameters.timeout_ms = Math.round(timeoutValue * 1000);
  }
  if (input.seed.trim() && Number.isInteger(seedValue)) {
    runtimeParameters.seed = seedValue;
  }

  const datasetInput = input.dataset ?? {
    mode: 'inline',
    prompt: input.prompt,
    systemPrompt: input.systemPrompt
  };
  const dataset = datasetInput.mode === 'manifest_only'
    ? datasetInput.manifest
    : {
        dataset_id: 'run-smoke-inline',
        source: { source_type: 'inline', format: 'json' },
        snapshot_policy: 'embedded',
        items: [
          {
            id: 'item-1',
            prompt: datasetInput.prompt,
            ...(datasetInput.systemPrompt?.trim() ? { system_prompt: datasetInput.systemPrompt.trim() } : {})
          }
        ]
      };

  if (!input.template) {
    throw new Error('A benchmark template is required to build a run payload.');
  }

  return {
    template: input.template,
    server_id: input.target.inference_server_id,
    model_id: input.target.model_id,
    runtime_profile: {
      kind: 'runtime_profile',
      schema_version: 'benchmark_runtime_profile_v1',
      profile_id: 'run-smoke-runtime',
      runtime_parameters: runtimeParameters,
      execution_policy: {
        ...(runtimeParameters.timeout_ms ? { timeout_ms: runtimeParameters.timeout_ms } : {})
      }
    },
    dataset,
    metadata: {
      source: 'run-page-smoke'
    }
  };
}

export async function prepareBenchmarkDatasetManifest(
  input: PrepareBenchmarkDatasetManifestInput
): Promise<Record<string, unknown>> {
  const response = await apiPost<{ manifest: Record<string, unknown> }>('/benchmark/datasets/manifest', input);
  return response.manifest;
}

export async function createBenchmarkInstantiation(
  payload: CreateBenchmarkInstantiationPayload
): Promise<BenchmarkInstantiationRecord> {
  return apiPost<BenchmarkInstantiationRecord>('/benchmark/instantiations', payload);
}

export async function runBenchmarkInstantiation(id: string): Promise<BenchmarkResultRecord> {
  return apiPost<BenchmarkResultRecord>(`/benchmark/instantiations/${id}/run`, {});
}

export async function getBenchmarkResult(id: string): Promise<BenchmarkResultRecord> {
  return apiGet<BenchmarkResultRecord>(`/benchmark/results/${id}`);
}

export async function listBenchmarkDocuments<TDocument extends Record<string, unknown> = Record<string, unknown>>(
  kind: BenchmarkDocumentKind
): Promise<Array<BenchmarkDocumentRecord<TDocument>>> {
  return apiGet<Array<BenchmarkDocumentRecord<TDocument>>>(`/benchmark/documents/${kind}`);
}

export async function saveBenchmarkDocument<TDocument extends Record<string, unknown>>(
  document: TDocument
): Promise<BenchmarkDocumentRecord<TDocument>> {
  return apiPost<BenchmarkDocumentRecord<TDocument>>('/benchmark/documents', document);
}

export interface TemplateAgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TemplateAgentRequest {
  mode: 'create' | 'modify';
  message: string;
  conversation?: TemplateAgentMessage[];
  existing_template?: BenchmarkTestTemplateDocument;
}

export type TemplateAgentResponse =
  | { status: 'needs_input'; reply: string; questions?: string[] }
  | { status: 'draft_ready'; reply: string; template: BenchmarkTestTemplateDocument; validation: { ok: true; issues: [] } };

export async function runTemplateAgent(payload: TemplateAgentRequest): Promise<TemplateAgentResponse> {
  return apiPost<TemplateAgentResponse>('/benchmark/template-agent', payload);
}

export async function deleteBenchmarkDocument(kind: BenchmarkDocumentKind, id: string): Promise<void> {
  await apiDelete(`/benchmark/documents/${kind}/${id}`);
}

export async function getBenchmarkLibraryStatus(): Promise<BenchmarkLibraryStatusReport> {
  return apiGet<BenchmarkLibraryStatusReport>('/benchmark/library');
}

export async function reloadBenchmarkLibrary(): Promise<BenchmarkLibraryInstallReport> {
  return apiPost<BenchmarkLibraryInstallReport>('/benchmark/library/reload', {});
}

export interface BenchmarkPlanRunResult {
  model_profile_ref: string;
  instantiation_id: string;
  run_id: string | null;
  status: string;
}

export interface BenchmarkPlanResult {
  kind: 'benchmark_plan_result';
  plan_version: 'benchmark_plan_result_v1';
  plan_id: string;
  run_results: BenchmarkPlanRunResult[];
  comparison: {
    metrics: Record<string, Record<string, number | null>>;
  };
}

export interface BenchmarkPlanPayload {
  plan_id?: string;
  template: Record<string, unknown>;
  dataset: Record<string, unknown>;
  runtime_profile: Record<string, unknown>;
  targets: { server_id: string; model_id: string }[];
  continue_on_model_error?: boolean;
}

export async function runBenchmarkPlan(payload: BenchmarkPlanPayload): Promise<BenchmarkPlanResult> {
  return apiPost<BenchmarkPlanResult>('/benchmark/plans/run', payload);
}

export async function saveBenchmarkPlan(document: BenchmarkPlanDocument): Promise<BenchmarkDocumentRecord<BenchmarkPlanDocument>> {
  return apiPost<BenchmarkDocumentRecord<BenchmarkPlanDocument>>('/benchmark/plans', document);
}

export async function runPersistedBenchmarkPlan(id: string): Promise<BenchmarkPlanResult> {
  return apiPost<BenchmarkPlanResult>(`/benchmark/plans/${id}/run`, {});
}

export async function getBenchmarkInstantiation(id: string): Promise<BenchmarkInstantiationRecord> {
  return apiGet<BenchmarkInstantiationRecord>(`/benchmark/instantiations/${id}`);
}

export function buildPersistedBenchmarkPlanDocument(input: {
  planId: string;
  templateRef: string;
  datasetRef: string;
  runtimeProfileRef: string;
  targets: RunTarget[];
  continueOnModelError?: boolean;
  metadata?: Record<string, unknown>;
}): BenchmarkPlanDocument {
  return {
    kind: 'benchmark_plan',
    schema_version: 'benchmark_plan_v1',
    plan_id: input.planId,
    template_ref: input.templateRef,
    dataset_ref: input.datasetRef,
    runtime_profile_ref: input.runtimeProfileRef,
    model_profile_refs: input.targets.map((target) => `${target.inference_server_id}:${target.model_id}`),
    execution: {
      mode: 'sequential',
      continue_on_model_error: input.continueOnModelError ?? true,
      concurrency: 1
    },
    metadata: input.metadata
  };
}

export function buildBenchmarkPlanPayload(input: {
  targets: RunTarget[];
  prompt: string;
  systemPrompt?: string | null;
  inferenceParams: InferenceParams;
  timeoutSec: string;
  seed: string;
  dataset?: BenchmarkDatasetInput;
  template?: BenchmarkTestTemplateDocument;
}): BenchmarkPlanPayload {
  const first = buildBenchmarkSmokePayload({ ...input, target: input.targets[0] });
  return {
    template: first.template,
    dataset: first.dataset as Record<string, unknown>,
    runtime_profile: first.runtime_profile,
    targets: input.targets.map((t) => ({ server_id: t.inference_server_id, model_id: t.model_id }))
  };
}
