import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import _ReactECharts from 'echarts-for-react';
import type { EChartsReactProps } from 'echarts-for-react';
import type { EChartsOption } from 'echarts/types/dist/shared';

import {
  buildLatencyHistogram,
  resolveResultsChartMode,
  type ResolvedResultsChartMode,
  type ResultsChartMode
} from '../services/results-adaptive-chart.js';
import type { ResultsDashboardView, ResultsFilterState, ResultsHistoryRow } from '../services/results-view-api.js';
import type { ResultsPanel } from '../services/results-panels.js';
import { ResultsGraphPanel } from './results-graph-panel.js';
import { ResultsPerformanceComparisonPanel } from './results-performance-comparison-panel.js';

const ReactECharts = _ReactECharts as unknown as ComponentType<EChartsReactProps>;

interface ResultsAdaptiveChartPanelProps {
  dashboard: ResultsDashboardView;
  filters: ResultsFilterState;
  focusedRun: ResultsHistoryRow | null;
}

const CHART_MODE_OPTIONS: Array<{ mode: ResultsChartMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'cold-start', label: 'Cold-start comparison' },
  { mode: 'latency-trend', label: 'Latency trend' },
  { mode: 'pass-rate-trend', label: 'Pass-rate trend' },
  { mode: 'latency-histogram', label: 'Latency histogram' },
  { mode: 'model-summary', label: 'Model summary' }
];

function seriesPanel(title: string, metric: string, series: ResultsDashboardView['latency_series']): ResultsPanel {
  return {
    panel_id: `results:${metric}`,
    presentation_type: 'performance_graph',
    title,
    runtime_key: 'selected',
    server_version: null,
    model_id: 'selected',
    test_ids: [],
    metric_keys: [metric],
    unit_keys: metric === 'pass_rate' ? ['%'] : ['ms'],
    grouped: true,
    series,
    missing_fields: []
  };
}

function formatNumber(value: number | null, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) {
    return 'N/A';
  }
  return `${Number(value.toFixed(value >= 100 ? 0 : 2)).toLocaleString()}${suffix}`;
}

function modeLabel(mode: ResolvedResultsChartMode | null): string {
  switch (mode) {
    case 'cold-start':
      return 'Cold-start comparison';
    case 'latency-trend':
      return 'Latency trend';
    case 'pass-rate-trend':
      return 'Pass-rate trend';
    case 'latency-histogram':
      return 'Latency histogram';
    case 'model-summary':
      return 'Model summary';
    default:
      return 'Results chart';
  }
}

function LatencyHistogram({ dashboard, focusedRun }: { dashboard: ResultsDashboardView; focusedRun: ResultsHistoryRow | null }) {
  const buckets = useMemo(() => buildLatencyHistogram(dashboard.latency_series), [dashboard.latency_series]);
  const labels = dashboard.latency_series.map((entry) => entry.label);
  const option = useMemo<EChartsOption>(() => ({
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' }
    },
    legend: { type: 'scroll' },
    grid: {
      left: 56,
      right: 20,
      top: 36,
      bottom: 72
    },
    xAxis: {
      type: 'category',
      data: buckets.map((bucket) => bucket.label),
      name: 'Latency bucket',
      nameLocation: 'middle',
      nameGap: 48,
      axisLabel: { rotate: buckets.length > 5 ? 28 : 0, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      name: 'Runs'
    },
    series: labels.map((label) => ({
      name: label,
      type: 'bar',
      stack: 'latency',
      emphasis: { focus: 'series' },
      itemStyle: {
        opacity: focusedRun && focusedRun.model_name !== label ? 0.32 : 1
      },
      data: buckets.map((bucket) => bucket.series.find((entry) => entry.label === label)?.count ?? 0)
    }))
  }), [buckets, focusedRun, labels]);

  if (buckets.length === 0) {
    return <p className="muted">No latency samples available.</p>;
  }

  return <ReactECharts option={option} className="results-chart" notMerge lazyUpdate />;
}

function ModelSummaryTable({ dashboard }: { dashboard: ResultsDashboardView }) {
  const summaryRows = dashboard.model_summary;
  if (summaryRows.length === 0) {
    return <p className="muted">No model summary rows available.</p>;
  }

  return (
    <div className="table-scroll">
      <table className="results-comparison-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Runs</th>
            <th>Pass rate</th>
            <th>Median latency</th>
            <th>Median cost</th>
          </tr>
        </thead>
        <tbody>
          {summaryRows.map((row) => (
            <tr key={row.model_name}>
              <td>{row.model_name}</td>
              <td>{row.run_count}</td>
              <td>{formatNumber(row.pass_rate, '%')}</td>
              <td>{formatNumber(row.median_latency_ms, ' ms')}</td>
              <td>{row.median_cost == null ? 'N/A' : `$${row.median_cost.toFixed(6)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultsAdaptiveChartPanel({ dashboard, filters, focusedRun }: ResultsAdaptiveChartPanelProps) {
  const [selectedMode, setSelectedMode] = useState<ResultsChartMode>('auto');
  const resolvedMode = resolveResultsChartMode(selectedMode, dashboard, filters, focusedRun);
  const focusedLabel = focusedRun?.model_name ?? null;

  return (
    <section className="results-panel results-adaptive-chart" data-panel-type="adaptive-chart">
      <header className="results-panel__header">
        <div>
          <h2>Performance view</h2>
          <p className="muted">{selectedMode === 'auto' ? `Auto selected: ${modeLabel(resolvedMode)}` : modeLabel(resolvedMode)}</p>
        </div>
        <label className="results-comparison-metric">
          <span>View</span>
          <select value={selectedMode} onChange={(event) => setSelectedMode(event.target.value as ResultsChartMode)}>
            {CHART_MODE_OPTIONS.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {resolvedMode === 'cold-start' ? (
        <ResultsPerformanceComparisonPanel comparison={dashboard.performance_comparison} embedded />
      ) : null}
      {resolvedMode === 'latency-trend' ? (
        <ResultsGraphPanel panel={seriesPanel('Latency trend', 'latency_ms', dashboard.latency_series)} focusedLabel={focusedLabel} embedded />
      ) : null}
      {resolvedMode === 'pass-rate-trend' ? (
        <ResultsGraphPanel panel={seriesPanel('Pass-rate trend', 'pass_rate', dashboard.pass_rate_series)} focusedLabel={focusedLabel} embedded />
      ) : null}
      {resolvedMode === 'latency-histogram' ? <LatencyHistogram dashboard={dashboard} focusedRun={focusedRun} /> : null}
      {resolvedMode === 'model-summary' ? <ModelSummaryTable dashboard={dashboard} /> : null}
      {resolvedMode === null ? <p className="muted">No chart data available.</p> : null}
    </section>
  );
}
