import crypto from 'crypto';

import type { InstantiateBenchmarkInput } from './benchmark-foundation.js';
import { BenchmarkValidationError, persistBenchmarkInstantiation } from './benchmark-foundation.js';
import { runBenchmarkInstantiation } from './benchmark-runner.js';

export interface BenchmarkPlanTarget {
  server_id: string;
  model_id: string;
}

export interface RunBenchmarkPlanInput {
  plan_id?: string;
  template: Record<string, unknown>;
  dataset: Record<string, unknown>;
  runtime_profile: Record<string, unknown>;
  targets: BenchmarkPlanTarget[];
  continue_on_model_error?: boolean;
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

function requestedMetrics(template: Record<string, unknown>): string[] {
  return Array.isArray(template.metrics) ? (template.metrics as string[]) : [];
}

export function buildComparison(
  runResults: BenchmarkPlanRunResult[],
  resultDocs: Map<string, Record<string, unknown>>,
  metrics: string[]
): BenchmarkPlanResult['comparison'] {
  const matrix: Record<string, Record<string, number | null>> = {};
  for (const metric of metrics) {
    const row: Record<string, number | null> = {};
    for (const run of runResults) {
      const doc = resultDocs.get(run.model_profile_ref);
      if (!doc) {
        row[run.model_profile_ref] = null;
        continue;
      }
      const agg = doc.aggregated_metrics as Record<string, Record<string, unknown>> | undefined;
      const entry = agg?.[metric];
      if (!entry) {
        row[run.model_profile_ref] = null;
        continue;
      }
      const val = typeof entry.mean === 'number' ? entry.mean
        : typeof entry.success_rate === 'number' ? entry.success_rate
        : null;
      row[run.model_profile_ref] = val;
    }
    matrix[metric] = row;
  }
  return { metrics: matrix };
}

export async function runBenchmarkPlan(input: RunBenchmarkPlanInput): Promise<BenchmarkPlanResult> {
  const {
    plan_id = `plan_${crypto.randomUUID()}`,
    template,
    dataset,
    runtime_profile,
    targets,
    continue_on_model_error = true
  } = input;

  if (targets.length === 0) {
    throw new BenchmarkValidationError('runBenchmarkPlan requires at least one target.');
  }

  const metrics = requestedMetrics(template);
  const runResults: BenchmarkPlanRunResult[] = [];
  const resultDocs = new Map<string, Record<string, unknown>>();

  for (const target of targets) {
    const modelProfileRef = `${target.server_id}:${target.model_id}`;
    try {
      const instantiationInput: InstantiateBenchmarkInput = {
        template,
        server_id: target.server_id,
        model_id: target.model_id,
        dataset,
        runtime_profile,
        metadata: { source: 'benchmark-plan', plan_id }
      };
      const instantiation = persistBenchmarkInstantiation(instantiationInput);
      const result = await runBenchmarkInstantiation(instantiation.id);
      const doc = result.document as Record<string, unknown>;
      runResults.push({
        model_profile_ref: modelProfileRef,
        instantiation_id: instantiation.id,
        run_id: result.run_id,
        status: String(doc.status ?? 'failed')
      });
      resultDocs.set(modelProfileRef, doc);
    } catch {
      runResults.push({
        model_profile_ref: modelProfileRef,
        instantiation_id: '',
        run_id: null,
        status: 'failed'
      });
      if (!continue_on_model_error) {
        break;
      }
    }
  }

  return {
    kind: 'benchmark_plan_result',
    plan_version: 'benchmark_plan_result_v1',
    plan_id,
    run_results: runResults,
    comparison: buildComparison(runResults, resultDocs, metrics)
  };
}
