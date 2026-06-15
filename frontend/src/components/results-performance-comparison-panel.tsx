import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import _ReactECharts from 'echarts-for-react';
import type { EChartsReactProps } from 'echarts-for-react';
import type { EChartsOption } from 'echarts/types/dist/shared';

import type {
  ResultsPerformanceComparisonMetricKey,
  ResultsPerformanceComparisonView
} from '../services/results-view-api.js';

const ReactECharts = _ReactECharts as unknown as ComponentType<EChartsReactProps>;

interface ResultsPerformanceComparisonPanelProps {
  comparison: ResultsPerformanceComparisonView;
  embedded?: boolean;
}

function formatValue(value: number | null | undefined, unit = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }
  const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return unit ? `${rounded} ${unit}` : rounded;
}

function groupLabel(group: ResultsPerformanceComparisonView['groups'][number]): string {
  return `${group.server_name} / ${group.model_name}`;
}

export function ResultsPerformanceComparisonPanel({ comparison, embedded = false }: ResultsPerformanceComparisonPanelProps) {
  const metricOptions = comparison.metrics.filter((metric) =>
    comparison.groups.some((group) => group.metrics[metric.metric_key])
  );
  const [selectedMetric, setSelectedMetric] = useState<ResultsPerformanceComparisonMetricKey>(
    comparison.default_metric
  );
  const activeMetric = metricOptions.find((metric) => metric.metric_key === selectedMetric) ?? metricOptions[0];
  const activeMetricKey = activeMetric?.metric_key;
  const activeUnit = activeMetric?.unit ?? '';

  const rows = useMemo(() => {
    if (!activeMetricKey) {
      return [];
    }
    return comparison.groups
      .map((group) => {
        const metric = group.metrics[activeMetricKey];
        return metric ? { group, metric } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.metric.stats.median - b.metric.stats.median);
  }, [activeMetricKey, comparison.groups]);

  const option = useMemo<EChartsOption>(() => {
    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const data = params as { name?: string; data?: number[] };
          const values = Array.isArray(data.data) ? data.data : [];
          return [
            data.name ?? '',
            `min: ${formatValue(values[0], activeUnit)}`,
            `q1: ${formatValue(values[1], activeUnit)}`,
            `median: ${formatValue(values[2], activeUnit)}`,
            `q3: ${formatValue(values[3], activeUnit)}`,
            `max: ${formatValue(values[4], activeUnit)}`
          ].join('<br />');
        }
      },
      grid: {
        left: 64,
        right: 24,
        top: 24,
        bottom: 96
      },
      xAxis: {
        type: 'category',
        data: rows.map((row) => groupLabel(row.group)),
        axisLabel: {
          interval: 0,
          rotate: rows.length > 2 ? 28 : 0,
          hideOverlap: true
        }
      },
      yAxis: {
        type: 'value',
        scale: true,
        name: activeMetric ? `${activeMetric.label} (${activeUnit})` : '',
        axisLabel: {
          formatter: (value: number) => formatValue(value, activeUnit)
        }
      },
      series: [
        {
          name: activeMetric?.label ?? 'Performance',
          type: 'boxplot',
          data: rows.map((row) => [
            row.metric.stats.min,
            row.metric.stats.q1,
            row.metric.stats.median,
            row.metric.stats.q3,
            row.metric.stats.max
          ])
        }
      ]
    };
  }, [activeMetric, activeUnit, rows]);

  if (metricOptions.length === 0 || rows.length === 0) {
    return null;
  }

  const Wrapper = embedded ? 'div' : 'section';

  return (
    <Wrapper className={embedded ? 'results-comparison-panel' : 'results-panel results-comparison-panel'} data-panel-type="performance-comparison">
      <header className="results-panel__header">
        <div>
          <h2>Cold-start comparison</h2>
          <p className="muted">Raw sample performance by server and model</p>
        </div>
        <label className="results-comparison-metric">
          <span>Metric</span>
          <select
            value={activeMetricKey}
            onChange={(event) => setSelectedMetric(event.target.value as ResultsPerformanceComparisonMetricKey)}
          >
            {metricOptions.map((metric) => (
              <option key={metric.metric_key} value={metric.metric_key}>
                {metric.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="table-scroll">
        <table className="results-comparison-table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Model</th>
              <th>Test</th>
              <th>Samples</th>
              <th>Median</th>
              <th>P95</th>
              <th>Mean</th>
              <th>Min</th>
              <th>Max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ group, metric }) => (
              <tr key={`${group.group_id}:${metric.metric_key}`}>
                <td>{group.server_name}</td>
                <td>{group.model_name}</td>
                <td>{group.template_label}</td>
                <td>{metric.stats.count}</td>
                <td>{formatValue(metric.stats.median, metric.unit)}</td>
                <td>{formatValue(metric.stats.p95, metric.unit)}</td>
                <td>{formatValue(metric.stats.mean, metric.unit)}</td>
                <td>{formatValue(metric.stats.min, metric.unit)}</td>
                <td>{formatValue(metric.stats.max, metric.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReactECharts option={option} className="results-comparison-chart" notMerge lazyUpdate />
    </Wrapper>
  );
}
