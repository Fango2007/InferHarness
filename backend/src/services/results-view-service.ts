import { getDb } from '../models/db.js';
import { parseJson } from '../models/repositories.js';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const MAX_SOURCE_ROWS = 10000;

type SortBy = 'started_at' | 'status' | 'model' | 'server' | 'template' | 'score' | 'latency' | 'cost';
type SortDir = 'asc' | 'desc';

type RuntimeSnapshot = {
  server_software?: { version?: string | null };
  api?: { api_version?: string | null; schema_family?: string[] };
  version?: string | null;
};

type EnvironmentSnapshot = {
  effective_config?: { model?: string | null };
  model?: string | null;
};

type ResultDocument = {
  test?: { tags?: string[]; type?: string | null };
  steps?: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  selected_model?: { id?: string | null } | null;
};

type BenchmarkStageResult = {
  stage_id?: string;
  stage_type?: string;
  status?: string;
  run_count?: number;
  results?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
};

type BenchmarkDocument = {
  run_id?: string;
  instantiation_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string | null;
  instantiation_snapshot?: Record<string, unknown>;
  stage_results?: BenchmarkStageResult[];
  raw_responses?: Array<Record<string, unknown>>;
  normalized_responses?: Array<Record<string, unknown>>;
  metric_results?: Array<Record<string, unknown>>;
  aggregated_metrics?: Record<string, Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  load_estimate?: Record<string, unknown> | null;
};

type BenchmarkResultRow = {
  id: string;
  run_id: string;
  status: string;
  created_at: string;
  document: string;
  instantiation_id: string;
  template_id: string;
  server_id: string;
  model_id: string;
  instantiation_document: string;
  server_display_name: string | null;
  server_runtime: string | null;
};

export interface ResultsFilterState {
  date_from: string;
  date_to: string;
  server_ids: string[];
  model_names: string[];
  template_ids: string[];
  statuses: string[];
  tags: string[];
  score_min: number | null;
  score_max: number | null;
  sort_by: SortBy;
  sort_dir: SortDir;
  page: number;
  page_size: number;
}

export interface ResultsHistoryRow {
  run_id: string;
  status: 'pass' | 'fail' | 'partial' | 'streaming';
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  server_id: string;
  server_name: string;
  model_name: string;
  template_id: string;
  template_label: string;
  score: number | null;
  latency_ms: number | null;
  cost: number | null;
  tags: string[];
  result_count: number;
}

export interface ResultsDashboardView {
  scorecards: {
    total_runs: number;
    pass_rate: number | null;
    median_latency_ms: number | null;
    median_cost: number | null;
  };
  pass_rate_series: Array<{ label: string; points: Array<{ x: string; y: number | null }> }>;
  latency_series: Array<{ label: string; points: Array<{ x: string; y: number | null }> }>;
  model_summary: Array<{
    model_name: string;
    run_count: number;
    pass_rate: number | null;
    median_latency_ms: number | null;
    median_cost: number | null;
  }>;
  performance_comparison: ResultsPerformanceComparisonView;
  recent_runs: ResultsHistoryRow[];
}

export type ResultsPerformanceComparisonMetricKey = 'cold_penalty_ms' | 'cold_total_ms' | 'hot_total_ms';

export interface ResultsPerformanceComparisonStats {
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  p95: number;
  max: number;
  mean: number;
}

export interface ResultsPerformanceComparisonMetric {
  metric_key: ResultsPerformanceComparisonMetricKey;
  label: string;
  unit: string;
  samples: number[];
  stats: ResultsPerformanceComparisonStats;
}

export interface ResultsPerformanceComparisonGroup {
  group_id: string;
  server_id: string;
  server_name: string;
  model_name: string;
  template_id: string;
  template_label: string;
  metrics: Partial<Record<ResultsPerformanceComparisonMetricKey, ResultsPerformanceComparisonMetric>>;
}

export interface ResultsPerformanceComparisonView {
  default_metric: ResultsPerformanceComparisonMetricKey;
  metrics: Array<{ metric_key: ResultsPerformanceComparisonMetricKey; label: string; unit: string }>;
  groups: ResultsPerformanceComparisonGroup[];
}

export interface ResultsRunDetail {
  run: ResultsHistoryRow;
  raw_run: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
}

