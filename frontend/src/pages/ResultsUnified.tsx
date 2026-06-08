import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { ResultsGraphPanel } from '../components/results-graph-panel.js';
import { ResultsPerformanceComparisonPanel } from '../components/results-performance-comparison-panel.js';
import { normalizeResultsTab } from '../navigation.js';
import { getLeaderboard, type LeaderboardEntry } from '../services/leaderboard-api.js';
import {
  deleteRun,
  getResultsEvaluationDetail,
  getResultsRunDetail,
  queryResultsView,
  type ResultsEvaluationDetail,
  type ResultsFilterOptions,
  type ResultsFilterState,
  type ResultsHistoryRow,
  type ResultsRunDetail,
  type ResultsStatus,
  type ResultsTab
} from '../services/results-view-api.js';
import type { DashboardPanel } from '../services/dashboard-results-api.js';
import { toLocalInputValue } from './ResultsDashboard.js';
import '../styles/dashboard-results.css';

type LeaderboardSort = 'score' | 'latency' | 'cost' | 'pass_rate';
type LeaderboardGroup = 'model' | 'server' | 'quantization';
type ResultsFunnelStageKey = 'servers' | 'models' | 'tests';
type ResultsFunnelCollapsedState = Record<ResultsFunnelStageKey, boolean>;

const STATUS_OPTIONS: ResultsStatus[] = ['pass', 'fail', 'partial', 'streaming'];
const RESULTS_FUNNEL_COLLAPSED_STORAGE_KEY = 'results.funnelCollapsedStages';
const DEFAULT_RESULTS_FUNNEL_COLLAPSED: ResultsFunnelCollapsedState = {
  servers: false,
  models: false,
  tests: false
};

function readResultsFunnelCollapsed(): ResultsFunnelCollapsedState {
  if (typeof window === 'undefined') {
    return DEFAULT_RESULTS_FUNNEL_COLLAPSED;
  }
  try {
    const raw = window.localStorage.getItem(RESULTS_FUNNEL_COLLAPSED_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_RESULTS_FUNNEL_COLLAPSED;
    }
    const parsed = JSON.parse(raw) as Partial<ResultsFunnelCollapsedState>;
    return {
      servers: Boolean(parsed.servers),
      models: Boolean(parsed.models),
      tests: Boolean(parsed.tests)
    };
  } catch {
    return DEFAULT_RESULTS_FUNNEL_COLLAPSED;
  }
}

function defaultRange(): { date_from: string; date_to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { date_from: from.toISOString(), date_to: to.toISOString() };
}

