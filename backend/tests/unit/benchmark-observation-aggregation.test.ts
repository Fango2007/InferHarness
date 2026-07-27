import { describe, expect, it } from 'vitest';

import {
  aggregateMetricObservations,
  planMetricObservationSamples,
  resolveCanonicalMetricIntents,
  type CanonicalMetricIntent,
  type MetricObservationSample
} from '../../src/services/benchmark-observation-aggregation.js';
import type {
  MetricObservation,
  MetricObservationStatus
} from '../../src/services/benchmark-metric-observations.js';

function observation(input: {
  metricId: string;
  value: number | boolean | null;
  unit: string;
  status?: MetricObservationStatus;
  providerId?: string | null;
  accountingScope?: Record<string, unknown> | null;
}): MetricObservation {
  return {
    metric_id: input.metricId,
    value: input.value,
    unit: input.unit,
    status: input.status ?? 'measured',
    reason: input.status && input.status !== 'measured' ? 'Test status.' : null,
    source: input.providerId === undefined ? 'client_observed' : 'provider_reported',
    metric_version: 'metrics-v2',
    provider_id: input.providerId ?? null,
    provider_protocol: input.providerId === undefined ? null : 'openai_chat',
    provider_version: input.providerId === undefined ? null : '2026-07-01',
    native_field: input.providerId === undefined ? null : `usage.${input.metricId}`,
    native_value: input.value,
    native_unit: input.unit,
    normalization: 'identity',
    accounting_scope: input.accountingScope ?? null
  };
}

function sample(input: {
  stageId?: string;
  pairMemberId?: string | null;
  itemIndex?: number;
  iteration?: number;
  attempted?: boolean;
  completed?: boolean;
  attempts?: MetricObservation[][];
  terminal?: MetricObservation[] | null;
} = {}): MetricObservationSample {
  const terminal = input.terminal === undefined ? [] : input.terminal;
  return {
    stage_id: input.stageId ?? 'chat',
    item_index: input.itemIndex ?? 0,
    iteration: input.iteration ?? 0,
    pair_member_id: input.pairMemberId ?? null,
    streaming: false,
    expected: true,
    attempted: input.attempted ?? true,
    completed: input.completed ?? true,
    attempt_observations: input.attempts ?? (terminal ? [terminal] : []),
    terminal_observations: terminal
  };
}

function intent(input: {
  metricId: string;
  valueType?: 'number' | 'boolean';
  unit?: string;
  stageId?: string;
  pairMemberId?: string | null;
}): CanonicalMetricIntent {
  return {
    stage_id: input.stageId ?? 'chat',
    pair_member_id: input.pairMemberId ?? null,
    metric_id: input.metricId,
    value_type: input.valueType ?? 'number',
    unit: input.unit ?? 'milliseconds'
  };
}

function metricIds(intents: CanonicalMetricIntent[]): string[] {
  return intents.map((candidate) => candidate.metric_id);
}

describe('resolveCanonicalMetricIntents', () => {
  it('adds execution defaults and maps legacy performance metrics', () => {
    const intents = resolveCanonicalMetricIntents({
      stage_id: 'chat',
      pair_member_id: null,
      requested_metrics: [
        'input_tokens',
        'output_tokens',
        'elapsed_ms',
        'tokens_per_second',
        'json_valid'
      ],
      streaming: false
    });

    expect(metricIds(intents)).toEqual(expect.arrayContaining([
      'request_success',
      'response_normalization_success',
      'attempt_count',
      'timeout_occurred',
      'retry_overhead_ms',
      'operation_elapsed_ms',
      'successful_attempt_latency_ms',
      'input_tokens',
      'output_tokens',
      'per_request_output_tokens_per_second'
    ]));
    expect(metricIds(intents)).not.toContain('json_syntax_valid');
    expect(metricIds(intents)).not.toContain('stream_completed');
  });

  it('adds streaming and tool timing defaults without canonicalizing correctness aliases', () => {
    const intents = resolveCanonicalMetricIntents({
      stage_id: 'tools',
      pair_member_id: null,
      requested_metrics: ['first_token_ms', 'tool_call_assertion_pass'],
      streaming: true
    });

    expect(metricIds(intents)).toEqual(expect.arrayContaining([
      'stream_completed',
      'time_to_first_chunk_ms',
      'time_to_first_output_ms',
      'time_per_output_token_ms',
      'decode_output_tokens_per_second',
      'time_to_first_tool_call_ms',
      'time_to_tool_calls_ready_ms'
    ]));
    expect(metricIds(intents)).not.toContain('tool_call_assertion_pass');
  });

  it('resolves only the selected pair member and includes derived-metric operands', () => {
    const baseline = resolveCanonicalMetricIntents({
      stage_id: 'pair',
      pair_member_id: 'baseline',
      requested_metrics: [
        'pair.baseline.output_tokens',
        'pair.candidate.input_tokens',
        'exact_match'
      ],
      derived_metric_references: [
        'pair.baseline.elapsed_ms',
        'pair.candidate.elapsed_ms'
      ],
      streaming: false
    });
    const candidate = resolveCanonicalMetricIntents({
      stage_id: 'pair',
      pair_member_id: 'candidate',
      requested_metrics: [
        'pair.baseline.output_tokens',
        'pair.candidate.input_tokens'
      ],
      derived_metric_references: [
        'pair.baseline.elapsed_ms',
        'pair.candidate.elapsed_ms'
      ],
      streaming: false
    });

    expect(metricIds(baseline)).toContain('output_tokens');
    expect(metricIds(baseline)).not.toContain('input_tokens');
    expect(metricIds(candidate)).toContain('input_tokens');
    expect(metricIds(candidate)).not.toContain('output_tokens');
    expect(metricIds(baseline)).toContain('operation_elapsed_ms');
    expect(metricIds(candidate)).toContain('operation_elapsed_ms');
  });
});