export interface ResultsViewResponse {
  filters_applied: ResultsFilterState;
  filter_options: {
    servers: Array<{ id: string; label: string; count: number }>;
    models: Array<{ id: string; label: string; count: number; server_ids: string[] }>;
    templates: Array<{ id: string; label: string; kind: string; count: number; server_ids: string[]; model_names: string[] }>;
    statuses: Array<{ id: string; label: string; count: number }>;
    tags: Array<{ id: string; label: string; count: number }>;
    date_bounds: { min: string | null; max: string | null };
  };
  dashboard: ResultsDashboardView;
  history: {
    rows: ResultsHistoryRow[];
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

type RunAccumulator = {
  run_id: string;
  inference_server_id: string;
  run_status: string;
  run_started_at: string;
  run_ended_at: string | null;
  environment_snapshot: EnvironmentSnapshot | null;
  server_display_name: string | null;
  server_runtime: RuntimeSnapshot | null;
  raw_run: Record<string, unknown>;
  benchmark_document: BenchmarkDocument;
  instantiation_document: Record<string, unknown>;
  results: Array<{
    id: string;
    test_id: string;
    template_id: string;
    template_label: string;
    kind: string;
    verdict: string | null;
    failure_reason: string | null;
    metrics: Record<string, unknown> | null;
    artefacts: Record<string, unknown> | null;
    raw_events: unknown;
    started_at: string | null;
    ended_at: string | null;
    document: ResultDocument | null;
  }>;
};

export type DeleteResultsRunResult =
  | { ok: true }
  | { ok: false; code: 'RUN_NOT_FOUND'; error: string };

function defaultRange(now = new Date()): { date_from: string; date_to: string } {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - DEFAULT_WINDOW_DAYS);
  return { date_from: from.toISOString(), date_to: to.toISOString() };
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)));
  }
  if (typeof value === 'string' && value.trim()) {
    return Array.from(new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean)));
  }
  return [];
}

function normalizeNumber(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeInput(payload: Record<string, unknown> | undefined): { ok: true; value: ResultsFilterState } | { ok: false; error: string; code: string } {
  const body = payload ?? {};
  const range = defaultRange();
  const date_from = typeof body.date_from === 'string' && body.date_from.trim() ? body.date_from : range.date_from;
  const date_to = typeof body.date_to === 'string' && body.date_to.trim() ? body.date_to : range.date_to;
  const fromMs = Date.parse(date_from);
  const toMs = Date.parse(date_to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    return { ok: false, code: 'INVALID_DATE_RANGE', error: 'date_from and date_to must be valid ISO dates in ascending order' };
  }

  const score_min = normalizeNumber(body.score_min, null);
  const score_max = normalizeNumber(body.score_max, null);
  if ((score_min !== null && (score_min < 0 || score_min > 100)) || (score_max !== null && (score_max < 0 || score_max > 100))) {
    return { ok: false, code: 'INVALID_SCORE_RANGE', error: 'score_min and score_max must be between 0 and 100' };
  }

  const sortBy = body.sort_by;
  const sort_by: SortBy =
    sortBy === 'status' || sortBy === 'model' || sortBy === 'server' || sortBy === 'template' || sortBy === 'score' || sortBy === 'latency' || sortBy === 'cost'
      ? sortBy
      : 'started_at';
  const sort_dir: SortDir = body.sort_dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Math.trunc(normalizeNumber(body.page, 1) ?? 1));
  const page_size = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(normalizeNumber(body.page_size, DEFAULT_HISTORY_LIMIT) ?? DEFAULT_HISTORY_LIMIT)));

  return {
    ok: true,
    value: {
      date_from,
      date_to,
      server_ids: normalizeStringArray(body.server_ids),
      model_names: normalizeStringArray(body.model_names),
      template_ids: normalizeStringArray(body.template_ids),
      statuses: normalizeStringArray(body.statuses),
      tags: normalizeStringArray(body.tags),
      score_min,
      score_max,
      sort_by,
      sort_dir,
      page,
      page_size
    }
  };
}

