import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/benchmark-foundation.js', () => ({
  BenchmarkValidationError: class BenchmarkValidationError extends Error {
    issues: unknown[];
    constructor(message: string, issues: unknown[] = []) {
      super(message);
      this.name = 'BenchmarkValidationError';
      this.issues = issues;
    }
  },
  persistBenchmarkInstantiation: vi.fn()
}));

vi.mock('../../src/services/benchmark-runner.js', () => ({
  runBenchmarkInstantiation: vi.fn()
}));

import { persistBenchmarkInstantiation } from '../../src/services/benchmark-foundation.js';
import { runBenchmarkInstantiation } from '../../src/services/benchmark-runner.js';
import { buildComparison, runBenchmarkPlan } from '../../src/services/benchmark-plan-runner.js';
import type { BenchmarkPlanRunResult } from '../../src/services/benchmark-plan-runner.js';

const mockPersist = vi.mocked(persistBenchmarkInstantiation);
const mockRun = vi.mocked(runBenchmarkInstantiation);

function fakeInstantiation(id: string) {
  return { id, schema_version: 'v1', document_hash: 'h', template_id: 't', template_version: '1', server_id: 's', model_id: 'm', dataset_hash: 'd', status: 'created', document: {}, created_at: '', updated_at: '' };
}

function fakeResult(runId: string, status: string, aggregatedMetrics: Record<string, unknown> = {}) {
  return {
    id: runId,
    schema_version: 'v1',
    document_hash: 'h',
    instantiation_id: 'inst-1',
    run_id: runId,
    status,
    document: { kind: 'test_run_result', status, aggregated_metrics: aggregatedMetrics },
    created_at: ''
  };
}

describe('buildComparison', () => {
  it('returns empty metrics when no requested metrics', () => {
    const result = buildComparison([], new Map(), []);
    expect(result).toEqual({ metrics: {} });
  });

  it('builds metric matrix from aggregated_metrics.mean', () => {
    const runResults: BenchmarkPlanRunResult[] = [
      { model_profile_ref: 'srv:m1', instantiation_id: 'i1', run_id: 'r1', status: 'completed' },
      { model_profile_ref: 'srv:m2', instantiation_id: 'i2', run_id: 'r2', status: 'completed' }
    ];
    const resultDocs = new Map<string, Record<string, unknown>>([
      ['srv:m1', { aggregated_metrics: { elapsed_ms: { mean: 500 }, tokens_per_second: { mean: 20 } } }],
      ['srv:m2', { aggregated_metrics: { elapsed_ms: { mean: 300 }, tokens_per_second: { mean: 35 } } }]
    ]);
    const result = buildComparison(runResults, resultDocs, ['elapsed_ms', 'tokens_per_second']);
    expect(result.metrics.elapsed_ms['srv:m1']).toBe(500);
    expect(result.metrics.elapsed_ms['srv:m2']).toBe(300);
    expect(result.metrics.tokens_per_second['srv:m1']).toBe(20);
    expect(result.metrics.tokens_per_second['srv:m2']).toBe(35);
  });

  it('uses success_rate for boolean metrics', () => {
    const runResults: BenchmarkPlanRunResult[] = [
      { model_profile_ref: 'srv:m1', instantiation_id: 'i1', run_id: 'r1', status: 'completed' }
    ];
    const resultDocs = new Map<string, Record<string, unknown>>([
      ['srv:m1', { aggregated_metrics: { exact_match: { success_rate: 0.75 } } }]
    ]);
    const result = buildComparison(runResults, resultDocs, ['exact_match']);
    expect(result.metrics.exact_match['srv:m1']).toBe(0.75);
  });

  it('returns null for missing model', () => {
    const runResults: BenchmarkPlanRunResult[] = [
      { model_profile_ref: 'srv:m1', instantiation_id: '', run_id: null, status: 'failed' }
    ];
    const resultDocs = new Map<string, Record<string, unknown>>();
    const result = buildComparison(runResults, resultDocs, ['elapsed_ms']);
    expect(result.metrics.elapsed_ms['srv:m1']).toBeNull();
  });

  it('returns null for missing metric in aggregated_metrics', () => {
    const runResults: BenchmarkPlanRunResult[] = [
      { model_profile_ref: 'srv:m1', instantiation_id: 'i1', run_id: 'r1', status: 'completed' }
    ];
    const resultDocs = new Map<string, Record<string, unknown>>([
      ['srv:m1', { aggregated_metrics: {} }]
    ]);
    const result = buildComparison(runResults, resultDocs, ['elapsed_ms']);
    expect(result.metrics.elapsed_ms['srv:m1']).toBeNull();
  });
});

