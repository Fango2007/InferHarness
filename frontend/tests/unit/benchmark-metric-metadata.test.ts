import { describe, expect, it } from 'vitest';

import {
  TOOL_CALL_ASSERTION_METRIC,
  correctnessMetricTiles,
  ensureToolCallAssertionMetric,
  groupedBenchmarkMetrics
} from '../../src/services/benchmark-metric-metadata.js';

describe('benchmark metric metadata', () => {
  it('groups tool-call assertion before diagnostic tool metrics', () => {
    const toolMetrics = groupedBenchmarkMetrics()
      .find((group) => group.group === 'tool_calling')
      ?.metrics.map((metric) => metric.id);

    expect(toolMetrics?.slice(0, 5)).toEqual([
      TOOL_CALL_ASSERTION_METRIC,
      'tool_call_count',
      'tool_selected_correctly',
      'tool_arguments_valid',
      'missing_tool_call'
    ]);
  });

  it('adds the tool-call assertion metric when tool calling is enabled', () => {
    expect(ensureToolCallAssertionMetric(['elapsed_ms'], true)).toEqual(['elapsed_ms', TOOL_CALL_ASSERTION_METRIC]);
    expect(ensureToolCallAssertionMetric([TOOL_CALL_ASSERTION_METRIC], true)).toEqual([TOOL_CALL_ASSERTION_METRIC]);
    expect(ensureToolCallAssertionMetric(['elapsed_ms'], false)).toEqual(['elapsed_ms']);
  });

  it('orders the tool-call verdict before diagnostic correctness metrics', () => {
    const tiles = correctnessMetricTiles({
      tool_arguments_valid: { success_rate: 1, count: 2 },
      tool_call_assertion_pass: { success_rate: 1, count: 2 },
      tool_selected_correctly: { success_rate: 1, count: 2 }
    });

    expect(tiles.map((tile) => tile.id)).toEqual([
      TOOL_CALL_ASSERTION_METRIC,
      'tool_selected_correctly',
      'tool_arguments_valid'
    ]);
    expect(tiles[0]).toMatchObject({
      displayLabel: 'Tool call pass',
      state: 'pass'
    });
  });

  it('marks the tool-call verdict as failed when success rate is below full pass', () => {
    const [tile] = correctnessMetricTiles({
      tool_call_assertion_pass: { success_rate: 0, count: 2 }
    });

    expect(tile).toMatchObject({
      displayLabel: 'Tool call fail',
      state: 'fail',
      successRate: 0,
      count: 2
    });
  });
});