function safeJson<T>(value: string | null): T | null {
  try {
    return parseJson<T>(value);
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function selectedModel(snapshot: EnvironmentSnapshot | null, document: ResultDocument | null): string {
  return snapshot?.effective_config?.model?.trim() || snapshot?.model?.trim() || document?.selected_model?.id?.trim() || 'unknown';
}

function templateLabel(name: string | null, testId: string): string {
  if (!name?.trim()) {
    return testId;
  }
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name.trim();
}

function benchmarkTemplateLabel(instantiation: Record<string, unknown>, templateId: string): string {
  const template = objectValue(instantiation.template);
  return stringValue(template?.name) ?? stringValue(template?.label) ?? stringValue(template?.template_id) ?? templateId;
}

function metricNumber(metrics: Record<string, unknown> | null, keys: string[]): number | null {
  if (!metrics) {
    return null;
  }
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function latency(metrics: Record<string, unknown> | null): number | null {
  const preferred = metricNumber(metrics, ['latency_ms', 'total_ms', 'duration_ms', 'ttfb_ms']);
  if (preferred !== null) {
    return preferred;
  }
  if (!metrics) {
    return null;
  }
  const entry = Object.entries(metrics).find(([key, value]) => /latency|duration|total_ms|ttfb/i.test(key) && typeof value === 'number' && Number.isFinite(value));
  return entry ? (entry[1] as number) : null;
}

function cost(metrics: Record<string, unknown> | null, artefacts: Record<string, unknown> | null): number | null {
  return metricNumber(metrics, ['estimated_cost', 'cost', 'cost_usd']) ?? metricNumber(artefacts, ['estimated_cost', 'cost', 'cost_usd']);
}

function verdictScore(verdict: string | null): number | null {
  if (verdict === 'pass') {
    return 100;
  }
  if (verdict === 'fail' || verdict === 'error') {
    return 0;
  }
  if (verdict === 'skip' || verdict === 'skipped') {
    return 50;
  }
  return null;
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const COMPARISON_METRICS: ResultsPerformanceComparisonView['metrics'] = [
  { metric_key: 'cold_penalty_ms', label: 'Cold penalty', unit: 'ms' },
  { metric_key: 'cold_total_ms', label: 'Cold total', unit: 'ms' },
  { metric_key: 'hot_total_ms', label: 'Hot total', unit: 'ms' }
];

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = rank - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function comparisonStats(samples: number[]): ResultsPerformanceComparisonStats {
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    q1: percentile(sorted, 25),
    median: percentile(sorted, 50),
    q3: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length
  };
}

function sanitizeSamples(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'number' ? entry : typeof entry === 'string' && entry.trim() ? Number(entry) : Number.NaN))
    .filter((entry) => Number.isFinite(entry));
}

function sampleEnvelope(artefacts: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!artefacts) {
    return null;
  }
  const pythonResult = artefacts.python_result;
  if (pythonResult && typeof pythonResult === 'object' && !Array.isArray(pythonResult)) {
    return pythonResult as Record<string, unknown>;
  }
  return artefacts;
}

function metricSamples(artefacts: Record<string, unknown> | null, metricKey: ResultsPerformanceComparisonMetricKey): number[] {
  const envelope = sampleEnvelope(artefacts);
  const samples = envelope?.samples;
  if (!samples || typeof samples !== 'object' || Array.isArray(samples)) {
    return [];
  }
  return sanitizeSamples((samples as Record<string, unknown>)[metricKey]);
}

function durationMs(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function resultTags(result: RunAccumulator['results'][number]): string[] {
  return Array.from(new Set((result.document?.test?.tags ?? []).filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)));
}

function rowStatus(run: RunAccumulator): ResultsHistoryRow['status'] {
  if (run.run_status === 'created' || run.run_status === 'running') {
    return 'streaming';
  }
  if (run.run_status === 'completed_with_errors') {
    return 'partial';
  }
  if (run.run_status === 'cancelled' || run.run_status === 'failed' || run.run_status === 'timeout') {
    return 'fail';
  }
  const stageResults = run.benchmark_document.stage_results ?? [];
  const failedItems = stageResults.flatMap((stage) => stage.results ?? []).filter((result) => result.status === 'failed').length;
  if (failedItems > 0 || (run.benchmark_document.errors?.length ?? 0) > 0) {
    return 'partial';
  }
  if (run.run_status === 'completed') {
    return 'pass';
  }
  const verdicts = run.results.map((result) => result.verdict).filter(Boolean);
  const passes = verdicts.filter((verdict) => verdict === 'pass').length;
  if (passes === verdicts.length) {
    return 'pass';
  }
  if (passes > 0) {
    return 'partial';
  }
  return 'fail';
}

function rowScore(status: ResultsHistoryRow['status']): number | null {
  if (status === 'pass') {
    return 100;
  }
  if (status === 'partial') {
    return 50;
  }
  if (status === 'fail') {
    return 0;
  }
  return null;
}

function metricAggregateNumber(aggregated: Record<string, Record<string, unknown>> | undefined, metricName: string): number | null {
  const aggregate = aggregated?.[metricName];
  if (!aggregate) {
    return null;
  }
  return numberValue(aggregate.median)
    ?? numberValue(aggregate.p50)
    ?? numberValue(aggregate.mean)
    ?? numberValue(aggregate.average)
    ?? numberValue(aggregate.min)
    ?? numberValue(aggregate.max);
}

