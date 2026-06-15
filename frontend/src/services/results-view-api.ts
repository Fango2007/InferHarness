import { apiDelete, apiGet, apiPost } from './api.js';

export type ResultsTab = 'dashboard' | 'leaderboard' | 'history';
export type ResultsStatus = 'pass' | 'fail' | 'partial' | 'streaming';
export type ResultsSortBy = 'started_at' | 'status' | 'model' | 'server' | 'template' | 'score' | 'latency' | 'cost';
export type ResultsSortDir = 'asc' | 'desc';

export interface ResultsFilterState {
  date_from?: string;
  date_to?: string;
  server_ids: string[];
  model_names: string[];
  template_ids: string[];
  statuses: ResultsStatus[];
  tags: string[];
  score_min: number | null;
  score_max: number | null;
  sort_by: ResultsSortBy;
  sort_dir: ResultsSortDir;
  page: number;
  page_size: number;
}

export interface ResultsHistoryRow {
  run_id: string;
  status: ResultsStatus;
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

export interface ResultsFilterOptions {
  servers: Array<{ id: string; label: string; count: number }>;
  models: Array<{ id: string; label: string; count: number; server_ids?: string[] }>;
  templates: Array<{ id: string; label: string; kind: string; count: number; server_ids?: string[]; model_names?: string[] }>;
  statuses: Array<{ id: ResultsStatus; label: string; count: number }>;
  tags: Array<{ id: string; label: string; count: number }>;
  date_bounds: { min: string | null; max: string | null };
}

export interface ResultsViewResponse {
  filters_applied: ResultsFilterState;
  filter_options: ResultsFilterOptions;
  dashboard: ResultsDashboardView;
  history: {
    rows: ResultsHistoryRow[];
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export interface ResultsRunDetail {
  run: ResultsHistoryRow;
  raw_run: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
}

export interface ResultsEvaluationDetail {
  evaluation: {
    id: string;
    prompt_id: string;
    model_name: string;
    server_id: string;
    inference_config: Record<string, unknown>;
    answer_text: string;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    latency_ms: number | null;
    word_count: number | null;
    estimated_cost: number | null;
    accuracy_score: number;
    relevance_score: number;
    coherence_score: number;
    completeness_score: number;
    helpfulness_score: number;
    note: string | null;
    created_at: string;
  };
  prompt: { id: string; text: string; tags: string[]; created_at: string } | null;
  server: { server_id: string; display_name: string } | null;
  composite_score: number;
}

export function queryResultsView(filters: Partial<ResultsFilterState>): Promise<ResultsViewResponse> {
  return apiPost<ResultsViewResponse>('/results-view/query', filters);
}

export function getResultsRunDetail(runId: string): Promise<ResultsRunDetail> {
  return apiGet<ResultsRunDetail>(`/results-view/runs/${encodeURIComponent(runId)}`);
}

export function getResultsEvaluationDetail(evaluationId: string): Promise<ResultsEvaluationDetail> {
  return apiGet<ResultsEvaluationDetail>(`/evaluations/${encodeURIComponent(evaluationId)}`);
}

export async function deleteRun(runId: string): Promise<void> {
  await apiDelete(`/runs/${encodeURIComponent(runId)}`);
}
