import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { InferenceServerErrors } from '../components/InferenceServerErrors.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import {
  buildBenchmarkSmokePayload,
  createBenchmarkInstantiation,
  prepareBenchmarkDatasetManifest,
  runBenchmarkInstantiation,
  type BenchmarkDatasetFormat,
  type BenchmarkInstantiationRecord,
  type BenchmarkResultRecord
} from '../services/benchmark-api.js';
import type { InferenceServerHealth } from '../services/connectivity-api.js';
import { DEFAULT_INFERENCE_PARAMS } from '../services/inference-param-presets-api.js';
import { InferenceServerRecord, listInferenceServers } from '../services/inference-servers-api.js';
import { listModels, ModelRecord } from '../services/models-api.js';
import {
  RUN_ACCENTS,
  assignRunAccents,
  mergeRunModelOptions,
  parseRunTargets,
  serializeRunTargets,
  targetKey,
  type RunModelOption,
  type RunTarget
} from '../services/run-unified-utils.js';

function formatMetric(value: unknown, suffix = 'ms'): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} ${suffix}` : 'N/A';
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'N/A';
}

function optionLabel(option: RunModelOption): string {
  return `${option.display_name} · ${option.server_name}`;
}

function answerText(result: BenchmarkResultRecord | null): string {
  if (!result) {
    return 'Waiting for a benchmark run.';
  }
  const normalized = normalizedResponseItems(result)[0]?.response;
  if (typeof normalized?.answer_text === 'string' && normalized.answer_text.length > 0) {
    return normalized.answer_text;
  }
  if (result.document.errors.length > 0) {
    return result.document.errors
      .map((error) => String(error.message ?? error.code ?? 'Benchmark item failed.'))
      .join('\n');
  }
  return result.document.status === 'completed' ? 'Completed without answer text.' : result.document.status;
}

interface NormalizedResponseItem {
  label: string;
  response: Record<string, unknown>;
}

function normalizedResponseItems(result: BenchmarkResultRecord | null): NormalizedResponseItem[] {
  if (!result) {
    return [];
  }
  return result.document.normalized_responses.map((response, index) => {
    const itemIndex = typeof response.item_index === 'number' ? response.item_index : index;
    const iteration = typeof response.iteration === 'number' && response.iteration > 1 ? ` · iteration ${response.iteration}` : '';
    return {
      label: `item ${itemIndex + 1}${iteration}`,
      response
    };
  });
}

function responseAnswerText(response: Record<string, unknown>): string {
  return typeof response.answer_text === 'string' && response.answer_text.length > 0
    ? response.answer_text
    : 'Completed without answer text.';
}

function numberValues(rows: Record<string, unknown>[], key: string): number[] {
  return rows.map((row) => row[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function sum(values: number[]): number | null {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? sum(values)! / values.length : null;
}

function benchmarkMetrics(result: BenchmarkResultRecord | null): Record<string, unknown> {
  const rows = result?.document.metric_results ?? [];
  if (rows.length === 0) {
    return {};
  }
  if (rows.length === 1) {
    return rows[0] ?? {};
  }
  return {
    elapsed_ms: mean(numberValues(rows, 'elapsed_ms')),
    first_token_ms: mean(numberValues(rows, 'first_token_ms')),
    input_tokens: sum(numberValues(rows, 'input_tokens')),
    output_tokens: sum(numberValues(rows, 'output_tokens')),
    total_tokens: sum(numberValues(rows, 'total_tokens')),
    item_count: rows.length
  };
}

function aggStat(result: BenchmarkResultRecord | null, metric: string, stat: string): number | null {
  const agg = result?.document.aggregated_metrics as Record<string, Record<string, unknown>> | undefined;
  const entry = agg?.[metric];
  const value = entry?.[stat];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface CorrectnessMetric {
  label: string;
  successRate: number;
  count: number;
}

const CORRECTNESS_METRIC_LABELS: Record<string, string> = {
  exact_match: 'exact match',
  json_valid: 'JSON valid',
  schema_valid: 'schema valid',
  regex_match: 'regex match',
  contains_required_terms: 'terms found',
  tool_selected_correctly: 'tool selected',
  tool_arguments_valid: 'tool args valid',
  missing_tool_call: 'missing tool',
  hallucinated_tool_call: 'hallucinated tool'
};

function correctnessMetrics(result: BenchmarkResultRecord | null): CorrectnessMetric[] {
  const agg = result?.document.aggregated_metrics as Record<string, Record<string, unknown>> | undefined;
  if (!agg) return [];
  return Object.entries(agg)
    .filter(([key, entry]) => key in CORRECTNESS_METRIC_LABELS && typeof entry?.success_rate === 'number')
    .map(([key, entry]) => ({
      label: CORRECTNESS_METRIC_LABELS[key] ?? key,
      successRate: entry.success_rate as number,
      count: typeof entry.count === 'number' ? entry.count : 0
    }));
}

function streamSummary(result: BenchmarkResultRecord | null): string {
  const responses = normalizedResponseItems(result);
  const streams = responses
    .map((item) => item.response.stream)
    .filter((stream) => stream && typeof stream === 'object') as Record<string, unknown>[];
  if (streams.length === 0) {
    return 'none';
  }
  if (streams.length > 1) {
    return `${streams.length} item streams`;
  }
  const stream = streams[0];
  const events = Array.isArray(stream.events) ? stream.events.length : 0;
  return `${String(stream.format ?? 'stream')} · ${events} events · ${stream.done === true ? 'done' : 'open'}`;
}

type RunDatasetMode = 'inline' | 'manifest_only';

function datasetManifest(instantiation: BenchmarkInstantiationRecord | null): Record<string, unknown> | null {
  const dataset = instantiation?.document.dataset;
  return dataset && typeof dataset === 'object' && !Array.isArray(dataset)
    ? dataset as Record<string, unknown>
    : null;
}

function resultStatus(result: BenchmarkResultRecord | null, busy: boolean): string {
  if (busy) {
    return 'running';
  }
  return result?.document.status ?? 'idle';
}

function ConfigRail({
  servers,
  selectableServers,
  options,
  selectedTargets,
  busy,
  timeoutSec,
  seed,
  customServerId,
  prompt,
  systemPrompt,
  datasetMode,
  datasetId,
  datasetFormat,
  datasetPath,
  onAddTarget,
  onRemoveTarget,
  onCustomServerChange,
  onTimeoutChange,
  onSeedChange,
  onPromptChange,
  onSystemPromptChange,
  onDatasetModeChange,
  onDatasetIdChange,
  onDatasetFormatChange,
  onDatasetPathChange,
  onRun
}: {
  servers: InferenceServerRecord[];
  selectableServers: InferenceServerRecord[];
  options: RunModelOption[];
  selectedTargets: RunTarget[];
  busy: boolean;
  timeoutSec: string;
  seed: string;
  customServerId: string;
  prompt: string;
  systemPrompt: string;
  datasetMode: RunDatasetMode;
  datasetId: string;
  datasetFormat: BenchmarkDatasetFormat;
  datasetPath: string;
  onAddTarget: (target: RunTarget) => void;
  onRemoveTarget: (target: RunTarget) => void;
  onCustomServerChange: (value: string) => void;
  onTimeoutChange: (value: string) => void;
  onSeedChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onDatasetModeChange: (value: RunDatasetMode) => void;
  onDatasetIdChange: (value: string) => void;
  onDatasetFormatChange: (value: BenchmarkDatasetFormat) => void;
  onDatasetPathChange: (value: string) => void;
  onRun: () => void;
}) {
  const accentedTargets = assignRunAccents(selectedTargets);
  const selectedKeys = new Set(selectedTargets.map(targetKey));
  const selectedServer = servers.find((server) => server.inference_server.server_id === customServerId)
    ?? selectableServers[0]
    ?? null;
  const selectedServerId = selectedServer?.inference_server.server_id ?? '';
  const remainingOptions = options.filter((option) =>
    option.inference_server_id === selectedServerId && !selectedKeys.has(targetKey(option))
  );
  const selectedOptions = new Map(options.map((option) => [targetKey(option), option]));
  const target = selectedTargets[0] ?? null;
  const serverLabel = target
    ? servers.find((server) => server.inference_server.server_id === target.inference_server_id)?.inference_server.display_name ?? target.inference_server_id
    : selectedServer?.inference_server.display_name ?? 'No server selected';
  const canRun = selectedTargets.length >= 1 && !busy && (
    datasetMode === 'inline'
      ? prompt.trim().length > 0
      : datasetId.trim().length > 0 && datasetPath.trim().length > 0
  );

  return (
    <aside className="run-config-rail" aria-label="Run configuration">
      <div className="run-config-step">
        <div className="run-step-label">Step 1 · server</div>
        <div className="run-server-field">
          <span>{serverLabel}</span>
          <button type="button" disabled>edit</button>
        </div>
        <label className="run-server-select">
          Inference server
          <select value={customServerId} onChange={(event) => onCustomServerChange(event.target.value)}>
            <option value="">Select an inference server</option>
            {selectableServers.map((server) => (
              <option key={server.inference_server.server_id} value={server.inference_server.server_id}>
                {server.inference_server.display_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="run-config-step">
        <div className="run-step-label">Step 2 · model</div>
        <div className={selectedTargets.length === 0 ? 'run-chip-cloud is-empty' : 'run-chip-cloud'}>
          {accentedTargets.map((entry) => {
            const option = selectedOptions.get(targetKey(entry));
            return (
              <span className="run-model-chip" key={targetKey(entry)}>
                <span className="run-avatar" style={{ background: entry.accent }}>{entry.stable_letter}</span>
                <span title={option?.display_name ?? entry.model_id}>{option?.display_name ?? entry.model_id}</span>
                <button type="button" aria-label={`Remove ${option?.display_name ?? entry.model_id}`} onClick={() => onRemoveTarget(entry)}>x</button>
              </span>
            );
          })}
          <label className="run-add-model">
            {selectedTargets.length === 0 ? 'Add model' : 'Add another model'}
            <select
              value=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                const option = options.find((entry) => targetKey(entry) === value);
                if (option) onAddTarget(option);
              }}
              disabled={remainingOptions.length === 0 || selectedTargets.length >= 8}
            >
              <option value="">{selectedTargets.length >= 8 ? '8 models selected' : remainingOptions.length === 0 ? 'No models found' : 'add model...'}</option>
              {remainingOptions.map((option) => (
                <option key={targetKey(option)} value={targetKey(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="run-count-line">{selectedTargets.length || 0} of 8 models selected · run executes the first selected model</div>
        <p className="run-hint">Run one model through either a smoke prompt or a server-side dataset file.</p>
      </div>

      <div className="run-config-step">
        <div className="run-step-label">Step 3 · dataset</div>
        <div className="segmented-control run-dataset-mode" aria-label="Dataset mode">
          <button type="button" className={datasetMode === 'inline' ? 'is-active' : ''} onClick={() => onDatasetModeChange('inline')}>
            Prompt
          </button>
          <button type="button" className={datasetMode === 'manifest_only' ? 'is-active' : ''} onClick={() => onDatasetModeChange('manifest_only')}>
            Server dataset
          </button>
        </div>
        {datasetMode === 'inline' ? (
          <>
        <label className="run-prompt-field">
          Prompt
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={5}
            placeholder="Ask the selected model something small."
          />
        </label>
        <label className="run-prompt-field">
          System prompt
          <textarea
            value={systemPrompt}
            onChange={(event) => onSystemPromptChange(event.target.value)}
            rows={3}
            placeholder="Optional"
          />
        </label>
          </>
        ) : (
          <>
            <label className="run-prompt-field">
              Dataset id
              <input
                value={datasetId}
                onChange={(event) => onDatasetIdChange(event.target.value)}
                placeholder="codegen-small"
              />
            </label>
            <div className="run-dataset-grid">
              <label>
                Format
                <select
                  value={datasetFormat}
                  onChange={(event) => onDatasetFormatChange(event.target.value as BenchmarkDatasetFormat)}
                >
                  <option value="jsonl">JSONL</option>
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                </select>
              </label>
              <label>
                Path
                <input
                  value={datasetPath}
                  onChange={(event) => onDatasetPathChange(event.target.value)}
                  placeholder="codegen-small.jsonl"
                />
              </label>
            </div>
          </>
        )}
      </div>

      <div className={selectedTargets.length === 0 ? 'run-config-step is-disabled' : 'run-config-step'}>
        <div className="run-step-label">Step 4 · options</div>
        <div className="run-options-grid">
          <label>
            Items
            <input value="1" readOnly />
          </label>
          <label>
            Concurrency
            <input value="1" readOnly />
          </label>
          <label>
            Timeout
            <input value={timeoutSec} onChange={(event) => onTimeoutChange(event.target.value)} />
          </label>
          <label>
            Seed
            <input value={seed} onChange={(event) => onSeedChange(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="run-actions-row">
        <button type="button" onClick={onRun} disabled={!canRun}>
          {busy ? 'Running benchmark...' : 'Run benchmark'}
        </button>
      </div>
    </aside>
  );
}

function PromptStrip({
  prompt,
  systemPrompt,
  datasetMode,
  datasetId,
  datasetPath
}: {
  prompt: string;
  systemPrompt: string;
  datasetMode: RunDatasetMode;
  datasetId: string;
  datasetPath: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = datasetMode === 'manifest_only'
    ? `${datasetId.trim() || 'dataset'} · ${datasetPath.trim() || 'server path'}`
    : prompt.trim() || 'Enter a prompt in the rail.';
  return (
    <div className="run-prompt-strip">
      <span>{datasetMode === 'manifest_only' ? 'Benchmark dataset' : 'Benchmark item'}</span>
      <code>{preview}</code>
      <button type="button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? 'collapse' : 'expand'}
      </button>
      {expanded ? (
        <pre>{datasetMode === 'manifest_only'
          ? `manifest_only\n${preview}`
          : [systemPrompt.trim() ? `system: ${systemPrompt.trim()}` : null, `user: ${preview}`].filter(Boolean).join('\n\n')}</pre>
      ) : null}
    </div>
  );
}

function RunUnifiedEmpty() {
  return (
    <div className="run-empty-state">
      <div className="run-empty-blocks" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>Pick one model and prompt</h2>
      <p>The Run page now creates a benchmark instantiation and executes it immediately. Start with one small prompt before using the pipeline for larger benchmark runs.</p>
    </div>
  );
}

function BenchmarkDetail({
  target,
  option,
  instantiation,
  result,
  busy
}: {
  target: RunTarget;
  option: RunModelOption | undefined;
  instantiation: BenchmarkInstantiationRecord | null;
  result: BenchmarkResultRecord | null;
  busy: boolean;
}) {
  const metrics = benchmarkMetrics(result);
  const status = resultStatus(result, busy);
  const manifest = datasetManifest(instantiation);
  const responses = normalizedResponseItems(result);
  const itemCount = aggStat(result, 'elapsed_ms', 'count');
  const tokensPerSec = aggStat(result, 'tokens_per_second', 'mean');
  const latencyP95 = aggStat(result, 'elapsed_ms', 'p95');
  const correctness = correctnessMetrics(result);
  return (
    <div className="run-single-detail">
      <main className="run-transcript">
        <header className="run-response-header">
          <span className="run-avatar is-large" style={{ background: RUN_ACCENTS[0] }}>A</span>
          <div>
            <strong>{option?.display_name ?? target.model_id}</strong>
            <span>{option?.server_name ?? target.inference_server_id}{option?.quantisation ? ` · ${option.quantisation}` : ''}</span>
          </div>
          <b className={`run-status-pill status-${status}`}>{status}</b>
        </header>
        {result?.document.errors.length ? (
          <div className="run-failure-banner">
            <strong>Benchmark completed with errors.</strong>
            <span>{result.document.errors.map((error) => String(error.message ?? error.code ?? 'Unknown error')).join('; ')}</span>
          </div>
        ) : null}
        <div className="run-message-list">
          {busy || responses.length === 0 ? (
            <section className={busy ? 'run-message-card is-streaming' : 'run-message-card'}>
              <span>assistant · final</span>
              {busy ? <small>Executing synchronous benchmark request</small> : null}
              <pre>{busy ? 'Running...' : answerText(result)}{busy ? <i className="stream-cursor" /> : null}</pre>
            </section>
          ) : responses.map((item) => (
            <section className="run-message-card" key={`${item.label}:${String(item.response.attempt ?? '')}`}>
              <span>assistant · final · {item.label}</span>
              <pre>{responseAnswerText(item.response)}</pre>
            </section>
          ))}
        </div>
        <section className="run-asserts">
          <h3>Benchmark audit</h3>
          <div className={result?.document.status === 'completed_with_errors' ? 'run-assert-row is-fail' : 'run-assert-row'}>
            <span>{result?.document.status === 'completed_with_errors' ? 'x' : 'ok'}</span>
            <code>{result?.document.status ?? 'not-run'}</code>
          </div>
          <div className="run-assert-row">
            <span>id</span>
            <code>{instantiation?.id ?? 'no-instantiation'}</code>
          </div>
          <div className="run-assert-row">
            <span>run</span>
            <code>{result?.run_id ?? 'no-result'}</code>
          </div>
          <div className="run-assert-row">
            <span>items</span>
            <code>{formatNumber(manifest?.item_count)}</code>
          </div>
          <div className="run-assert-row">
            <span>dataset</span>
            <code>{String(manifest?.dataset_id ?? 'no-dataset')}</code>
          </div>
          <div className="run-assert-row">
            <span>hash</span>
            <code>{String(manifest?.dataset_hash ?? 'no-hash')}</code>
          </div>
        </section>
      </main>
      <aside className="run-side-metrics">
        <h3>Metrics</h3>
        <div className="run-metric-grid">
          <span><b>latency</b>{formatMetric(metrics.elapsed_ms)}</span>
          <span><b>ttft</b>{formatMetric(metrics.first_token_ms)}</span>
          <span><b>tokens in</b>{formatNumber(metrics.input_tokens)}</span>
          <span><b>tokens out</b>{formatNumber(metrics.output_tokens)}</span>
          <span><b>total tokens</b>{formatNumber(metrics.total_tokens)}</span>
          <span><b>stream</b>{streamSummary(result)}</span>
          {tokensPerSec !== null && (
            <span><b>tok / s</b>{formatMetric(tokensPerSec, 'tok/s')}</span>
          )}
          {latencyP95 !== null && itemCount !== null && itemCount > 1 && (
            <span><b>latency p95</b>{formatMetric(latencyP95)}</span>
          )}
          {itemCount !== null && itemCount > 1 && (
            <span><b>items</b>{String(itemCount)}</span>
          )}
        </div>
        {correctness.length > 0 && (
          <>
            <h3 style={{ marginTop: '16px' }}>Correctness</h3>
            <div className="run-metric-grid">
              {correctness.map(({ label, successRate, count }) => (
                <span key={label}>
                  <b>{label}</b>
                  {`${(successRate * 100).toFixed(0)}%`}
                  <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: '9px' }}>
                    {`${Math.round(successRate * count)} / ${count}`}
                  </span>
                </span>
              ))}
            </div>
          </>
        )}
        <details>
          <summary>Raw benchmark result</summary>
          <pre>{JSON.stringify(result ?? instantiation ?? {}, null, 2)}</pre>
        </details>
        <div className="run-side-actions">
          <button type="button" disabled>Open in Evaluate</button>
          <button type="button" disabled>Copy as cURL</button>
        </div>
      </aside>
    </div>
  );
}

export function RunUnified({ connectivitySnapshot = {} }: { connectivitySnapshot?: Record<string, InferenceServerHealth> }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [servers, setServers] = useState<InferenceServerRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<RunTarget[]>(() => parseRunTargets(searchParams).slice(0, 8));
  const [customServerId, setCustomServerId] = useState('');
  const [timeoutSec, setTimeoutSec] = useState('30');
  const [seed, setSeed] = useState('');
  const [prompt, setPrompt] = useState('Reply with exactly: OK');
  const [systemPrompt, setSystemPrompt] = useState('You are a concise assistant.');
  const [datasetMode, setDatasetMode] = useState<RunDatasetMode>('inline');
  const [datasetId, setDatasetId] = useState('codegen-small');
  const [datasetFormat, setDatasetFormat] = useState<BenchmarkDatasetFormat>('jsonl');
  const [datasetPath, setDatasetPath] = useState('codegen-small.jsonl');
  const inferenceParams = DEFAULT_INFERENCE_PARAMS;
  const [instantiation, setInstantiation] = useState<BenchmarkInstantiationRecord | null>(null);
  const [result, setResult] = useState<BenchmarkResultRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listInferenceServers(), listModels()])
      .then(([serverData, modelData]) => {
        setServers(serverData);
        setModels(modelData);
        setCustomServerId((current) => current || serverData[0]?.inference_server.server_id || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load run configuration.'));
  }, []);

  useEffect(() => {
    setSelectedTargets(parseRunTargets(searchParams).slice(0, 8));
  }, [searchParams]);

  useEffect(() => {
    const current = parseRunTargets(searchParams).slice(0, 8);
    if (JSON.stringify(current) === JSON.stringify(selectedTargets)) {
      return;
    }
    setSearchParams(serializeRunTargets(selectedTargets.slice(0, 8)), { replace: true });
  }, [searchParams, selectedTargets, setSearchParams]);

  const options = useMemo(() => mergeRunModelOptions(servers, models), [servers, models]);
  const selectableServers = useMemo(() => {
    const selectedServerIds = new Set(selectedTargets.map((target) => target.inference_server_id));
    return servers.filter((server) => {
      const id = server.inference_server.server_id;
      if (selectedServerIds.has(id)) {
        return true;
      }
      return connectivitySnapshot[id]?.ok === true;
    });
  }, [connectivitySnapshot, selectedTargets, servers]);
  useEffect(() => {
    if (selectedTargets.length > 0 || selectableServers.length === 0) {
      return;
    }
    if (!selectableServers.some((server) => server.inference_server.server_id === customServerId)) {
      setCustomServerId(selectableServers[0].inference_server.server_id);
    }
  }, [customServerId, selectableServers, selectedTargets.length]);
  const optionMap = useMemo(() => new Map(options.map((option) => [targetKey(option), option])), [options]);
  const selectedTarget = selectedTargets[0] ?? null;
  const selectedOption = selectedTarget ? optionMap.get(targetKey(selectedTarget)) : undefined;
  const subtitle = selectedTarget
    ? `${selectedTarget.model_id} · ${datasetMode === 'manifest_only' ? 'dataset run' : 'benchmark smoke'}`
    : `No model · ${datasetMode === 'manifest_only' ? 'dataset run' : 'benchmark smoke'}`;

  function addTarget(target: RunTarget) {
    setInstantiation(null);
    setResult(null);
    setSelectedTargets((current) => {
      const key = targetKey(target);
      if (current.some((entry) => targetKey(entry) === key)) {
        return current;
      }
      return [...current, target].slice(0, 8);
    });
  }

  function removeTarget(target: RunTarget) {
    setInstantiation(null);
    setResult(null);
    setSelectedTargets((current) => current.filter((entry) => targetKey(entry) !== targetKey(target)));
  }

  async function handleRun() {
    if (!selectedTarget) {
      return;
    }
    if (datasetMode === 'inline' && prompt.trim().length === 0) {
      return;
    }
    if (datasetMode === 'manifest_only' && (!datasetId.trim() || !datasetPath.trim())) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const preparedDataset = datasetMode === 'manifest_only'
        ? await prepareBenchmarkDatasetManifest({
            dataset_id: datasetId.trim(),
            source: {
              source_type: 'file',
              format: datasetFormat,
              path: datasetPath.trim()
            },
            metadata: { source: 'run-page-dataset-path' }
          })
        : undefined;
      const payload = buildBenchmarkSmokePayload({
        target: selectedTarget,
        prompt: prompt.trim(),
        systemPrompt,
        inferenceParams,
        timeoutSec,
        seed,
        dataset: preparedDataset
          ? { mode: 'manifest_only', manifest: preparedDataset }
          : { mode: 'inline', prompt: prompt.trim(), systemPrompt }
      });
      const created = await createBenchmarkInstantiation(payload);
      setInstantiation(created);
      const completed = await runBenchmarkInstantiation(created.id);
      setResult(completed);
      window.dispatchEvent(new CustomEvent('runs:changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to run benchmark.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MergedPageHeader title="Run" subtitle="Benchmark-backed smoke execution" />
      <section className="run-unified-page">
        <InferenceServerErrors message={error} />
        <div className="run-unified-layout">
          <ConfigRail
            servers={servers}
            selectableServers={selectableServers}
            options={options}
            selectedTargets={selectedTargets}
            busy={busy}
            timeoutSec={timeoutSec}
            seed={seed}
            customServerId={customServerId}
            prompt={prompt}
            systemPrompt={systemPrompt}
            datasetMode={datasetMode}
            datasetId={datasetId}
            datasetFormat={datasetFormat}
            datasetPath={datasetPath}
            onAddTarget={addTarget}
            onRemoveTarget={removeTarget}
            onCustomServerChange={setCustomServerId}
            onTimeoutChange={setTimeoutSec}
            onSeedChange={setSeed}
            onPromptChange={setPrompt}
            onSystemPromptChange={setSystemPrompt}
            onDatasetModeChange={setDatasetMode}
            onDatasetIdChange={setDatasetId}
            onDatasetFormatChange={setDatasetFormat}
            onDatasetPathChange={setDatasetPath}
            onRun={handleRun}
          />
          <main className="run-workspace">
            <header className="run-page-header">
              <div>
                <h1>Run</h1>
                <p>{subtitle}{result ? ` · ${result.document.status}` : busy ? ' · running' : ''}</p>
              </div>
              <div className="run-header-actions">
                <button type="button" disabled={!result}>Export</button>
              </div>
            </header>
            <PromptStrip
              prompt={prompt}
              systemPrompt={systemPrompt}
              datasetMode={datasetMode}
              datasetId={datasetId}
              datasetPath={datasetPath}
            />
            {!selectedTarget ? (
              <RunUnifiedEmpty />
            ) : (
              <BenchmarkDetail
                target={selectedTarget}
                option={selectedOption}
                instantiation={instantiation}
                result={result}
                busy={busy}
              />
            )}
          </main>
        </div>
      </section>
    </>
  );
}