function benchmarkLatency(document: BenchmarkDocument): number | null {
  const directSamples = (document.metric_results ?? [])
    .map((entry) => numberValue(entry.elapsed_ms) ?? numberValue(entry.latency_ms) ?? numberValue(entry.total_ms) ?? numberValue(entry.duration_ms))
    .filter((entry): entry is number => entry !== null);
  return median(directSamples) ?? metricAggregateNumber(document.aggregated_metrics, 'elapsed_ms');
}

function benchmarkCost(document: BenchmarkDocument): number | null {
  const directCosts = (document.metric_results ?? [])
    .map((entry) => numberValue(entry.estimated_cost) ?? numberValue(entry.cost) ?? numberValue(entry.cost_usd))
    .filter((entry): entry is number => entry !== null);
  return directCosts.reduce<number>((sum, value) => sum + value, 0) || null;
}

function benchmarkSamples(document: BenchmarkDocument): Record<ResultsPerformanceComparisonMetricKey, number[]> {
  return {
    cold_penalty_ms: (document.metric_results ?? []).map((entry) => numberValue(entry.cold_penalty_ms)).filter((entry): entry is number => entry !== null),
    cold_total_ms: (document.metric_results ?? []).map((entry) => numberValue(entry.cold_total_ms)).filter((entry): entry is number => entry !== null),
    hot_total_ms: (document.metric_results ?? []).map((entry) => numberValue(entry.hot_total_ms)).filter((entry): entry is number => entry !== null)
  };
}

function benchmarkResultCount(document: BenchmarkDocument): number {
  const count = (document.stage_results ?? []).reduce((sum, stage) => {
    if (typeof stage.run_count === 'number' && Number.isFinite(stage.run_count)) {
      return sum + stage.run_count;
    }
    return sum + (stage.results?.length ?? 0);
  }, 0);
  return count > 0 ? count : 1;
}

function benchmarkTags(instantiation: Record<string, unknown>, document: BenchmarkDocument): string[] {
  const snapshot = objectValue(document.instantiation_snapshot);
  const template = objectValue(instantiation.template) ?? objectValue(snapshot?.template);
  const test = objectValue(instantiation.test) ?? objectValue(snapshot?.test);
  const tags = [
    ...stringArray(template?.tags),
    ...stringArray(test?.tags),
    ...stringArray(instantiation.tags),
    ...stringArray(snapshot?.tags)
  ];
  return Array.from(new Set(tags));
}

function benchmarkDocumentForResult(instantiation: Record<string, unknown>, document: BenchmarkDocument, modelId: string): ResultDocument {
  const snapshot = objectValue(document.instantiation_snapshot);
  const template = objectValue(instantiation.template) ?? objectValue(snapshot?.template);
  const test = objectValue(instantiation.test) ?? objectValue(snapshot?.test);
  const tags = benchmarkTags(instantiation, document);
  return {
    test: {
      tags,
      type: stringValue(template?.kind) ?? stringValue(test?.type) ?? 'benchmark'
    },
    selected_model: { id: modelId },
    summary: {
      status: document.status,
      errors: document.errors ?? [],
      warnings: document.warnings ?? []
    }
  };
}

function toHistoryRow(run: RunAccumulator): ResultsHistoryRow {
  const firstResult = run.results[0];
  const allLatencies = run.results.map((result) => latency(result.metrics));
  const allCosts = run.results.map((result) => cost(result.metrics, result.artefacts));
  const status = rowStatus(run);
  const scores = [rowScore(status), ...run.results.map((result) => verdictScore(result.verdict))];
  const tags = Array.from(new Set(run.results.flatMap(resultTags)));
  const document = firstResult?.document ?? null;
  const model = selectedModel(run.environment_snapshot, document);
  return {
    run_id: run.run_id,
    status,
    started_at: run.run_started_at,
    ended_at: run.run_ended_at,
    duration_ms: durationMs(run.run_started_at, run.run_ended_at),
    server_id: run.inference_server_id,
    server_name: run.server_display_name ?? run.inference_server_id,
    model_name: model,
    template_id: firstResult?.template_id ?? run.results[0]?.test_id ?? run.run_id,
    template_label: firstResult?.template_label ?? run.results[0]?.test_id ?? 'unknown',
    score: median(scores),
    latency_ms: median(allLatencies),
    cost: allCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0) || null,
    tags,
    result_count: run.results.length
  };
}