describe('planMetricObservationSamples', () => {
  it('plans request samples per stage and pair member while excluding non-recording stages', () => {
    const samples = planMetricObservationSamples({
      stages: [
        {
          stage_id: 'dataset',
          stage_type: 'dataset_loop',
          item_count: 2,
          iterations_per_item: 2,
          pair_member_ids: [],
          record_metrics: true
        },
        {
          stage_id: 'single',
          stage_type: 'single_request',
          item_count: 2,
          iterations_per_item: 1,
          pair_member_ids: [],
          record_metrics: true
        },
        {
          stage_id: 'pair',
          stage_type: 'paired_request_loop',
          item_count: 1,
          iterations_per_item: 1,
          pair_member_ids: ['cold', 'hot'],
          record_metrics: true
        },
        {
          stage_id: 'ignored',
          stage_type: 'dataset_loop',
          item_count: 2,
          iterations_per_item: 1,
          pair_member_ids: [],
          record_metrics: false
        }
      ],
      streaming: true
    });

    expect(samples).toHaveLength(7);
    expect(samples.filter(({ stage_id }) => stage_id === 'dataset')).toHaveLength(4);
    expect(samples.filter(({ stage_id }) => stage_id === 'single')).toHaveLength(1);
    expect(samples.filter(({ stage_id }) => stage_id === 'pair').map(
      ({ pair_member_id }) => pair_member_id
    )).toEqual(['cold', 'hot']);
    expect(samples.every((candidate) => (
      candidate.streaming
      && !candidate.attempted
      && candidate.terminal_observations === null
    ))).toBe(true);
  });

  it('keeps a pair member unattempted when an earlier member fails', () => {
    const planned = planMetricObservationSamples({
      stages: [{
        stage_id: 'pair',
        stage_type: 'paired_request_loop',
        item_count: 1,
        iterations_per_item: 1,
        pair_member_ids: ['cold', 'hot'],
        record_metrics: true
      }],
      streaming: false
    });
    planned[0] = {
      ...planned[0],
      attempted: true,
      completed: false,
      terminal_observations: []
    };
    const aggregates = aggregateMetricObservations({
      samples: planned,
      intents: [
        intent({
          stageId: 'pair',
          pairMemberId: 'cold',
          metricId: 'request_success',
          valueType: 'boolean',
          unit: 'boolean'
        }),
        intent({
          stageId: 'pair',
          pairMemberId: 'hot',
          metricId: 'request_success',
          valueType: 'boolean',
          unit: 'boolean'
        })
      ],
      requestedAggregations: []
    });

    expect(aggregates[0]).toMatchObject({
      pair_member_id: 'cold',
      expected_sample_count: 1,
      attempted_sample_count: 1,
      execution_error_sample_count: 1
    });
    expect(aggregates[1]).toMatchObject({
      pair_member_id: 'hot',
      expected_sample_count: 1,
      attempted_sample_count: 0,
      execution_error_sample_count: 0,
      coverage_rate: 0
    });
  });
});

