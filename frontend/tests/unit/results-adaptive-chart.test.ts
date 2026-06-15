import { describe, expect, it } from 'vitest';

import {
  buildLatencyHistogram,
  resolveResultsChartMode
} from '../../src/services/results-adaptive-chart.js';
import type { ResultsDashboardView, ResultsFilterState, ResultsHistoryRow } from '../../src/services/results-view-api.js';

const filters: ResultsFilterState = {
  date_from: '2026-05-01T00:00:00.000Z',
  date_to: '2026-05-02T00:00:00.000Z',
  server_ids: [],
  model_names: [],
  template_ids: [],
  statuses: [],
  tags: [],
  score_min: null,
  score_max: null,
  sort_by: 'started_at',
  sort_dir: 'desc',
  page: 1,
  page_size: 50
};

function dashboard(overrides: Partial<ResultsDashboardView> = {}): ResultsDashboardView {
  return {
    scorecards: {
      total_runs: 0,
      pass_rate: null,
      median_latency_ms: null,
      median_cost: null
    },
    pass_rate_series: [],
    latency_series: [],
    model_summary: [],
    performance_comparison: {
      default_metric: 'cold_penalty_ms',
      metrics: [{ metric_key: 'cold_penalty_ms', label: 'Cold penalty', unit: 'ms' }],
      groups: []
    },
    recent_runs: [],
    ...overrides
  };
}

function row(overrides: Partial<ResultsHistoryRow>): ResultsHistoryRow {
  return {
    run_id: 'run-a',
    status: 'pass',
    started_at: '2026-05-01T10:00:00.000Z',
    ended_at: null,
    duration_ms: null,
    server_id: 'srv',
    server_name: 'Server',
    model_name: 'model-a',
    template_id: 'template',
    template_label: 'Template',
    score: 100,
    latency_ms: 100,
    cost: 0.001,
    tags: [],
    result_count: 1,
    ...overrides
  };
}

describe('results adaptive chart helpers', () => {
  it('preserves cold-start comparison as the auto default when sample comparisons exist', () => {
    const view = dashboard({
      scorecards: { total_runs: 1, pass_rate: 100, median_latency_ms: 100, median_cost: null },
      performance_comparison: {
        default_metric: 'cold_penalty_ms',
        metrics: [{ metric_key: 'cold_penalty_ms', label: 'Cold penalty', unit: 'ms' }],
        groups: [
          {
            group_id: 'srv|model-a|template',
            server_id: 'srv',
            server_name: 'Server',
            model_name: 'model-a',
            template_id: 'template',
            template_label: 'Template',
            metrics: {
              cold_penalty_ms: {
                metric_key: 'cold_penalty_ms',
                label: 'Cold penalty',
                unit: 'ms',
                samples: [80, 90, 100],
                stats: { count: 3, min: 80, q1: 85, median: 90, q3: 95, p95: 99, max: 100, mean: 90 }
              }
            }
          }
        ]
      }
    });

    expect(resolveResultsChartMode('auto', view, filters)).toBe('cold-start');
  });

  it('uses a latency histogram when auto has enough latency samples and no comparison samples', () => {
    const view = dashboard({
      scorecards: { total_runs: 6, pass_rate: 100, median_latency_ms: 125, median_cost: null },
      latency_series: [{ label: 'model-a', points: [80, 90, 100, 120, 130, 140].map((y, index) => ({ x: `run-${index}`, y })) }]
    });

    expect(resolveResultsChartMode('auto', view, filters)).toBe('latency-histogram');
  });

  it('uses latency trend when a recent run is focused', () => {
    const view = dashboard({
      scorecards: { total_runs: 2, pass_rate: 100, median_latency_ms: 95, median_cost: null },
      latency_series: [{ label: 'model-a', points: [{ x: 'run-a', y: 90 }, { x: 'run-b', y: 100 }] }]
    });

    expect(resolveResultsChartMode('auto', view, filters, row({ run_id: 'run-a' }))).toBe('latency-trend');
  });

  it('builds latency histogram buckets from model series', () => {
    const buckets = buildLatencyHistogram([
      { label: 'model-a', points: [{ x: 'a', y: 50 }, { x: 'b', y: 150 }] },
      { label: 'model-b', points: [{ x: 'c', y: 250 }] }
    ], 2);

    expect(buckets).toHaveLength(2);
    expect(buckets[0].series).toContainEqual({ label: 'model-a', count: 1 });
    expect(buckets[1].series).toContainEqual({ label: 'model-a', count: 1 });
    expect(buckets[1].series).toContainEqual({ label: 'model-b', count: 1 });
  });
});