function fetchRows(filters: ResultsFilterState): BenchmarkResultRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      b.id,
      b.run_id,
      b.status,
      b.created_at,
      b.document,
      b.instantiation_id,
      i.template_id,
      i.server_id,
      i.model_id,
      i.document AS instantiation_document,
      s.display_name AS server_display_name,
      s.runtime AS server_runtime
    FROM benchmark_test_run_results b
    JOIN benchmark_test_instantiations i ON i.id = b.instantiation_id
    LEFT JOIN inference_servers s ON s.server_id = i.server_id
    WHERE b.created_at >= ? AND b.created_at <= ?
    ORDER BY b.created_at DESC
    LIMIT ${MAX_SOURCE_ROWS}
  `).all(filters.date_from, filters.date_to) as BenchmarkResultRow[];
}

function fetchRowsForRun(runId: string): BenchmarkResultRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      b.id,
      b.run_id,
      b.status,
      b.created_at,
      b.document,
      b.instantiation_id,
      i.template_id,
      i.server_id,
      i.model_id,
      i.document AS instantiation_document,
      s.display_name AS server_display_name,
      s.runtime AS server_runtime
    FROM benchmark_test_run_results b
    JOIN benchmark_test_instantiations i ON i.id = b.instantiation_id
    LEFT JOIN inference_servers s ON s.server_id = i.server_id
    WHERE b.run_id = ? OR b.id = ?
    ORDER BY b.created_at DESC
    LIMIT 1
  `).all(runId, runId) as BenchmarkResultRow[];
}

function materializeRuns(rows: BenchmarkResultRow[]): RunAccumulator[] {
  const runs: RunAccumulator[] = [];
  for (const row of rows) {
    const benchmarkDocument = safeJson<BenchmarkDocument>(row.document) ?? {};
    const instantiationDocument = safeJson<Record<string, unknown>>(row.instantiation_document) ?? {};
    const startedAt = stringValue(benchmarkDocument.started_at) ?? row.created_at;
    const endedAt = stringValue(benchmarkDocument.completed_at) ?? null;
    const templateId = stringValue(row.template_id) ?? stringValue(instantiationDocument.template_id) ?? row.instantiation_id;
    const modelId = stringValue(row.model_id) ?? stringValue(instantiationDocument.model_id) ?? 'unknown';
    const status = stringValue(benchmarkDocument.status) ?? row.status;
    const latencyMs = benchmarkLatency(benchmarkDocument);
    const costUsd = benchmarkCost(benchmarkDocument);
    const samples = benchmarkSamples(benchmarkDocument);
    const resultDocument = benchmarkDocumentForResult(instantiationDocument, benchmarkDocument, modelId);
    const resultCount = benchmarkResultCount(benchmarkDocument);
    const result = {
      id: row.id,
      test_id: templateId,
      template_id: templateId,
      template_label: benchmarkTemplateLabel(instantiationDocument, templateId),
      kind: 'benchmark',
      verdict: status === 'completed' ? 'pass' : status === 'completed_with_errors' ? 'skip' : 'fail',
      failure_reason: (benchmarkDocument.errors ?? []).map((error) => stringValue(error.message) ?? stringValue(error.code)).filter(Boolean).join('; ') || null,
      metrics: {
        latency_ms: latencyMs,
        elapsed_ms: latencyMs,
        estimated_cost: costUsd,
        result_count: resultCount
      },
      artefacts: {
        samples,
        raw_responses: benchmarkDocument.raw_responses ?? [],
        normalized_responses: benchmarkDocument.normalized_responses ?? [],
        aggregated_metrics: benchmarkDocument.aggregated_metrics ?? {}
      },
      raw_events: benchmarkDocument.raw_responses ?? [],
      started_at: startedAt,
      ended_at: endedAt,
      document: resultDocument
    };
    runs.push({
      run_id: row.run_id,
      inference_server_id: row.server_id,
      run_status: status,
      run_started_at: startedAt,
      run_ended_at: endedAt,
      environment_snapshot: { effective_config: { model: modelId }, model: modelId },
      server_display_name: row.server_display_name,
      server_runtime: safeJson<RuntimeSnapshot>(row.server_runtime),
      raw_run: {
        id: row.id,
        run_id: row.run_id,
        instantiation_id: row.instantiation_id,
        status: row.status,
        created_at: row.created_at,
        document: benchmarkDocument
      },
      benchmark_document: benchmarkDocument,
      instantiation_document: instantiationDocument,
      results: Array.from({ length: resultCount }, (_, index) => ({
        ...result,
        id: index === 0 ? result.id : `${result.id}:${index + 1}`
      }))
    });
  }
  return runs;
}