describe('runBenchmarkPlan', () => {
  const template = {
    kind: 'test_template',
    template_id: 'plan-tpl',
    template_version: '1.0.0',
    metrics: ['elapsed_ms', 'tokens_per_second']
  };
  const dataset = { kind: 'dataset_manifest', dataset_id: 'ds' };
  const runtime_profile = { kind: 'runtime_profile', profile_id: 'rt' };
  const targets = [
    { server_id: 'srv', model_id: 'model-a' },
    { server_id: 'srv', model_id: 'model-b' }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when targets is empty', async () => {
    await expect(runBenchmarkPlan({ template, dataset, runtime_profile, targets: [] }))
      .rejects.toThrow('at least one target');
  });

  it('returns benchmark_plan_result shape with two targets', async () => {
    mockPersist
      .mockReturnValueOnce(fakeInstantiation('inst-a'))
      .mockReturnValueOnce(fakeInstantiation('inst-b'));
    mockRun
      .mockResolvedValueOnce(fakeResult('run-a', 'completed', { elapsed_ms: { mean: 400 } }))
      .mockResolvedValueOnce(fakeResult('run-b', 'completed', { elapsed_ms: { mean: 200 } }));

    const result = await runBenchmarkPlan({ plan_id: 'plan-1', template, dataset, runtime_profile, targets });

    expect(result.kind).toBe('benchmark_plan_result');
    expect(result.plan_version).toBe('benchmark_plan_result_v1');
    expect(result.plan_id).toBe('plan-1');
    expect(result.run_results).toHaveLength(2);
    expect(result.run_results[0].model_profile_ref).toBe('srv:model-a');
    expect(result.run_results[1].model_profile_ref).toBe('srv:model-b');
    expect(result.run_results[0].status).toBe('completed');
    expect(result.comparison.metrics.elapsed_ms?.['srv:model-a']).toBe(400);
    expect(result.comparison.metrics.elapsed_ms?.['srv:model-b']).toBe(200);
  });

  it('continues on model error when continue_on_model_error is true', async () => {
    mockPersist
      .mockReturnValueOnce(fakeInstantiation('inst-a'))
      .mockReturnValueOnce(fakeInstantiation('inst-b'));
    mockRun
      .mockRejectedValueOnce(new Error('model-a failed'))
      .mockResolvedValueOnce(fakeResult('run-b', 'completed', {}));

    const result = await runBenchmarkPlan({ template, dataset, runtime_profile, targets, continue_on_model_error: true });

    expect(result.run_results).toHaveLength(2);
    expect(result.run_results[0].status).toBe('failed');
    expect(result.run_results[0].run_id).toBeNull();
    expect(result.run_results[1].status).toBe('completed');
  });

  it('stops after first failure when continue_on_model_error is false', async () => {
    mockPersist.mockReturnValueOnce(fakeInstantiation('inst-a'));
    mockRun.mockRejectedValueOnce(new Error('model-a failed'));

    const result = await runBenchmarkPlan({ template, dataset, runtime_profile, targets, continue_on_model_error: false });

    expect(result.run_results).toHaveLength(1);
    expect(result.run_results[0].status).toBe('failed');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('generates plan_id when not provided', async () => {
    mockPersist.mockReturnValueOnce(fakeInstantiation('inst-a'));
    mockRun.mockResolvedValueOnce(fakeResult('run-a', 'completed', {}));

    const result = await runBenchmarkPlan({ template, dataset, runtime_profile, targets: [targets[0]] });
    expect(result.plan_id).toMatch(/^plan_/);
  });

  it('passes metadata with plan_id to persistBenchmarkInstantiation', async () => {
    mockPersist.mockReturnValueOnce(fakeInstantiation('inst-a'));
    mockRun.mockResolvedValueOnce(fakeResult('run-a', 'completed', {}));

    await runBenchmarkPlan({ plan_id: 'p42', template, dataset, runtime_profile, targets: [targets[0]] });

    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ plan_id: 'p42' }) })
    );
  });
});
