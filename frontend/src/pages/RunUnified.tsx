import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { InferenceServerErrors } from '../components/InferenceServerErrors.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { HandoffToast, ProgressRibbon } from '../components/Onboarding.js';
import { useOnboardingContext } from '../onboarding-context.js';
import { isRibbonDismissed } from '../onboarding.js';
import {
  STARTER_BENCHMARK_TEMPLATE_ID,
  buildPersistedBenchmarkPlanDocument,
  buildBenchmarkSmokePayload,
  getBenchmarkInstantiation,
  getBenchmarkResult,
  listBenchmarkDocuments,
  prepareBenchmarkDatasetManifest,
  runPersistedBenchmarkPlan,
  saveBenchmarkDocument,
  saveBenchmarkPlan,
  starterBenchmarkTemplateDocument,
  type BenchmarkDatasetFormat,
  type BenchmarkInstantiationRecord,
  type BenchmarkPlanRunResult,
  type BenchmarkResultRecord,
  type BenchmarkTestTemplateDocument,
  type BenchmarkTestTemplateRecord
} from '../services/benchmark-api.js';
import type { InferenceServerHealth } from '../services/connectivity-api.js';
import { DEFAULT_INFERENCE_PARAMS, type InferenceParams } from '../services/inference-param-presets-api.js';
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

function firstMetricValue(result: BenchmarkResultRecord | null, field: string): number | null {
  const rows = result?.document.metric_results ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] as Record<string, unknown> | undefined;
  const v = first?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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