function matchesFilters(row: ResultsHistoryRow, filters: ResultsFilterState): boolean {
  if (filters.server_ids.length > 0 && !filters.server_ids.includes(row.server_id)) {
    return false;
  }
  if (filters.model_names.length > 0 && !filters.model_names.includes(row.model_name)) {
    return false;
  }
  if (filters.template_ids.length > 0 && !filters.template_ids.includes(row.template_id)) {
    return false;
  }
  if (filters.statuses.length > 0 && !filters.statuses.includes(row.status)) {
    return false;
  }
  if (filters.score_min !== null && (row.score === null || row.score < filters.score_min)) {
    return false;
  }
  if (filters.score_max !== null && (row.score === null || row.score > filters.score_max)) {
    return false;
  }
  if (filters.tags.length > 0) {
    const lowerTags = row.tags.map((tag) => tag.toLowerCase());
    const matches = filters.tags.some((tag) => lowerTags.some((candidate) => candidate.includes(tag.toLowerCase())));
    if (!matches) {
      return false;
    }
  }
  return true;
}

function sortRows(rows: ResultsHistoryRow[], filters: ResultsFilterState): ResultsHistoryRow[] {
  const multiplier = filters.sort_dir === 'asc' ? 1 : -1;
  const value = (row: ResultsHistoryRow): string | number => {
    switch (filters.sort_by) {
      case 'status':
        return row.status;
      case 'model':
        return row.model_name;
      case 'server':
        return row.server_name;
      case 'template':
        return row.template_label;
      case 'score':
        return row.score ?? -1;
      case 'latency':
        return row.latency_ms ?? Number.MAX_SAFE_INTEGER;
      case 'cost':
        return row.cost ?? Number.MAX_SAFE_INTEGER;
      case 'started_at':
      default:
        return Date.parse(row.started_at) || 0;
    }
  };
  return rows.slice().sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * multiplier;
    }
    return String(left).localeCompare(String(right)) * multiplier;
  });
}

