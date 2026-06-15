import type {
  ResultsDashboardView,
  ResultsFilterState,
  ResultsHistoryRow,
  ResultsPerformanceComparisonView
} from './results-view-api.js';

export type ResultsChartMode = 'auto' | 'cold-start' | 'latency-trend' | 'pass-rate-trend' | 'latency-histogram' | 'model-summary';
export type ResolvedResultsChartMode = Exclude<ResultsChartMode, 'auto'>;

export interface HistogramBucket {
  label: string;
  min: number;
  max: number;
  series: Array<{ label: string; count: number }>;
}

function finitePointCount(series: Array<{ points: Array<{ y: number | null }> }>): number {
  return series.reduce(
    (total, entry) => total + entry.points.filter((point) => typeof point.y === 'number' && Number.isFinite(point.y)).length,
    0
  );
}

export function hasPerformanceComparison(comparison: ResultsPerformanceComparisonView | null | undefined): boolean {
  return Boolean(comparison?.groups.some((group) => Object.keys(group.metrics).length > 0));
}

export function resolveResultsChartMode(
  mode: ResultsChartMode,
  dashboard: ResultsDashboardView,
  filters: ResultsFilterState,
  focusedRun: ResultsHistoryRow | null = null
): ResolvedResultsChartMode | null {
  if (mode !== 'auto') {
    return mode;
  }

  const latencyPoints = finitePointCount(dashboard.latency_series);
  const passRatePoints = finitePointCount(dashboard.pass_rate_series);

  if (focusedRun && latencyPoints > 0) {
    return 'latency-trend';
  }
  if (hasPerformanceComparison(dashboard.performance_comparison)) {
    return 'cold-start';
  }
  if (latencyPoints >= 6) {
    return 'latency-histogram';
  }
  if (latencyPoints > 0) {
    return 'latency-trend';
  }
  if (passRatePoints > 0) {
    return 'pass-rate-trend';
  }
  return dashboard.scorecards.total_runs > 0 ? 'model-summary' : null;
}

export function buildLatencyHistogram(series: ResultsDashboardView['latency_series'], bucketCount = 8): HistogramBucket[] {
  const values = series.flatMap((entry) =>
    entry.points
      .map((point) => point.y)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  );
  if (values.length === 0) {
    return [];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = max === min ? 1 : (max - min) / Math.max(1, bucketCount);
  const buckets = Array.from({ length: Math.max(1, bucketCount) }, (_, index) => {
    const bucketMin = min + width * index;
    const bucketMax = index === bucketCount - 1 ? max : min + width * (index + 1);
    return {
      label: max === min ? `${Math.round(min)} ms` : `${Math.round(bucketMin)}-${Math.round(bucketMax)} ms`,
      min: bucketMin,
      max: bucketMax,
      series: [] as Array<{ label: string; count: number }>
    };
  });

  for (const entry of series) {
    const counts = new Array(buckets.length).fill(0) as number[];
    for (const point of entry.points) {
      if (typeof point.y !== 'number' || !Number.isFinite(point.y)) {
        continue;
      }
      const index = max === min ? 0 : Math.min(buckets.length - 1, Math.floor((point.y - min) / width));
      counts[index] += 1;
    }
    counts.forEach((count, index) => {
      buckets[index].series.push({ label: entry.label, count });
    });
  }

  return buckets;
}