function newRunId(prefix: string): string {
  if (globalThis.crypto && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

function planResultForTarget(planResults: BenchmarkPlanRunResult[], target: RunTarget): BenchmarkPlanRunResult | null {
  const ref = `${target.inference_server_id}:${target.model_id}`;
  return planResults.find((entry) => entry.model_profile_ref === ref) ?? null;
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
  templates,
  selectedTemplateId,
  inferenceParams,
  onboardingActive,
  starterTemplateReady,
  starterBusy,
  onAddTarget,
  onRemoveTarget,
  onCustomServerChange,
  onTimeoutChange,
  onSeedChange,
  onInferenceParamsChange,
  onPromptChange,
  onSystemPromptChange,
  onDatasetModeChange,
  onDatasetIdChange,
  onDatasetFormatChange,
  onDatasetPathChange,
  onTemplateChange,
  onRun,
  onUseStarterTemplate
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
  templates: BenchmarkTestTemplateRecord[];
  selectedTemplateId: string;
  inferenceParams: InferenceParams;
  onboardingActive?: boolean;
  starterTemplateReady?: boolean;
  starterBusy?: boolean;
  onAddTarget: (target: RunTarget) => void;
  onRemoveTarget: (target: RunTarget) => void;
  onCustomServerChange: (value: string) => void;
  onTimeoutChange: (value: string) => void;
  onSeedChange: (value: string) => void;
  onInferenceParamsChange: (params: InferenceParams) => void;
  onPromptChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onDatasetModeChange: (value: RunDatasetMode) => void;
  onDatasetIdChange: (value: string) => void;
  onDatasetFormatChange: (value: BenchmarkDatasetFormat) => void;
  onDatasetPathChange: (value: string) => void;
  onTemplateChange: (value: string) => void;
  onRun: () => void;
  onUseStarterTemplate: () => Promise<void>;
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
        <div className="run-count-line">{selectedTargets.length || 0} of 8 models selected · {selectedTargets.length > 1 ? `run executes all ${selectedTargets.length} selected models` : 'run executes the selected model'}</div>
        <p className="run-hint">Run one or more models through a smoke prompt or server-side dataset. Multiple models produce a side-by-side comparison.</p>
      </div>

      <div className="run-config-step">
        <div className="run-step-label">Step 3 · template</div>
        {onboardingActive && selectedTargets.length > 0 ? (
          <div className="run-starter-template">
            <div>
              <strong>{starterTemplateReady ? 'Starter template ready' : 'Create your starter template'}</strong>
              <p>A reusable benchmark document for code explanation quality. You can edit it later in Templates.</p>
            </div>
            <button type="button" className="btn btn--sm" onClick={onUseStarterTemplate} disabled={starterBusy}>
              {starterBusy ? 'Preparing...' : starterTemplateReady ? 'Use starter template' : 'Create starter template'}
            </button>
          </div>
        ) : null}
        <label className="run-template-picker">
          Benchmark template
          <select value={selectedTemplateId} onChange={(event) => onTemplateChange(event.target.value)}>
            <option value="">Run smoke chat</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.document.name || template.document.template_id}
              </option>
            ))}
          </select>
        </label>
        <p className="run-hint">Saved chat templates run against the selected dataset. The smoke template remains available for quick checks.</p>
      </div>

      <div className="run-config-step">
        <div className="run-step-label">Step 4 · dataset</div>
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
        <div className="run-step-label">Step 5 · options</div>
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
          <label>
            Temperature
            <input
              type="number"
              step="0.01"
              min="0"
              max="2"
              value={inferenceParams.temperature ?? ''}
              onChange={(event) => onInferenceParamsChange({
                ...inferenceParams,
                temperature: event.target.value ? Number(event.target.value) : null
              })}
            />
          </label>
          <label>
            Top P
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={inferenceParams.top_p ?? ''}
              onChange={(event) => onInferenceParamsChange({
                ...inferenceParams,
                top_p: event.target.value ? Number(event.target.value) : null
              })}
            />
          </label>
          <label>
            Max tokens
            <input
              type="number"
              min="1"
              value={inferenceParams.max_tokens ?? ''}
              onChange={(event) => onInferenceParamsChange({
                ...inferenceParams,
                max_tokens: event.target.value ? Number(event.target.value) : null
              })}
            />
          </label>
          <label>
            Stream
            <select
              value={inferenceParams.stream ? 'true' : 'false'}
              onChange={(event) => onInferenceParamsChange({
                ...inferenceParams,
                stream: event.target.value === 'true'
              })}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
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
  planResult,
  planId,
  busy
}: {
  target: RunTarget;
  option: RunModelOption | undefined;
  instantiation: BenchmarkInstantiationRecord | null;
  result: BenchmarkResultRecord | null;
  planResult?: BenchmarkPlanRunResult | null;
  planId?: string | null;
  busy: boolean;
}) {
  const metrics = benchmarkMetrics(result);
  const status = planResult?.status ?? resultStatus(result, busy);
  const manifest = datasetManifest(instantiation);
  const responses = normalizedResponseItems(result);
  const itemCount = aggStat(result, 'elapsed_ms', 'count');
  const tokensPerSec = aggStat(result, 'tokens_per_second', 'mean');
  const decodeTokensPerSec = aggStat(result, 'decode_tokens_per_second', 'mean');
  const prefillTokensPerSec = aggStat(result, 'prefill_tokens_per_second', 'mean');
  const latencyP95 = aggStat(result, 'elapsed_ms', 'p95');
  const modelLoadMs = aggStat(result, 'load_duration_ms', 'max') ?? firstMetricValue(result, 'load_duration_ms');
  const serverTotalTimeMs = aggStat(result, 'server_total_time_ms', 'mean') ?? firstMetricValue(result, 'server_total_time_ms');
  const serverPromptEvalMs = aggStat(result, 'server_prompt_eval_ms', 'mean') ?? firstMetricValue(result, 'server_prompt_eval_ms');
  const serverEvalMs = aggStat(result, 'server_eval_ms', 'mean') ?? firstMetricValue(result, 'server_eval_ms');
  const loadEstimate = result?.document.load_estimate as { estimated_load_ms: number; model_load_detected: boolean } | null | undefined;
  const estimatedLoadMs = loadEstimate?.model_load_detected ? loadEstimate.estimated_load_ms : null;
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
        {!result && planResult && planResult.status !== 'completed' ? (
          <div className="run-failure-banner">
            <strong>Benchmark target did not produce a result.</strong>
            <span>{planResult.status}</span>
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
            <span>plan</span>
            <code>{planId ?? 'no-plan'}</code>
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
          <span><b>duration</b>{formatMetric(metrics.elapsed_ms)}</span>
          {serverTotalTimeMs !== null && (
            <span><b>server time</b>{formatMetric(serverTotalTimeMs)}</span>
          )}
          {serverPromptEvalMs !== null && (
            <span><b>server prefill</b>{formatMetric(serverPromptEvalMs)}</span>
          )}
          {serverEvalMs !== null && (
            <span><b>server decode</b>{formatMetric(serverEvalMs)}</span>
          )}
          {latencyP95 !== null && itemCount !== null && itemCount > 1 && (
            <span><b>duration p95</b>{formatMetric(latencyP95)}</span>
          )}
          <span><b>ttft</b>{formatMetric(metrics.first_token_ms)}</span>
          {modelLoadMs !== null && modelLoadMs > 0 && (
            <span><b>model load</b>{formatMetric(modelLoadMs)}</span>
          )}
          {modelLoadMs === null && estimatedLoadMs !== null && estimatedLoadMs > 0 && (
            <span className="is-estimated"><b>model load (est.)</b>{formatMetric(estimatedLoadMs)}</span>
          )}
          <span><b>tokens in</b>{formatNumber(metrics.input_tokens)}</span>
          <span><b>tokens out</b>{formatNumber(metrics.output_tokens)}</span>
          <span><b>total tokens</b>{formatNumber(metrics.total_tokens)}</span>
          <span><b>stream</b>{streamSummary(result)}</span>
          {decodeTokensPerSec !== null && (
            <span className="is-estimated"><b>tok / s (decode)</b>{formatMetric(decodeTokensPerSec, 'tok/s')}</span>
          )}
          {tokensPerSec !== null && (
            <span className="is-estimated"><b>tok / s (overall)</b>{formatMetric(tokensPerSec, 'tok/s')}</span>
          )}
          {prefillTokensPerSec !== null && (
            <span className="is-estimated"><b>prefill tok / s</b>{formatMetric(prefillTokensPerSec, 'tok/s')}</span>
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


export function RunUnified({
  connectivitySnapshot = {},
  onFirstRunSuccess
}: {
  connectivitySnapshot?: Record<string, InferenceServerHealth>;
  onFirstRunSuccess?: () => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const onboarding = useOnboardingContext();
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
  const [templates, setTemplates] = useState<BenchmarkTestTemplateRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [inferenceParams, setInferenceParams] = useState<InferenceParams>(DEFAULT_INFERENCE_PARAMS);
  const [starterTemplate, setStarterTemplate] = useState<BenchmarkTestTemplateDocument | null>(null);
  const [starterBusy, setStarterBusy] = useState(false);
  const [instantiation, setInstantiation] = useState<BenchmarkInstantiationRecord | null>(null);
  const [result, setResult] = useState<BenchmarkResultRecord | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [planResults, setPlanResults] = useState<BenchmarkPlanRunResult[]>([]);
  const [instantiations, setInstantiations] = useState<(BenchmarkInstantiationRecord | null)[]>([]);
  const [multiResults, setMultiResults] = useState<(BenchmarkResultRecord | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResultsHandoff, setShowResultsHandoff] = useState(false);

  useEffect(() => {
    Promise.all([listInferenceServers(), listModels(), listBenchmarkDocuments<BenchmarkTestTemplateDocument>('test_template')])
      .then(([serverData, modelData, templateData]) => {
        setServers(serverData);
        setModels(modelData);
        setTemplates(templateData.filter((entry) => entry.document.operation === 'chat_completion'));
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
  const showTemplateRibbon =
    onboarding?.status.active === true &&
    selectedTargets.length > 0 &&
    onboarding.status.step === 'template' &&
    !isRibbonDismissed(onboarding.uiState, 'model-selected');
  const subtitle = selectedTarget
    ? `${selectedTarget.model_id} · ${datasetMode === 'manifest_only' ? 'dataset run' : 'benchmark smoke'}`
    : `No model · ${datasetMode === 'manifest_only' ? 'dataset run' : 'benchmark smoke'}`;

  function clearRunState() {
    setInstantiation(null);
    setResult(null);
    setPlanId(null);
    setPlanResults([]);
    setInstantiations([]);
    setMultiResults([]);
    setShowResultsHandoff(false);
  }

  function addTarget(target: RunTarget) {
    clearRunState();
    setSelectedTargets((current) => {
      const key = targetKey(target);
      if (current.some((entry) => targetKey(entry) === key)) {
        return current;
      }
      return [...current, target].slice(0, 8);
    });
  }

  function removeTarget(target: RunTarget) {
    clearRunState();
    setSelectedTargets((current) => current.filter((entry) => targetKey(entry) !== targetKey(target)));
  }

  async function ensureStarterTemplate() {
    setStarterBusy(true);
    setError(null);
    try {
      const existing = await listBenchmarkDocuments<BenchmarkTestTemplateDocument>('test_template')
        .then((documents) => documents.find((record) => record.id === STARTER_BENCHMARK_TEMPLATE_ID || record.document.template_id === STARTER_BENCHMARK_TEMPLATE_ID))
        .catch(() => null);
      const document = existing?.document ?? starterBenchmarkTemplateDocument();
      let savedTemplate = existing ?? null;
      if (!existing) {
        savedTemplate = await saveBenchmarkDocument(document);
        window.dispatchEvent(new CustomEvent('templates:changed'));
      }
      setStarterTemplate(document);
      const readyTemplate = savedTemplate;
      if (readyTemplate) {
        setTemplates((current) => current.some((record) => record.id === readyTemplate.id) ? current : [readyTemplate, ...current]);
        setSelectedTemplateId(readyTemplate.id);
      }
      setDatasetMode('inline');
      setPrompt('Explain what this function does, identify one edge case, and describe the time complexity:\n\nfunction clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}');
      setSystemPrompt('You are a careful code reviewer. Be concise and specific.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to prepare starter template.');
      throw err;
    } finally {
      setStarterBusy(false);
    }
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
    clearRunState();
    try {
      const runSuffix = newRunId('run');
      const smokePayload = buildBenchmarkSmokePayload({
        target: selectedTarget,
        prompt: prompt.trim(),
        systemPrompt,
        inferenceParams,
        timeoutSec,
        seed
      });
      const preparedDataset = datasetMode === 'manifest_only'
        ? await prepareBenchmarkDatasetManifest({
            dataset_id: `run-dataset-${runSuffix}`,
            source: {
              source_type: 'file',
              format: datasetFormat,
              path: datasetPath.trim()
            },
            metadata: {
              source: 'run-page-dataset-path',
              requested_dataset_id: datasetId.trim()
            }
          })
        : await prepareBenchmarkDatasetManifest({
            dataset_id: `run-dataset-${runSuffix}`,
            source: {
              source_type: 'inline',
              format: 'json'
            },
            snapshot_policy: 'embedded',
            items: [
              {
                id: 'item-1',
                prompt: prompt.trim(),
                ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {})
              }
            ],
            metadata: { source: 'run-page-inline' }
          });

      const selectedTemplate = templates.find((entry) => entry.id === selectedTemplateId);
      let templateRef = selectedTemplate?.id ?? starterTemplate?.template_id ?? '';
      if (!templateRef) {
        const smokeTemplate = {
          ...smokePayload.template,
          template_id: `run-template-${runSuffix}`,
          metadata: {
            source: 'run-page-smoke'
          }
        };
        const savedTemplate = await saveBenchmarkDocument(smokeTemplate);
        templateRef = savedTemplate.id;
      }

      const runtimeProfile = {
        ...smokePayload.runtime_profile,
        profile_id: `run-runtime-${runSuffix}`,
        metadata: {
          source: 'run-page'
        }
      };
      const savedDataset = await saveBenchmarkDocument(preparedDataset);
      const savedRuntime = await saveBenchmarkDocument(runtimeProfile);
      const planDocument = buildPersistedBenchmarkPlanDocument({
        planId: `run-plan-${runSuffix}`,
        templateRef,
        datasetRef: savedDataset.id,
        runtimeProfileRef: savedRuntime.id,
        targets: selectedTargets,
        metadata: {
          source: 'run-page',
          selected_template_id: selectedTemplate?.id ?? null
        }
      });
      const savedPlan = await saveBenchmarkPlan(planDocument);
      setPlanId(savedPlan.id);
      const plan = await runPersistedBenchmarkPlan(savedPlan.id);
      setPlanResults(plan.run_results);

      const fetchedInstantiations = await Promise.all(
        plan.run_results.map((entry) =>
          entry.instantiation_id ? getBenchmarkInstantiation(entry.instantiation_id).catch(() => null) : Promise.resolve(null)
        )
      );
      const fetchedResults = await Promise.all(
        plan.run_results.map((entry) =>
          entry.run_id ? getBenchmarkResult(entry.run_id).catch(() => null) : Promise.resolve(null)
        )
      );
      setInstantiations(fetchedInstantiations);
      setMultiResults(fetchedResults);
      setInstantiation(fetchedInstantiations[0] ?? null);
      setResult(fetchedResults[0] ?? null);
      const firstResult = fetchedResults[0] ?? null;
      if (firstResult?.document.status === 'completed' && firstResult.document.errors.length === 0) {
        onFirstRunSuccess?.();
        setShowResultsHandoff(true);
      }
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
      {showTemplateRibbon && onboarding ? (
        <ProgressRibbon
          id="model-selected"
          step={2}
          doneLabel="model selected · run target pre-filled"
          fact={selectedOption?.display_name ?? selectedTarget?.model_id}
          nextLabel="Create starter template"
          onNext={() => void ensureStarterTemplate()}
          onDismiss={onboarding.dismissRibbon}
        />
      ) : null}
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
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            inferenceParams={inferenceParams}
            onboardingActive={onboarding?.status.active}
            starterTemplateReady={Boolean(starterTemplate)}
            starterBusy={starterBusy}
            onAddTarget={addTarget}
            onRemoveTarget={removeTarget}
            onCustomServerChange={setCustomServerId}
            onTimeoutChange={setTimeoutSec}
            onSeedChange={setSeed}
            onInferenceParamsChange={setInferenceParams}
            onPromptChange={setPrompt}
            onSystemPromptChange={setSystemPrompt}
            onDatasetModeChange={setDatasetMode}
            onDatasetIdChange={setDatasetId}
            onDatasetFormatChange={setDatasetFormat}
            onDatasetPathChange={setDatasetPath}
            onTemplateChange={setSelectedTemplateId}
            onRun={handleRun}
            onUseStarterTemplate={ensureStarterTemplate}
          />
          <main className="run-workspace">
            <header className="run-page-header">
              <div>
                <h1>Run</h1>
                <p>{subtitle}{selectedTargets.length > 1 && planResults.length > 0 ? ` · ${planResults.length} models` : result ? ` · ${result.document.status}` : busy ? ' · running' : ''}</p>
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
            ) : selectedTargets.length > 1 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {selectedTargets.map((target, index) => (
                  <div key={targetKey(target)} style={{ flex: '1 1 50%', minWidth: 0, borderRight: '1px solid var(--paper-7)', borderBottom: '1px solid var(--paper-7)', boxSizing: 'border-box' }}>
                    <BenchmarkDetail
                      target={target}
                      option={optionMap.get(targetKey(target))}
                      instantiation={instantiations[index] ?? null}
                      result={multiResults[index] ?? null}
                      planResult={planResultForTarget(planResults, target)}
                      planId={planId}
                      busy={busy}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <BenchmarkDetail
                target={selectedTarget}
                option={selectedOption}
                instantiation={instantiation}
                result={result}
                planResult={planResults[0] ?? null}
                planId={planId}
                busy={busy}
              />
            )}
          </main>
        </div>
      </section>
      {showResultsHandoff ? (
        <HandoffToast
          title="Benchmark complete"
          body="Your run finished successfully. Stay here to inspect the raw output, or open the results dashboard."
          primary="View results"
          secondary="Stay here"
          onPrimary={() => navigate('/results?tab=dashboard&onboarding=complete')}
          onSecondary={() => setShowResultsHandoff(false)}
          onDismiss={() => setShowResultsHandoff(false)}
        />
      ) : null}
    </>
  );
}