function countOptions(rows: ResultsHistoryRow[]) {
  const count = <T extends string>(values: T[]) => {
    const map = new Map<T, number>();
    for (const value of values) {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    return map;
  };
  const servers = new Map<string, { label: string; count: number }>();
  const models = new Map<string, { label: string; count: number; serverIds: Set<string> }>();
  const templates = new Map<string, { label: string; kind: string; count: number; serverIds: Set<string>; modelNames: Set<string> }>();
  for (const row of rows) {
    const server = servers.get(row.server_id) ?? { label: row.server_name, count: 0 };
    server.count += 1;
    servers.set(row.server_id, server);

    const model = models.get(row.model_name) ?? { label: row.model_name, count: 0, serverIds: new Set<string>() };
    model.count += 1;
    model.serverIds.add(row.server_id);
    models.set(row.model_name, model);

    const template = templates.get(row.template_id) ?? {
      label: row.template_label,
      kind: 'JSON',
      count: 0,
      serverIds: new Set<string>(),
      modelNames: new Set<string>()
    };
    template.count += 1;
    template.serverIds.add(row.server_id);
    template.modelNames.add(row.model_name);
    templates.set(row.template_id, template);
  }
  return {
    servers: Array.from(servers.entries()).map(([id, entry]) => ({ id, label: entry.label, count: entry.count })),
    models: Array.from(models.entries()).map(([id, entry]) => ({
      id,
      label: entry.label,
      count: entry.count,
      server_ids: Array.from(entry.serverIds).sort()
    })),
    templates: Array.from(templates.entries()).map(([id, entry]) => ({
      id,
      label: entry.label,
      kind: entry.kind,
      count: entry.count,
      server_ids: Array.from(entry.serverIds).sort(),
      model_names: Array.from(entry.modelNames).sort()
    })),
    statuses: Array.from(count(rows.map((row) => row.status)).entries()).map(([id, total]) => ({ id, label: id, count: total })),
    tags: Array.from(count(rows.flatMap((row) => row.tags)).entries()).map(([id, total]) => ({ id, label: id, count: total }))
  };
}

function dayBucket(iso: string): string {
  return iso.slice(0, 10);
}

function modelSummary(rows: ResultsHistoryRow[]): ResultsDashboardView['model_summary'] {
  const byModel = new Map<string, ResultsHistoryRow[]>();
  for (const row of rows) {
    const modelRows = byModel.get(row.model_name) ?? [];
    modelRows.push(row);
    byModel.set(row.model_name, modelRows);
  }
  return Array.from(byModel.entries())
    .map(([modelName, modelRows]) => {
      const passCount = modelRows.filter((row) => row.status === 'pass').length;
      return {
        model_name: modelName,
        run_count: modelRows.length,
        pass_rate: modelRows.length > 0 ? (passCount / modelRows.length) * 100 : null,
        median_latency_ms: median(modelRows.map((row) => row.latency_ms)),
        median_cost: median(modelRows.map((row) => row.cost))
      };
    })
    .sort((a, b) => (b.pass_rate ?? -1) - (a.pass_rate ?? -1) || (a.median_latency_ms ?? Number.MAX_SAFE_INTEGER) - (b.median_latency_ms ?? Number.MAX_SAFE_INTEGER));
}

function dashboard(rows: ResultsHistoryRow[]): ResultsDashboardView {
  const total = rows.length;
  const passRate = total > 0 ? (rows.filter((row) => row.status === 'pass').length / total) * 100 : null;
  const byModelDay = new Map<string, { pass: number; total: number; latency: Array<{ x: string; y: number | null }> }>();
  for (const row of rows) {
    const key = `${row.model_name}|${dayBucket(row.started_at)}`;
    const bucket = byModelDay.get(key) ?? { pass: 0, total: 0, latency: [] };
    bucket.total += 1;
    if (row.status === 'pass') {
      bucket.pass += 1;
    }
    bucket.latency.push({ x: row.started_at, y: row.latency_ms });
    byModelDay.set(key, bucket);
  }
  const passSeries = new Map<string, Array<{ x: string; y: number | null }>>();
  const latencySeries = new Map<string, Array<{ x: string; y: number | null }>>();
  for (const [key, bucket] of byModelDay.entries()) {
    const [model, day] = key.split('|');
    const passPoints = passSeries.get(model) ?? [];
    passPoints.push({ x: day, y: bucket.total > 0 ? (bucket.pass / bucket.total) * 100 : null });
    passSeries.set(model, passPoints);
  }
  for (const row of rows) {
    const points = latencySeries.get(row.model_name) ?? [];
    points.push({ x: row.started_at, y: row.latency_ms });
    latencySeries.set(row.model_name, points);
  }
  return {
    scorecards: {
      total_runs: total,
      pass_rate: passRate,
      median_latency_ms: median(rows.map((row) => row.latency_ms)),
      median_cost: median(rows.map((row) => row.cost))
    },
    pass_rate_series: Array.from(passSeries.entries()).map(([label, points]) => ({ label, points: points.sort((a, b) => a.x.localeCompare(b.x)) })),
    latency_series: Array.from(latencySeries.entries()).map(([label, points]) => ({ label, points: points.sort((a, b) => a.x.localeCompare(b.x)) })),
    model_summary: modelSummary(rows),
    performance_comparison: emptyPerformanceComparison(),
    recent_runs: rows.slice().sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 8)
  };
}

function emptyPerformanceComparison(): ResultsPerformanceComparisonView {
  return {
    default_metric: 'cold_penalty_ms',
    metrics: COMPARISON_METRICS,
    groups: []
  };
}

function dashboardWithComparison(rows: ResultsHistoryRow[], runs: RunAccumulator[]): ResultsDashboardView {
  return {
    ...dashboard(rows),
    performance_comparison: performanceComparison(runs)
  };
}