describe('aggregateMetricObservations', () => {
  it('aggregates measured values and accounts for every sample status', () => {
    const aggregate = aggregateMetricObservations({
      samples: [
        sample({
          itemIndex: 0,
          terminal: [observation({ metricId: 'operation_elapsed_ms', value: 100, unit: 'milliseconds' })]
        }),
        sample({
          itemIndex: 1,
          terminal: [observation({ metricId: 'operation_elapsed_ms', value: 200, unit: 'milliseconds' })]
        }),
        sample({
          itemIndex: 2,
          terminal: [observation({
            metricId: 'operation_elapsed_ms',
            value: null,
            unit: 'milliseconds',
            status: 'unavailable'
          })]
        }),
        sample({ itemIndex: 3, attempted: false, completed: false, terminal: null }),
        sample({ itemIndex: 4, completed: false, terminal: [] })
      ],
      intents: [intent({ metricId: 'operation_elapsed_ms' })],
      requestedAggregations: ['mean', 'sum', 'p50', 'p95', 'count']
    })[0];

    expect(aggregate).toMatchObject({
      expected_sample_count: 5,
      attempted_sample_count: 4,
      completed_sample_count: 3,
      valid_sample_count: 2,
      passed_sample_count: 0,
      unavailable_sample_count: 1,
      not_applicable_sample_count: 0,
      execution_error_sample_count: 1,
      coverage_rate: 0.4,
      statistics: {
        mean: 150,
        sum: 300,
        p50: 150,
        p95: 195
      }
    });
    expect(aggregate.statistics).not.toHaveProperty('count');
    expect(aggregate.warnings).toContain('insufficient_valid_samples_for_p95');
  });

  it('computes boolean rates without treating false as unavailable', () => {
    const aggregate = aggregateMetricObservations({
      samples: [
        sample({
          itemIndex: 0,
          terminal: [observation({ metricId: 'request_success', value: true, unit: 'boolean' })]
        }),
        sample({
          itemIndex: 1,
          terminal: [observation({ metricId: 'request_success', value: false, unit: 'boolean' })]
        }),
        sample({
          itemIndex: 2,
          terminal: [observation({
            metricId: 'request_success',
            value: null,
            unit: 'boolean',
            status: 'not_applicable'
          })]
        }),
        sample({ itemIndex: 3, attempted: false, completed: false, terminal: null })
      ],
      intents: [intent({
        metricId: 'request_success',
        valueType: 'boolean',
        unit: 'boolean'
      })],
      requestedAggregations: ['mean']
    })[0];

    expect(aggregate).toMatchObject({
      expected_sample_count: 4,
      valid_sample_count: 2,
      passed_sample_count: 1,
      unavailable_sample_count: 0,
      not_applicable_sample_count: 1,
      observed_pass_rate: 0.5,
      coverage_rate: 0.5,
      end_to_end_pass_rate: 0.25,
      statistics: {}
    });
  });

  it('reports zero coverage for a fully missing requested metric', () => {
    const aggregate = aggregateMetricObservations({
      samples: [
        sample({ itemIndex: 0, terminal: [] }),
        sample({ itemIndex: 1, attempted: false, completed: false, terminal: null })
      ],
      intents: [intent({ metricId: 'server_decode_time_ms' })],
      requestedAggregations: ['mean']
    })[0];

    expect(aggregate).toMatchObject({
      expected_sample_count: 2,
      attempted_sample_count: 1,
      completed_sample_count: 1,
      valid_sample_count: 0,
      unavailable_sample_count: 1,
      execution_error_sample_count: 0,
      coverage_rate: 0,
      statistics: {}
    });
  });

  it('uses only the terminal observation set for a retried request', () => {
    const firstAttempt = [
      observation({ metricId: 'attempt_count', value: 1, unit: 'attempts' })
    ];
    const terminal = [
      observation({ metricId: 'attempt_count', value: 2, unit: 'attempts' })
    ];
    const aggregate = aggregateMetricObservations({
      samples: [sample({
        attempts: [firstAttempt, terminal],
        terminal
      })],
      intents: [intent({ metricId: 'attempt_count', unit: 'attempts' })],
      requestedAggregations: ['mean', 'sum']
    })[0];

    expect(aggregate.valid_sample_count).toBe(1);
    expect(aggregate.statistics).toEqual({ mean: 2, sum: 2 });
  });

  it('keeps stages and pair members in separate aggregate groups', () => {
    const aggregates = aggregateMetricObservations({
      samples: [
        sample({
          stageId: 'pair',
          pairMemberId: 'baseline',
          terminal: [observation({ metricId: 'output_tokens', value: 10, unit: 'tokens' })]
        }),
        sample({
          stageId: 'pair',
          pairMemberId: 'candidate',
          terminal: [observation({ metricId: 'output_tokens', value: 20, unit: 'tokens' })]
        }),
        sample({
          stageId: 'other',
          terminal: [observation({ metricId: 'output_tokens', value: 30, unit: 'tokens' })]
        })
      ],
      intents: [
        intent({
          stageId: 'pair',
          pairMemberId: 'baseline',
          metricId: 'output_tokens',
          unit: 'tokens'
        }),
        intent({
          stageId: 'pair',
          pairMemberId: 'candidate',
          metricId: 'output_tokens',
          unit: 'tokens'
        }),
        intent({ stageId: 'other', metricId: 'output_tokens', unit: 'tokens' })
      ],
      requestedAggregations: ['mean']
    });

    expect(aggregates.map((aggregate) => [
      aggregate.stage_id,
      aggregate.pair_member_id,
      aggregate.statistics.mean
    ])).toEqual([
      ['pair', 'baseline', 10],
      ['pair', 'candidate', 20],
      ['other', null, 30]
    ]);
  });

  it('preserves zero numeric values as measured evidence', () => {
    const aggregate = aggregateMetricObservations({
      samples: [sample({
        terminal: [observation({ metricId: 'retry_overhead_ms', value: 0, unit: 'milliseconds' })]
      })],
      intents: [intent({ metricId: 'retry_overhead_ms' })],
      requestedAggregations: ['mean']
    })[0];

    expect(aggregate.valid_sample_count).toBe(1);
    expect(aggregate.statistics.mean).toBe(0);
  });

  it('suppresses statistics for incompatible provenance or accounting scope', () => {
    const aggregate = aggregateMetricObservations({
      samples: [
        sample({
          itemIndex: 0,
          terminal: [observation({
            metricId: 'output_tokens',
            value: 10,
            unit: 'tokens',
            providerId: 'server-1',
            accountingScope: { candidate_count: 1 }
          })]
        }),
        sample({
          itemIndex: 1,
          terminal: [observation({
            metricId: 'output_tokens',
            value: 20,
            unit: 'tokens',
            providerId: 'server-1',
            accountingScope: { candidate_count: 2 }
          })]
        })
      ],
      intents: [intent({ metricId: 'output_tokens', unit: 'tokens' })],
      requestedAggregations: ['mean', 'sum']
    })[0];

    expect(aggregate).toMatchObject({
      valid_sample_count: 2,
      aggregation_eligible: false,
      statistics: {}
    });
    expect(aggregate.provenance_signatures).toHaveLength(2);
    expect(aggregate.warnings).toContain('incompatible_provenance_or_accounting_scope');
  });

  it('computes R type 7 percentiles for compatible measured values', () => {
    const samples = Array.from({ length: 10 }, (_, index) => sample({
      itemIndex: index,
      terminal: [observation({
        metricId: 'operation_elapsed_ms',
        value: index + 1,
        unit: 'milliseconds'
      })]
    }));
    const aggregate = aggregateMetricObservations({
      samples,
      intents: [intent({ metricId: 'operation_elapsed_ms' })],
      requestedAggregations: ['p90', 'p95', 'p99']
    })[0];

    expect(aggregate.statistics.p90).toBeCloseTo(9.1);
    expect(aggregate.statistics.p95).toBeCloseTo(9.55);
    expect(aggregate.statistics.p99).toBeCloseTo(9.91);
    expect(aggregate.warnings).not.toContain('insufficient_valid_samples_for_p90');
    expect(aggregate.warnings).toEqual(expect.arrayContaining([
      'insufficient_valid_samples_for_p95',
      'insufficient_valid_samples_for_p99'
    ]));
  });

  it('rejects duplicate observations and conflicting units, types, or versions', () => {
    const duplicate = observation({
      metricId: 'operation_elapsed_ms',
      value: 100,
      unit: 'milliseconds'
    });
    expect(() => aggregateMetricObservations({
      samples: [sample({ terminal: [duplicate, duplicate] })],
      intents: [intent({ metricId: 'operation_elapsed_ms' })],
      requestedAggregations: ['mean']
    })).toThrow('Duplicate metric observation');

    expect(() => aggregateMetricObservations({
      samples: [sample({
        terminal: [observation({
          metricId: 'operation_elapsed_ms',
          value: 100,
          unit: 'seconds'
        })]
      })],
      intents: [intent({ metricId: 'operation_elapsed_ms' })],
      requestedAggregations: ['mean']
    })).toThrow('Conflicting unit');

    expect(() => aggregateMetricObservations({
      samples: [sample({
        terminal: [observation({
          metricId: 'request_success',
          value: 1,
          unit: 'boolean'
        })]
      })],
      intents: [intent({
        metricId: 'request_success',
        valueType: 'boolean',
        unit: 'boolean'
      })],
      requestedAggregations: ['mean']
    })).toThrow('Conflicting value type');

    const wrongVersion = {
      ...observation({
        metricId: 'operation_elapsed_ms',
        value: 100,
        unit: 'milliseconds'
      }),
      metric_version: 'metrics-v1'
    } as unknown as MetricObservation;
    expect(() => aggregateMetricObservations({
      samples: [sample({ terminal: [wrongVersion] })],
      intents: [intent({ metricId: 'operation_elapsed_ms' })],
      requestedAggregations: ['mean']
    })).toThrow('Unexpected metric version');
  });
});
