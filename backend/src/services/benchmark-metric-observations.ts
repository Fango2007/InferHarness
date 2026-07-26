export type MetricObservationStatus =
  | 'measured'
  | 'not_applicable'
  | 'unavailable'
  | 'execution_error';

export type MetricObservationSource =
  | 'client_observed'
  | 'provider_reported'
  | 'server_reported'
  | 'derived'
  | 'heuristic'
  | 'human_rated'
  | 'host_telemetry';

export type ProviderProtocol =
  | 'ollama_chat'
  | 'openai_chat'
  | 'anthropic_messages'
  | 'gemini_generate_content';

export interface MetricObservation {
  metric_id: string;
  value: number | boolean | null;
  unit: string;
  status: MetricObservationStatus;
  reason: string | null;
  source: MetricObservationSource;
  metric_version: 'metrics-v2';
  provider_id: string | null;
  provider_protocol: ProviderProtocol | null;
  provider_version: string | null;
  native_field: string | null;
  native_value: number | boolean | null;
  native_unit: string | null;
  normalization: string | null;
  accounting_scope: Record<string, unknown> | null;
}

export function measuredMetricValue(
  observations: MetricObservation[],
  metricId: string
): number | null {
  const observation = observations.find(
    (candidate) => candidate.metric_id === metricId && candidate.status === 'measured'
  );
  return typeof observation?.value === 'number' ? observation.value : null;
}
