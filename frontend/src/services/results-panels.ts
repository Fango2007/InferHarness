export interface ResultsPanel {
  panel_id: string;
  presentation_type: 'performance_graph' | 'data_table';
  title: string;
  runtime_key: string | null;
  server_version: string | null;
  model_id: string | null;
  test_ids: string[];
  metric_keys: string[];
  unit_keys: string[];
  grouped: boolean;
  series?: Array<{ label: string; points: Array<{ x: string | number; y: number | null }> }>;
  rows?: Array<Record<string, string | number | boolean | null>>;
  missing_fields: string[];
}

export function toLocalInputValue(iso: string, boundary: 'from' | 'to' = 'from'): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  if (boundary === 'to' && (date.getSeconds() > 0 || date.getMilliseconds() > 0)) {
    date.setMinutes(date.getMinutes() + 1, 0, 0);
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
