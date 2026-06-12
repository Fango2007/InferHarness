import { getModelById } from '../models/model.js';
import { BenchmarkNotFoundError, BenchmarkValidationError } from './benchmark-foundation.js';
import { validateBenchmarkDocument } from './benchmark-schemas.js';
import { getBenchmarkDocument } from './benchmark-document-store.js';
import type { RunBenchmarkPlanInput } from './benchmark-plan-runner.js';

export function resolveBenchmarkPlan(plan: Record<string, unknown>): RunBenchmarkPlanInput {
  const validation = validateBenchmarkDocument('benchmark_plan', plan);
  if (!validation.ok) {
    throw new BenchmarkValidationError('Invalid benchmark benchmark_plan document', validation.issues);
  }

  const execution = plan.execution as { mode: string; continue_on_model_error: boolean };
  if (execution.mode === 'parallel') {
    throw new BenchmarkValidationError('benchmark_plan execution.mode=parallel is not supported in this checkpoint.');
  }

  const targets = (plan.model_profile_refs as string[]).map(resolveModelProfileRef);

  return {
    plan_id: String(plan.plan_id),
    template: resolveDocumentRef('test_template', String(plan.template_ref)),
    dataset: resolveDocumentRef('dataset_manifest', String(plan.dataset_ref)),
    runtime_profile: resolveDocumentRef('runtime_profile', String(plan.runtime_profile_ref)),
    targets,
    continue_on_model_error: execution.continue_on_model_error
  };
}

function resolveDocumentRef(
  kind: 'test_template' | 'dataset_manifest' | 'runtime_profile',
  ref: string
): Record<string, unknown> {
  try {
    return getBenchmarkDocument(kind, ref).document;
  } catch (error) {
    if (error instanceof BenchmarkNotFoundError) {
      throw new BenchmarkValidationError(`Benchmark plan ${kind} ref not found: ${ref}`);
    }
    throw error;
  }
}

function resolveModelProfileRef(ref: string): { server_id: string; model_id: string } {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) {
    throw new BenchmarkValidationError(`Invalid model_profile_ref: ${ref}. Expected server_id:model_id.`);
  }
  const serverId = ref.slice(0, separator);
  const modelId = ref.slice(separator + 1);
  const model = getModelById(serverId, modelId);
  if (!model) {
    throw new BenchmarkValidationError(`Benchmark plan model_profile_ref not found: ${ref}`);
  }
  return { server_id: serverId, model_id: modelId };
}