function toIsoFromLocal(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function csvList(params: URLSearchParams, key: string): string[] {
  const value = params.get(key);
  return value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

function numberParam(params: URLSearchParams, key: string): number | null {
  const value = params.get(key);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeFilters(params: URLSearchParams): ResultsFilterState {
  const range = defaultRange();
  const statuses = csvList(params, 'status').filter((status): status is ResultsStatus =>
    STATUS_OPTIONS.includes(status as ResultsStatus)
  );
  const sortBy = params.get('sort_by');
  const sortDir = params.get('sort_dir');
  return {
    date_from: params.get('date_from') ?? range.date_from,
    date_to: params.get('date_to') ?? range.date_to,
    server_ids: csvList(params, 'server'),
    model_names: csvList(params, 'model'),
    template_ids: csvList(params, 'template'),
    statuses,
    tags: csvList(params, 'tag'),
    score_min: numberParam(params, 'score_min'),
    score_max: numberParam(params, 'score_max'),
    sort_by:
      sortBy === 'status' || sortBy === 'model' || sortBy === 'server' || sortBy === 'template' || sortBy === 'score' || sortBy === 'latency' || sortBy === 'cost'
        ? sortBy
        : 'started_at',
    sort_dir: sortDir === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, Number(params.get('page') ?? '1') || 1),
    page_size: 50
  };
}

function writeFilters(params: URLSearchParams, filters: ResultsFilterState): URLSearchParams {
  const next = new URLSearchParams(params);
  const setCsv = (key: string, values: string[]) => {
    if (values.length > 0) {
      next.set(key, values.join(','));
    } else {
      next.delete(key);
    }
  };
  if (filters.date_from) next.set('date_from', filters.date_from);
  if (filters.date_to) next.set('date_to', filters.date_to);
  setCsv('server', filters.server_ids);
  setCsv('model', filters.model_names);
  setCsv('template', filters.template_ids);
  setCsv('status', filters.statuses);
  setCsv('tag', filters.tags);
  if (filters.score_min != null) next.set('score_min', String(filters.score_min)); else next.delete('score_min');
  if (filters.score_max != null) next.set('score_max', String(filters.score_max)); else next.delete('score_max');
  next.set('sort_by', filters.sort_by);
  next.set('sort_dir', filters.sort_dir);
  next.set('page', String(filters.page));
  return next;
}

function formatNumber(value: number | null, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) {
    return 'N/A';
  }
  return `${Number(value.toFixed(value >= 100 ? 0 : 2)).toLocaleString()}${suffix}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function hasNarrowingFilters(filters: ResultsFilterState): boolean {
  return (
    filters.server_ids.length > 0 ||
    filters.model_names.length > 0 ||
    filters.template_ids.length > 0 ||
    filters.statuses.length > 0 ||
    filters.tags.length > 0 ||
    filters.score_min !== null ||
    filters.score_max !== null
  );
}

function optionMatchesSelected(selected: string[], optionValues?: string[]): boolean {
  return selected.length === 0 || !optionValues?.length || optionValues.some((value) => selected.includes(value));
}

function modelsForServers(options: ResultsFilterOptions | null, serverIds: string[]) {
  return (options?.models ?? []).filter((option) => optionMatchesSelected(serverIds, option.server_ids));
}

function templatesForFunnel(options: ResultsFilterOptions | null, serverIds: string[], modelNames: string[]) {
  return (options?.templates ?? []).filter((option) => (
    optionMatchesSelected(serverIds, option.server_ids) &&
    optionMatchesSelected(modelNames, option.model_names)
  ));
}

function seriesPanel(title: string, metric: string, series: Array<{ label: string; points: Array<{ x: string; y: number | null }> }>): DashboardPanel {
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

function ResultsFilterRail({
  filters,
  options,
  loading,
  onChange,
  onReset
}: {
  filters: ResultsFilterState;
  options: ResultsFilterOptions | null;
  loading: boolean;
  onChange: (next: ResultsFilterState) => void;
  onReset: () => void;
}) {
  const dateFrom = filters.date_from ? toLocalInputValue(filters.date_from) : '';
  const dateTo = filters.date_to ? toLocalInputValue(filters.date_to, 'to') : '';
  const disabled = loading && !options;
  const visibleModels = modelsForServers(options, filters.server_ids);
  const visibleTemplates = templatesForFunnel(options, filters.server_ids, filters.model_names);
  const [collapsed, setCollapsed] = useState<ResultsFunnelCollapsedState>(readResultsFunnelCollapsed);
  const showModelsStage = filters.server_ids.length > 0;
  const showTestsStage = filters.model_names.length > 0;
  const collapsedClass = [
    collapsed.servers ? 'results-rail--servers-collapsed' : '',
    showModelsStage ? 'results-rail--has-models' : '',
    showModelsStage && collapsed.models ? 'results-rail--models-collapsed' : '',
    showTestsStage ? 'results-rail--has-tests' : '',
    showTestsStage && collapsed.tests ? 'results-rail--tests-collapsed' : ''
  ].filter(Boolean).join(' ');
  const selectedServerTiles = selectedOptionTiles(options?.servers ?? [], filters.server_ids);
  const selectedModelTiles = selectedOptionTiles(visibleModels, filters.model_names);
  const selectedTestTiles = selectedResultsTestTiles(options, visibleTemplates, filters);
  const activeTestFilterCount =
    filters.template_ids.length +
    filters.statuses.length +
    filters.tags.length +
    (filters.score_min != null || filters.score_max != null ? 1 : 0);

  useEffect(() => {
    window.localStorage.setItem(RESULTS_FUNNEL_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
  }, [collapsed]);

  function setStageCollapsed(stage: ResultsFunnelStageKey, value: boolean) {
    setCollapsed((current) => ({ ...current, [stage]: value }));
  }

  function validTemplateIds(serverIds: string[], modelNames: string[]) {
    return new Set(templatesForFunnel(options, serverIds, modelNames).map((option) => option.id));
  }

  function handleServerToggle(id: string) {
    const serverIds = toggleValue(filters.server_ids, id);
    const validModels = serverIds.length ? new Set(modelsForServers(options, serverIds).map((option) => option.id)) : new Set<string>();
    const modelNames = serverIds.length ? filters.model_names.filter((model) => validModels.has(model)) : [];
    const templates = modelNames.length ? validTemplateIds(serverIds, modelNames) : new Set<string>();
    onChange({
      ...filters,
      server_ids: serverIds,
      model_names: modelNames,
      template_ids: filters.template_ids.filter((template) => templates.has(template)),
      page: 1
    });
  }

  function handleModelToggle(id: string) {
    const modelNames = toggleValue(filters.model_names, id);
    const templates = modelNames.length ? validTemplateIds(filters.server_ids, modelNames) : new Set<string>();
    onChange({
      ...filters,
      model_names: modelNames,
      template_ids: filters.template_ids.filter((template) => templates.has(template)),
      page: 1
    });
  }

  function clearServers() {
    onChange({ ...filters, server_ids: [], model_names: [], template_ids: [], page: 1 });
  }

  function clearModels() {
    onChange({ ...filters, model_names: [], template_ids: [], page: 1 });
  }

  function clearTestFilters() {
    onChange({
      ...filters,
      template_ids: [],
      statuses: [],
      tags: [],
      score_min: null,
      score_max: null,
      page: 1
    });
  }

  return (
    <aside className={`results-rail ${collapsedClass}`} aria-label="Results filters">
      {collapsed.servers ? (
        <CollapsedFunnelStage
          title="Servers"
          countLabel={filters.server_ids.length ? `${filters.server_ids.length} selected` : 'All'}
          tiles={selectedServerTiles}
          onExpand={() => setStageCollapsed('servers', false)}
        />
      ) : (
        <FunnelStage
          title="Servers"
          step="1"
          selectedCount={filters.server_ids.length}
          options={options?.servers ?? []}
          selected={filters.server_ids}
          onToggle={handleServerToggle}
          onCollapse={() => setStageCollapsed('servers', true)}
          onClear={filters.server_ids.length ? clearServers : undefined}
          optionMeta={(option) => ['results source', `${option.count} runs`]}
        />
      )}
      {showModelsStage ? (
        collapsed.models ? (
          <CollapsedFunnelStage
            title="Models"
            countLabel={filters.model_names.length ? `${filters.model_names.length} selected` : 'All'}
            tiles={selectedModelTiles}
            onExpand={() => setStageCollapsed('models', false)}
          />
        ) : (
          <FunnelStage
            title="Models"
            step="2"
            selectedCount={filters.model_names.length}
            options={visibleModels}
            selected={filters.model_names}
            onToggle={handleModelToggle}
            onCollapse={() => setStageCollapsed('models', true)}
            onClear={filters.model_names.length ? clearModels : undefined}
            optionMeta={(option) => ['model', `${option.count} runs`]}
          />
        )
      ) : null}
      {showTestsStage ? (
        collapsed.tests ? (
          <CollapsedFunnelStage
            title="Tests & range"
            countLabel={activeTestFilterCount ? `${activeTestFilterCount} active` : 'All'}
            tiles={selectedTestTiles.length ? selectedTestTiles : ['All']}
            onExpand={() => setStageCollapsed('tests', false)}
          />
        ) : (
          <TestsRangeStage
            dateFrom={dateFrom}
            dateTo={dateTo}
            disabled={disabled}
            filters={filters}
            options={options}
            visibleTemplates={visibleTemplates}
            onChange={onChange}
            onReset={onReset}
            onCollapse={() => setStageCollapsed('tests', true)}
            onClear={activeTestFilterCount ? clearTestFilters : undefined}
          />
        )
      ) : null}
    </aside>
  );
}

function selectedOptionTiles(options: Array<{ id: string; label: string }>, selected: string[]) {
  if (selected.length === 0) {
    return ['All'];
  }
  return selected.slice(0, 4).map((id) => options.find((option) => option.id === id)?.label ?? id);
}

function selectedResultsTestTiles(
  options: ResultsFilterOptions | null,
  templates: Array<{ id: string; label: string }>,
  filters: ResultsFilterState
) {
  const tiles = [
    ...filters.template_ids.map((id) => templates.find((option) => option.id === id)?.label ?? id),
    ...filters.statuses.map((id) => options?.statuses.find((option) => option.id === id)?.label ?? id),
    ...filters.tags.map((id) => options?.tags.find((option) => option.id === id)?.label ?? id)
  ];
  if (filters.score_min != null || filters.score_max != null) {
    tiles.push('Score');
  }
  return tiles.slice(0, 4);
}

function CollapsedFunnelStage({
  title,
  countLabel,
  tiles,
  onExpand
}: {
  title: string;
  countLabel: string;
  tiles: string[];
  onExpand: () => void;
}) {
  return (
    <div className="results-funnel-stage results-funnel-stage--collapsed" aria-label={`${title} collapsed`}>
      <button type="button" className="catalog-stage-expand" aria-label={`Expand ${title} filters`} onClick={onExpand}>›</button>
      <div className="catalog-vertical-label">{title} · {countLabel}</div>
      <div className="catalog-server-tiles" aria-label={`${title} selected filters`}>
        {tiles.map((tile) => (
          <button key={tile} type="button" title={tile} onClick={onExpand}>
            {tile.slice(0, 2).toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function FunnelStage({
  title,
  step,
  selectedCount,
  options,
  selected,
  onToggle,
  onCollapse,
  onClear,
  optionMeta
}: {
  title: string;
  step: string;
  selectedCount: number;
  options: Array<{ id: string; label: string; count: number; kind?: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  onCollapse: () => void;
  onClear?: () => void;
  optionMeta: (option: { id: string; label: string; count: number; kind?: string }) => string[];
}) {
  return (
    <div className="results-funnel-stage">
      {step ? <div className="catalog-stage-number">{step}</div> : null}
      <div className="catalog-rail-header">
        <div>
          <strong>{title}</strong>
          <span>{selectedCount} selected</span>
        </div>
        {onClear ? <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>Clear</button> : null}
      </div>
      <button type="button" className="btn btn--ghost btn--sm results-stage-collapse" aria-label={`Collapse ${title} filters`} onClick={onCollapse}>Collapse</button>
      <div className="results-stage-picker">
        {options.length === 0 ? <p className="muted">No options</p> : null}
        {options.slice(0, 12).map((option) => (
          <label key={option.id} className={`server-filter-row results-filter-row ${selected.includes(option.id) ? 'is-selected' : ''}`}>
            <input type="checkbox" checked={selected.includes(option.id)} onChange={() => onToggle(option.id)} />
            <span>
              <strong>{option.label}</strong>
              {optionMeta(option).map((line) => <small key={line}>{line}</small>)}
            </span>
            <b>{option.count}</b>
          </label>
        ))}
      </div>
    </div>
  );
}

function TestsRangeStage({
  dateFrom,
  dateTo,
  disabled,
  filters,
  options,
  visibleTemplates,
  onChange,
  onReset,
  onCollapse,
  onClear
}: {
  dateFrom: string;
  dateTo: string;
  disabled: boolean;
  filters: ResultsFilterState;
  options: ResultsFilterOptions | null;
  visibleTemplates: Array<{ id: string; label: string; count: number; kind?: string }>;
  onChange: (next: ResultsFilterState) => void;
  onReset: () => void;
  onCollapse: () => void;
  onClear?: () => void;
}) {
  const selectedCount =
    filters.template_ids.length +
    filters.statuses.length +
    filters.tags.length +
    (filters.score_min != null || filters.score_max != null ? 1 : 0);
  return (
    <div className="results-funnel-stage results-funnel-stage--tests">
      <div className="catalog-stage-number">3</div>
      <div className="catalog-rail-header">
        <div>
          <strong>Tests & range</strong>
          <span>{selectedCount} selected</span>
        </div>
        {onClear ? <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>Clear</button> : null}
      </div>
      <button type="button" className="btn btn--ghost btn--sm results-stage-collapse" aria-label="Collapse Tests & range filters" onClick={onCollapse}>Collapse</button>
      <div className="results-rail__group">
        <h3>Range</h3>
        <div className="results-range-buttons">
          {[1, 7, 30].map((days) => (
            <button
              key={days}
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                const to = new Date();
                const from = new Date(to);
                from.setDate(from.getDate() - days);
                onChange({ ...filters, date_from: from.toISOString(), date_to: to.toISOString(), page: 1 });
              }}
            >
              {days === 1 ? '24h' : `${days}d`}
            </button>
          ))}
        </div>
        <label>
          From
          <input
            type="datetime-local"
            value={dateFrom}
            disabled={disabled}
            onChange={(event) => onChange({ ...filters, date_from: toIsoFromLocal(event.target.value), page: 1 })}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={dateTo}
            disabled={disabled}
            onChange={(event) => onChange({ ...filters, date_to: toIsoFromLocal(event.target.value), page: 1 })}
          />
        </label>
      </div>

      <FilterCheckGroup
        title="Tests"
        options={visibleTemplates}
        selected={filters.template_ids}
        onToggle={(id) => onChange({ ...filters, template_ids: toggleValue(filters.template_ids, id), page: 1 })}
      />
      <FilterCheckGroup
        title="Status"
        options={(options?.statuses ?? STATUS_OPTIONS.map((id) => ({ id, label: id, count: 0 })))}
        selected={filters.statuses}
        onToggle={(id) => onChange({ ...filters, statuses: toggleValue(filters.statuses, id) as ResultsStatus[], page: 1 })}
      />

      <div className="results-rail__group">
        <h3>Score range</h3>
        <label>
          Min
          <input
            type="number"
            min="0"
            max="100"
            value={filters.score_min ?? ''}
            onChange={(event) => onChange({ ...filters, score_min: event.target.value ? Number(event.target.value) : null, page: 1 })}
          />
        </label>
        <label>
          Max
          <input
            type="number"
            min="0"
            max="100"
            value={filters.score_max ?? ''}
            onChange={(event) => onChange({ ...filters, score_max: event.target.value ? Number(event.target.value) : null, page: 1 })}
          />
        </label>
      </div>

      <div className="results-rail__group">
        <h3>Iteration tag</h3>
        <input
          value={filters.tags.join(', ')}
          placeholder="perf-bench-q3"
          onChange={(event) => onChange({ ...filters, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean), page: 1 })}
        />
        {options?.tags.length ? (
          <div className="results-tag-list">
            {options.tags.slice(0, 8).map((tag) => (
              <button key={tag.id} type="button" className="btn btn--ghost btn--sm" onClick={() => onChange({ ...filters, tags: toggleValue(filters.tags, tag.id), page: 1 })}>
                {tag.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <button type="button" className="btn btn--ghost btn--sm results-reset" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}

function FilterCheckGroup({
  title,
  options,
  selected,
  onToggle
}: {
  title: string;
  options: Array<{ id: string; label: string; count: number; kind?: string }>;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="results-rail__group">
      <h3>{title}</h3>
      <div className="results-stage-picker">
        {options.length === 0 ? <p className="muted">No options</p> : null}
        {options.slice(0, 12).map((option) => (
          <label key={option.id} className={`server-filter-row results-filter-row ${selected.includes(option.id) ? 'is-selected' : ''}`}>
            <input type="checkbox" checked={selected.includes(option.id)} onChange={() => onToggle(option.id)} />
            <span>
              <strong>{option.label}</strong>
              <small>{option.kind ? `${option.kind} · ` : ''}{option.count} runs</small>
            </span>
            <b>{option.count}</b>
          </label>
        ))}
      </div>
    </div>
  );
}

function DashboardTab({ rows, dashboard, onOpenRun }: { rows: ResultsHistoryRow[]; dashboard: Awaited<ReturnType<typeof queryResultsView>>['dashboard']; onOpenRun: (id: string) => void }) {
  const cards = dashboard.scorecards;
  const hasPerformanceComparison = (dashboard.performance_comparison?.groups.length ?? 0) > 0;
  return (
    <div className="results-main-stack">
      <div className="results-scorecards">
        <div className="results-scorecard"><span>Total runs</span><strong>{cards.total_runs}</strong></div>
        <div className="results-scorecard"><span>Pass rate</span><strong>{formatNumber(cards.pass_rate, '%')}</strong></div>
        <div className="results-scorecard"><span>Median latency</span><strong>{formatNumber(cards.median_latency_ms, ' ms')}</strong></div>
        <div className="results-scorecard"><span>Median cost</span><strong>{cards.median_cost == null ? 'N/A' : `$${cards.median_cost.toFixed(6)}`}</strong></div>
      </div>
      {hasPerformanceComparison ? (
        <ResultsPerformanceComparisonPanel comparison={dashboard.performance_comparison} />
      ) : (
        <>
          <ResultsGraphPanel panel={seriesPanel('Pass-rate over time', 'pass_rate', dashboard.pass_rate_series)} />
          <ResultsGraphPanel panel={seriesPanel('Latency distribution', 'latency_ms', dashboard.latency_series)} />
        </>
      )}
      <section className="results-panel">
        <header className="results-panel__header">
          <h2>Recent runs</h2>
          <span>{rows.length} visible</span>
        </header>
        <div className="results-mini-list">
          {dashboard.recent_runs.length === 0 ? <p className="muted">No runs match the current filters.</p> : null}
          {dashboard.recent_runs.map((run) => (
            <button key={run.run_id} type="button" className="results-run-row" onClick={() => onOpenRun(run.run_id)}>
              <StatusPill status={run.status} />
              <span>{run.template_label}</span>
              <strong>{run.model_name}</strong>
              <small>{formatDate(run.started_at)}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardEmptyState({ onExpandRange, onGoToRun }: { onExpandRange: () => void; onGoToRun: () => void }) {
  return (
    <section className="results-dashboard-empty">
      <div className="results-dashboard-empty__copy">
        <h2>Results dashboard</h2>
        <p>Range: <strong>selected range</strong> · 0 runs</p>
      </div>
      <div className="results-empty-card">
        <div className="results-empty-icon" aria-hidden="true">|||</div>
        <h3>No runs in the selected range</h3>
        <p>The dashboard charts metrics from completed runs. Expand the range, or start a new run to see data here.</p>
        <div className="actions">
          <button type="button" onClick={onExpandRange}>Expand to last 90 days</button>
          <button type="button" className="btn btn--ghost" onClick={onGoToRun}>Go to Run page</button>
        </div>
      </div>
    </section>
  );
}

function LeaderboardTab({
  entries,
  loading,
  sort,
  group,
  onSort,
  onGroup,
  onOpenEvaluation
}: {
  entries: LeaderboardEntry[];
  loading: boolean;
  sort: LeaderboardSort;
  group: LeaderboardGroup;
  onSort: (sort: LeaderboardSort) => void;
  onGroup: (group: LeaderboardGroup) => void;
  onOpenEvaluation: (id: string) => void;
}) {
  return (
    <div className="results-main-stack">
      <div className="results-toolbar">
        <label>
          Sort by
          <select value={sort} onChange={(event) => onSort(event.target.value as LeaderboardSort)}>
            <option value="score">Score</option>
            <option value="latency">Latency p50</option>
            <option value="cost">Cost</option>
            <option value="pass_rate">Pass rate</option>
          </select>
        </label>
        <label>
          Group by
          <select value={group} onChange={(event) => onGroup(event.target.value as LeaderboardGroup)}>
            <option value="model">Model</option>
            <option value="server">Server</option>
            <option value="quantization">Quantization</option>
          </select>
        </label>
      </div>
      <div className="results-leader-list">
        {loading ? <p className="muted">Loading leaderboard...</p> : null}
        {!loading && entries.length === 0 ? <p className="muted">No evaluations match the selected filters.</p> : null}
        {entries.map((entry) => (
          <button
            key={`${entry.group_by}:${entry.group_key}`}
            type="button"
            className="results-leader-row"
            onClick={() => entry.representative_evaluation_id && onOpenEvaluation(entry.representative_evaluation_id)}
          >
            <span className="results-rank">{entry.rank}</span>
            <span className="results-leader-row__main">
              <strong>{entry.group_label}</strong>
              <small>{entry.server_name ?? entry.server_id ?? 'server'} · {entry.quantization_level ?? 'quant unknown'} · {entry.evaluation_count} evals</small>
            </span>
            <MetricStrip label="Score" value={entry.score_percent} suffix="%" />
            <MetricStrip label="Latency" value={entry.avg_latency_ms} suffix=" ms" inverse />
            <MetricStrip label="Cost" value={entry.avg_estimated_cost} prefix="$" inverse />
          </button>
        ))}
      </div>
    </div>
  );
}

function MetricStrip({ label, value, suffix = '', prefix = '', inverse = false }: { label: string; value: number | null; suffix?: string; prefix?: string; inverse?: boolean }) {
  const normalized = value == null ? 0 : inverse ? Math.max(0, 100 - Math.min(100, value)) : Math.min(100, value);
  return (
    <span className="results-metric-strip">
      <small>{label}</small>
      <strong>{value == null ? 'N/A' : `${prefix}${Number(value.toFixed(value >= 100 ? 0 : 2))}${suffix}`}</strong>
      <i style={{ width: `${normalized}%` }} />
    </span>
  );
}

function HistoryTab({
  rows,
  page,
  totalPages,
  sortBy,
  sortDir,
  onSort,
  onPage,
  onOpenRun
}: {
  rows: ResultsHistoryRow[];
  page: number;
  totalPages: number;
  sortBy: ResultsFilterState['sort_by'];
  sortDir: ResultsFilterState['sort_dir'];
  onSort: (sort: ResultsFilterState['sort_by']) => void;
  onPage: (page: number) => void;
  onOpenRun: (id: string) => void;
}) {
  const heading = (label: string, key: ResultsFilterState['sort_by']) => (
    <button type="button" className="table-sort-button" onClick={() => onSort(key)}>
      {label}{sortBy === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
  return (
    <section className="results-panel">
      <div className="results-history-table-wrap">
        <table className="results-history-table">
          <thead>
            <tr>
              <th>{heading('Status', 'status')}</th>
              <th>{heading('Started', 'started_at')}</th>
              <th>{heading('Model · server', 'model')}</th>
              <th>{heading('Template', 'template')}</th>
              <th>{heading('Score', 'score')}</th>
              <th>{heading('Latency', 'latency')}</th>
              <th>{heading('Cost', 'cost')}</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty-state-cell">No runs match the current filters.</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.run_id} onClick={() => onOpenRun(row.run_id)}>
                  <td><StatusPill status={row.status} /></td>
                  <td>{formatDate(row.started_at)}</td>
                  <td><strong>{row.model_name}</strong><br /><small>{row.server_name}</small></td>
                  <td>{row.template_label}</td>
                  <td>{formatNumber(row.score, '%')}</td>
                  <td>{formatNumber(row.latency_ms, ' ms')}</td>
                  <td>{row.cost == null ? 'N/A' : `$${row.cost.toFixed(6)}`}</td>
                  <td>{row.tags.join(', ') || 'N/A'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="results-pagination">
        <button type="button" className="ghost-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span>Page {page} / {totalPages}</span>
        <button type="button" className="ghost-button" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: ResultsStatus }) {
  return <span className={`results-status results-status--${status}`}>{status}</span>;
}

function DetailDrawer({
  runDetail,
  evaluationDetail,
  loading,
  deletingRun,
  deleteRunError,
  onClose,
  onDeleteRun
}: {
  runDetail: ResultsRunDetail | null;
  evaluationDetail: ResultsEvaluationDetail | null;
  loading: boolean;
  deletingRun: boolean;
  deleteRunError: string | null;
  onClose: () => void;
  onDeleteRun: () => void;
}) {
  return (
    <div className="results-drawer-backdrop" role="presentation" onClick={() => {
      if (!deletingRun) {
        onClose();
      }
    }}>
      <aside className="results-drawer" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="results-drawer__header">
          <div className="results-drawer__actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={deletingRun}>Close</button>
            {runDetail ? (
              <button type="button" className="btn btn--danger" onClick={onDeleteRun} disabled={deletingRun || loading}>
                {deletingRun ? 'Deleting...' : 'Delete run'}
              </button>
            ) : null}
          </div>
          <div>
            <h2>{runDetail ? runDetail.run.run_id : evaluationDetail ? evaluationDetail.evaluation.id : 'Detail'}</h2>
            <p>{runDetail ? 'Run detail' : 'Evaluation detail'}</p>
          </div>
        </header>
        {loading ? <p className="muted">Loading detail...</p> : null}
        {deletingRun ? <p className="muted">Deleting run...</p> : null}
        {deleteRunError ? <div className="error" role="alert">{deleteRunError}</div> : null}
        {runDetail ? <RunDetailBody detail={runDetail} /> : null}
        {evaluationDetail ? <EvaluationDetailBody detail={evaluationDetail} /> : null}
      </aside>
    </div>
  );
}

function RunDetailBody({ detail }: { detail: ResultsRunDetail }) {
  return (
    <div className="results-drawer__body">
      <section className="results-kv">
        <div><span>Status</span><strong>{detail.run.status}</strong></div>
        <div><span>Server</span><strong>{detail.run.server_name}</strong></div>
        <div><span>Model</span><strong>{detail.run.model_name}</strong></div>
        <div><span>Template</span><strong>{detail.run.template_label}</strong></div>
        <div><span>Started</span><strong>{formatDate(detail.run.started_at)}</strong></div>
        <div><span>Duration</span><strong>{formatNumber(detail.run.duration_ms, ' ms')}</strong></div>
      </section>
      <section>
        <h3>Results</h3>
        {detail.results.map((result) => (
          <div key={String(result.id)} className="results-detail-block">
            <strong>{String(result.template_label ?? result.test_id)}</strong>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </div>
        ))}
      </section>
      <section>
        <h3>Raw envelope</h3>
        <pre>{JSON.stringify(detail.documents, null, 2)}</pre>
      </section>
    </div>
  );
}

function EvaluationDetailBody({ detail }: { detail: ResultsEvaluationDetail }) {
  return (
    <div className="results-drawer__body">
      <section className="results-kv">
        <div><span>Model</span><strong>{detail.evaluation.model_name}</strong></div>
        <div><span>Server</span><strong>{detail.server?.display_name ?? detail.evaluation.server_id}</strong></div>
        <div><span>Score</span><strong>{formatNumber(detail.composite_score * 20, '%')}</strong></div>
        <div><span>Latency</span><strong>{formatNumber(detail.evaluation.latency_ms, ' ms')}</strong></div>
        <div><span>Tokens</span><strong>{formatNumber(detail.evaluation.total_tokens)}</strong></div>
        <div><span>Cost</span><strong>{detail.evaluation.estimated_cost == null ? 'N/A' : `$${detail.evaluation.estimated_cost.toFixed(6)}`}</strong></div>
      </section>
      <section>
        <h3>Prompt</h3>
        <p>{detail.prompt?.text ?? 'N/A'}</p>
      </section>
      <section>
        <h3>Answer</h3>
        <pre>{detail.evaluation.answer_text}</pre>
      </section>
      <section>
        <h3>Scores</h3>
        <pre>{JSON.stringify({
          accuracy: detail.evaluation.accuracy_score,
          relevance: detail.evaluation.relevance_score,
          coherence: detail.evaluation.coherence_score,
          completeness: detail.evaluation.completeness_score,
          helpfulness: detail.evaluation.helpfulness_score,
          note: detail.evaluation.note
        }, null, 2)}</pre>
      </section>
    </div>
  );
}

export function ResultsUnified({ runCount }: { runCount: number | null }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeResultsTab(searchParams.get('tab')) as ResultsTab;
  const filters = useMemo(() => decodeFilters(searchParams), [searchParams]);
  const [data, setData] = useState<Awaited<ReturnType<typeof queryResultsView>> | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [resultsRefreshToken, setResultsRefreshToken] = useState(0);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardRefreshToken, setLeaderboardRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [leaderSort, setLeaderSort] = useState<LeaderboardSort>((searchParams.get('leader_sort') as LeaderboardSort) || 'score');
  const [leaderGroup, setLeaderGroup] = useState<LeaderboardGroup>((searchParams.get('group_by') as LeaderboardGroup) || 'model');
  const [runDetail, setRunDetail] = useState<ResultsRunDetail | null>(null);
  const [evaluationDetail, setEvaluationDetail] = useState<ResultsEvaluationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingRun, setDeletingRun] = useState(false);
  const [deleteRunError, setDeleteRunError] = useState<string | null>(null);
  const hasExplicitDateTo = searchParams.has('date_to');

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (next.get('tab') !== activeTab) {
      next.set('tab', activeTab);
      setSearchParams(next, { replace: true });
    }
  }, [activeTab, searchParams, setSearchParams]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    queryResultsView(filters)
      .then((response) => {
        if (active) setData(response);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load results');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, resultsRefreshToken]);

  useEffect(() => {
    if (activeTab !== 'leaderboard') {
      return;
    }
    let active = true;
    setLeaderboardLoading(true);
    getLeaderboard({
      date_from: filters.date_from,
      date_to: hasExplicitDateTo ? filters.date_to : new Date().toISOString(),
      tags: filters.tags,
      server_ids: filters.server_ids,
      model_names: filters.model_names,
      score_min: filters.score_min,
      score_max: filters.score_max,
      sort_by: leaderSort,
      group_by: leaderGroup
    })
      .then((response) => {
        if (active) setLeaderboard(response.entries);
      })
      .catch(() => {
        if (active) setLeaderboard([]);
      })
      .finally(() => {
        if (active) setLeaderboardLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeTab, filters, hasExplicitDateTo, leaderGroup, leaderSort, leaderboardRefreshToken]);

  useEffect(() => {
    const refreshLeaderboard = () => setLeaderboardRefreshToken((current) => current + 1);
    const clearLeaderboard = () => {
      setLeaderboard([]);
      refreshLeaderboard();
    };
    window.addEventListener('evaluations:saved', refreshLeaderboard);
    window.addEventListener('database:cleared', clearLeaderboard);
    return () => {
      window.removeEventListener('evaluations:saved', refreshLeaderboard);
      window.removeEventListener('database:cleared', clearLeaderboard);
    };
  }, []);

  useEffect(() => {
    const runId = searchParams.get('run');
    const evaluationId = searchParams.get('evaluation');
    if (!runId && !evaluationId) {
      setRunDetail(null);
      setEvaluationDetail(null);
      setDeleteRunError(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDeleteRunError(null);
    setRunDetail(null);
    setEvaluationDetail(null);
    const request = runId ? getResultsRunDetail(runId).then((detail) => ({ run: detail })) : getResultsEvaluationDetail(evaluationId as string).then((detail) => ({ evaluation: detail }));
    request
      .then((detail) => {
        if (!active) return;
        if ('run' in detail) setRunDetail(detail.run);
        if ('evaluation' in detail) setEvaluationDetail(detail.evaluation);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [searchParams]);

  function updateFilters(nextFilters: ResultsFilterState) {
    setSearchParams(writeFilters(searchParams, nextFilters));
  }

  function updateTab(tab: string) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    next.delete('run');
    next.delete('evaluation');
    setSearchParams(next);
  }

  function resetFilters() {
    const next = new URLSearchParams();
    next.set('tab', activeTab);
    setSearchParams(writeFilters(next, { ...decodeFilters(next), page: 1 }));
  }

  function openRun(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set('run', id);
    next.delete('evaluation');
    setSearchParams(next);
  }

  function openEvaluation(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set('evaluation', id);
    next.delete('run');
    setSearchParams(next);
  }

  function closeDrawer() {
    if (deletingRun) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('run');
    next.delete('evaluation');
    setSearchParams(next);
  }

  async function handleDeleteRun() {
    if (!runDetail || deletingRun) {
      return;
    }
    const confirmed = window.confirm(`Delete run ${runDetail.run.run_id} and its results? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    setDeletingRun(true);
    setDeleteRunError(null);
    try {
      await deleteRun(runDetail.run.run_id);
      const next = new URLSearchParams(searchParams);
      next.delete('run');
      next.delete('evaluation');
      setSearchParams(next);
      setRunDetail(null);
      setResultsRefreshToken((current) => current + 1);
      window.dispatchEvent(new CustomEvent('runs:changed'));
    } catch (err) {
      setDeleteRunError(err instanceof Error ? err.message : 'Unable to delete run');
    } finally {
      setDeletingRun(false);
    }
  }

  function exportView() {
    const payload = JSON.stringify({ filters, data, leaderboard }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `inferharness-results-${activeTab}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function shareView() {
    void navigator.clipboard?.writeText(window.location.href);
  }

  function expandRange(days: number) {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - days);
    updateFilters({ ...filters, date_from: from.toISOString(), date_to: to.toISOString(), page: 1 });
  }

  const showDashboardEmpty = Boolean(
    data &&
    activeTab === 'dashboard' &&
    data.dashboard.scorecards.total_runs === 0 &&
    !hasNarrowingFilters(filters)
  );
  const subtitle = `${data?.history.total ?? runCount ?? 0} runs · ${data?.filter_options.models.length ?? 0} models · selected range`;
  return (
    <>
      <MergedPageHeader
        title="Results"
        subtitle={subtitle}
        tabs={[
          { id: 'dashboard', label: 'Dashboard', sub: String(data?.dashboard.scorecards.total_runs ?? runCount ?? 0) },
          { id: 'leaderboard', label: 'Leaderboard' },
          { id: 'history', label: 'History' }
        ]}
        activeTab={activeTab}
        onTabChange={updateTab}
        action={
          <div className="results-header-actions">
            <button type="button" className="ghost-button" onClick={exportView}>Export</button>
            <button type="button" className="ghost-button" onClick={shareView}>Share view</button>
          </div>
        }
      />
      <section className={`results-page ${showDashboardEmpty ? 'results-page--empty' : ''}`}>
        {!showDashboardEmpty ? (
          <ResultsFilterRail
            filters={filters}
            options={data?.filter_options ?? null}
            loading={loading}
            onChange={updateFilters}
            onReset={resetFilters}
          />
        ) : null}
        <main className="results-main">
          {error ? <div className="error">{error}</div> : null}
          {loading && !data ? <p className="muted">Loading results...</p> : null}
          {showDashboardEmpty ? (
            <DashboardEmptyState onExpandRange={() => expandRange(90)} onGoToRun={() => navigate('/run')} />
          ) : data && activeTab === 'dashboard' ? (
            <DashboardTab rows={data.history.rows} dashboard={data.dashboard} onOpenRun={openRun} />
          ) : null}
          {data && activeTab === 'leaderboard' ? (
            <LeaderboardTab
              entries={leaderboard}
              loading={leaderboardLoading}
              sort={leaderSort}
              group={leaderGroup}
              onSort={(sort) => {
                setLeaderSort(sort);
                const next = new URLSearchParams(searchParams);
                next.set('leader_sort', sort);
                setSearchParams(next);
              }}
              onGroup={(group) => {
                setLeaderGroup(group);
                const next = new URLSearchParams(searchParams);
                next.set('group_by', group);
                setSearchParams(next);
              }}
              onOpenEvaluation={openEvaluation}
            />
          ) : null}
          {data && activeTab === 'history' ? (
            <HistoryTab
              rows={data.history.rows}
              page={data.history.page}
              totalPages={data.history.total_pages}
              sortBy={filters.sort_by}
              sortDir={filters.sort_dir}
              onSort={(sort) => updateFilters({ ...filters, sort_by: sort, sort_dir: filters.sort_by === sort && filters.sort_dir === 'asc' ? 'desc' : 'asc', page: 1 })}
              onPage={(page) => updateFilters({ ...filters, page })}
              onOpenRun={openRun}
            />
          ) : null}
        </main>
      </section>
      {runDetail || evaluationDetail || detailLoading ? (
        <DetailDrawer
          runDetail={runDetail}
          evaluationDetail={evaluationDetail}
          loading={detailLoading}
          deletingRun={deletingRun}
          deleteRunError={deleteRunError}
          onClose={closeDrawer}
          onDeleteRun={handleDeleteRun}
        />
      ) : null}
    </>
  );
}