function performanceComparison(runs: RunAccumulator[]): ResultsPerformanceComparisonView {
  const groups = new Map<
    string,
    {
      server_id: string;
      server_name: string;
      model_name: string;
      template_id: string;
      template_label: string;
      samples: Record<ResultsPerformanceComparisonMetricKey, number[]>;
    }
  >();

  for (const run of runs) {
    const serverId = run.inference_server_id;
    const serverName = run.server_display_name ?? serverId;
    for (const result of run.results) {
      const resultSamples = COMPARISON_METRICS.map((metric) => ({
        metric,
        samples: metricSamples(result.artefacts, metric.metric_key)
      }));
      if (!resultSamples.some((entry) => entry.samples.length > 0)) {
        continue;
      }

      const modelName = selectedModel(run.environment_snapshot, result.document);
      const groupId = [serverId, modelName, result.template_id].join('|');
      const group = groups.get(groupId) ?? {
        server_id: serverId,
        server_name: serverName,
        model_name: modelName,
        template_id: result.template_id,
        template_label: result.template_label,
        samples: {
          cold_penalty_ms: [],
          cold_total_ms: [],
          hot_total_ms: []
        }
      };
      for (const entry of resultSamples) {
        group.samples[entry.metric.metric_key].push(...entry.samples);
      }
      groups.set(groupId, group);
    }
  }

  return {
    default_metric: 'cold_penalty_ms',
    metrics: COMPARISON_METRICS,
    groups: Array.from(groups.entries())
      .map(([groupId, group]) => ({
        group_id: groupId,
        server_id: group.server_id,
        server_name: group.server_name,
        model_name: group.model_name,
        template_id: group.template_id,
        template_label: group.template_label,
        metrics: Object.fromEntries(
          COMPARISON_METRICS.flatMap((metric) => {
            const samples = group.samples[metric.metric_key];
            if (samples.length === 0) {
              return [];
            }
            return [
              [
                metric.metric_key,
                {
                  ...metric,
                  samples,
                  stats: comparisonStats(samples)
                }
              ]
            ];
          })
        ) as Partial<Record<ResultsPerformanceComparisonMetricKey, ResultsPerformanceComparisonMetric>>
      }))
      .filter((group) => Object.keys(group.metrics).length > 0)
      .sort((a, b) => {
        const aMedian = a.metrics.cold_penalty_ms?.stats.median ?? Number.POSITIVE_INFINITY;
        const bMedian = b.metrics.cold_penalty_ms?.stats.median ?? Number.POSITIVE_INFINITY;
        return aMedian - bMedian || a.server_name.localeCompare(b.server_name) || a.model_name.localeCompare(b.model_name);
      })
  };
}

export function queryResultsView(payload: Record<string, unknown> | undefined): { ok: true; value: ResultsViewResponse } | { ok: false; code: string; error: string } {
  const normalized = normalizeInput(payload);
  if (!normalized.ok) {
    return normalized;
  }
  const runs = materializeRuns(fetchRows(normalized.value));
  const allRows = runs.map(toHistoryRow);
  const options = countOptions(allRows);
  const filteredRows = allRows.filter((row) => matchesFilters(row, normalized.value));
  const filteredRunIds = new Set(filteredRows.map((row) => row.run_id));
  const filteredRuns = runs.filter((run) => filteredRunIds.has(run.run_id));
  const sortedRows = sortRows(filteredRows, normalized.value);
  const start = (normalized.value.page - 1) * normalized.value.page_size;
  const pageRows = sortedRows.slice(start, start + normalized.value.page_size);
  const dates = allRows.map((row) => row.started_at).sort();

  return {
    ok: true,
    value: {
      filters_applied: normalized.value,
      filter_options: {
        ...options,
        date_bounds: { min: dates[0] ?? null, max: dates[dates.length - 1] ?? null }
      },
      dashboard: dashboardWithComparison(filteredRows, filteredRuns),
      history: {
        rows: pageRows,
        page: normalized.value.page,
        page_size: normalized.value.page_size,
        total: filteredRows.length,
        total_pages: Math.max(1, Math.ceil(filteredRows.length / normalized.value.page_size))
      }
    }
  };
}

export function getResultsRunDetail(runId: string): ResultsRunDetail | null {
  const rows = materializeRuns(fetchRowsForRun(runId));
  const run = rows[0];
  if (!run) {
    return null;
  }
  return {
    run: toHistoryRow(run),
    raw_run: {
      ...run.raw_run,
      instantiation: run.instantiation_document,
      raw_responses: run.benchmark_document.raw_responses ?? [],
      normalized_responses: run.benchmark_document.normalized_responses ?? [],
      metric_results: run.benchmark_document.metric_results ?? [],
      aggregated_metrics: run.benchmark_document.aggregated_metrics ?? {}
    },
    results: run.results.map((result) => ({
      id: result.id,
      test_id: result.test_id,
      template_id: result.template_id,
      template_label: result.template_label,
      kind: result.kind,
      verdict: result.verdict,
      failure_reason: result.failure_reason,
      metrics: result.metrics,
      artefacts: result.artefacts,
      raw_events: result.raw_events,
      started_at: result.started_at,
      ended_at: result.ended_at
    })),
    documents: [
      run.benchmark_document as Record<string, unknown>,
      run.instantiation_document
    ]
  };
}

export function deleteResultsRun(runId: string): DeleteResultsRunResult {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM benchmark_test_run_results WHERE run_id = ? OR id = ?')
    .get(runId, runId) as { id: string } | undefined;
  if (!row) {
    return { ok: false, code: 'RUN_NOT_FOUND', error: 'Run not found' };
  }
  db.prepare('DELETE FROM benchmark_test_run_results WHERE id = ?').run(row.id);
  return { ok: true };
}
