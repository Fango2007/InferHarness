import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import _ReactECharts from 'echarts-for-react';
import type { EChartsReactProps } from 'echarts-for-react';
import type { EChartsOption } from 'echarts/types/dist/shared';

const ReactECharts = _ReactECharts as unknown as ComponentType<EChartsReactProps>;

import { ResultsPanel } from '../services/results-panels.js';

interface ResultsGraphPanelProps {
  panel: ResultsPanel;
}

function inferUnit(metricKey: string, panel: ResultsPanel): string {
  const declared = panel.unit_keys.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  if (declared) {
    return declared;
  }
  const normalized = metricKey.toLowerCase();
  if (normalized.includes('ms') || normalized.endsWith('_ms')) {
    return 'ms';
  }
  if (normalized.includes('sec') || normalized.endsWith('_s')) {
    return 's';
  }
  if (normalized.includes('tokens_per_sec') || normalized.includes('tok_s')) {
    return 'tokens/s';
  }
  if (normalized.includes('percent') || normalized.endsWith('_pct')) {
    return '%';
  }
  return '';
}

function normalizeSeriesData(
  points: Array<{ x: string | number; y: number | null }>
): Array<[number, number] | [string, number]> {
  const normalized = points
    .map((point, index) => {
      if (point.y == null || !Number.isFinite(point.y)) {
        return null;
      }
      if (typeof point.x === 'number' && Number.isFinite(point.x)) {
        return [point.x, point.y] as [number, number];
      }
      const timestamp = Date.parse(String(point.x));
      if (Number.isFinite(timestamp)) {
        return [timestamp, point.y] as [number, number];
      }
      return [String(point.x || index), point.y] as [string, number];
    })
    .filter((entry): entry is [number, number] | [string, number] => entry !== null);
  return normalized.sort((a, b) => {
    if (typeof a[0] === 'number' && typeof b[0] === 'number') {
      return a[0] - b[0];
    }
    return String(a[0]).localeCompare(String(b[0]));
  });
}

export function ResultsGraphPanel({ panel }: ResultsGraphPanelProps) {
  const series = useMemo(() => panel.series ?? [], [panel.series]);
  const metricKey = panel.metric_keys[0] ?? panel.title;
  const unit = inferUnit(metricKey, panel);
  const [logScale, setLogScale] = useState(false);

  const option = useMemo<EChartsOption>(() => {
    const normalizedSeries = series.map((entry) => ({
      name: entry.label,
      data: normalizeSeriesData(entry.points)
    }));
    const isTimeAxis = normalizedSeries.some((entry) => entry.data.some((point) => typeof point[0] === 'number'));

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (value: unknown) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return String(value ?? '');
          }
          return unit ? `${value.toFixed(2)} ${unit}` : value.toFixed(2);
        }
      },
      legend: {
        type: 'scroll'
      },
      grid: {
        left: 56,
        right: 20,
        top: 36,
        bottom: 48
      },
      xAxis: {
        type: isTimeAxis ? 'time' : 'category',
        name: isTimeAxis ? 'Run time' : 'Run',
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: {
          hideOverlap: true,
          formatter: (value: number | string) => {
            if (!isTimeAxis) {
              return String(value);
            }
            const date = new Date(typeof value === 'number' ? value : Number(value));
            if (Number.isNaN(date.getTime())) {
              return String(value);
            }
            return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(
              date.getMinutes()
            ).padStart(2, '0')}`;
          }
        }
      },
      yAxis: {
        type: logScale ? 'log' : 'value',
        scale: true,
        name: unit ? `${metricKey} (${unit})` : metricKey,
        axisLabel: {
          formatter: (value: number) => {
            const pretty = Number.isFinite(value) ? Number(value.toFixed(2)).toString() : String(value);
            return unit ? `${pretty} ${unit}` : pretty;
          }
        }
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, bottom: 8 }
      ],
      series: normalizedSeries.map((entry) => ({
        name: entry.name,
        type: 'line',
        showSymbol: true,
        symbolSize: 8,
        connectNulls: false,
        emphasis: { focus: 'series' },
        data: entry.data
      }))
    };
  }, [logScale, metricKey, series, unit]);

  return (
    <article className="card dashboard-panel" data-panel-type="graph">
      <header>
        <h3>{panel.title}</h3>
        <p className="muted">
          Runtime: {panel.runtime_key ?? 'unknown'} | Version: {panel.server_version ?? 'unknown'} | Model:{' '}
          {panel.model_id ?? 'unknown'}
        </p>
      </header>
      {series.length === 0 ? (
        <p className="muted">No performance points available.</p>
      ) : (
        <>
          <label className="results-chart-toggle">
            <input type="checkbox" checked={logScale} onChange={(event) => setLogScale(event.target.checked)} />
            Log scale
          </label>
          <ReactECharts option={option} className="results-chart" notMerge lazyUpdate />
        </>
      )}
    </article>
  );
}
