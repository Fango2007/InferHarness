import { apiGet, apiPost } from './api.js';
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
    source_type: 'file';
    format: BenchmarkDatasetFormat;
    path: string;
  };
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

  return {
    template: {
      kind: 'test_template',
      schema_version: 'benchmark_test_template_v1',
      template_id: 'run-smoke-chat',
      template_version: '1.0.0',
      name: 'Run smoke chat',
      description: 'One prompt smoke test from the Run page.',
      operation: 'chat_completion',
      required_capabilities: {
        chat_completion: true,
        streaming: stream,
        tool_calling: false,
        structured_output: false
      },
      stages: [
        {
          id: 'chat',
          type: 'dataset_loop',
          iterations_per_item: 1,
          record_metrics: true,
          stop_on_error: false
        }
      ],
      metrics: ['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms', 'first_token_ms', 'tokens_per_second', 'decode_tokens_per_second', 'prefill_tokens_per_second'],
      aggregations: ['mean', 'p95', 'count']
    },
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

export function buildBenchmarkPlanPayload(input: {
  targets: RunTarget[];
  prompt: string;
  systemPrompt?: string | null;
  inferenceParams: InferenceParams;
  timeoutSec: string;
  seed: string;
  dataset?: BenchmarkDatasetInput;
}): BenchmarkPlanPayload {
  const first = buildBenchmarkSmokePayload({ ...input, target: input.targets[0] });
  return {
    template: first.template,
    dataset: first.dataset as Record<string, unknown>,
    runtime_profile: first.runtime_profile,
    targets: input.targets.map((t) => ({ server_id: t.inference_server_id, model_id: t.model_id }))
  };
}
