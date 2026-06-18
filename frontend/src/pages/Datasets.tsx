import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import {
  BenchmarkDatasetFileDocument,
  BenchmarkDatasetFileRecord,
  deleteBenchmarkDatasetFile,
  listBenchmarkDatasetFiles,
  readBenchmarkDatasetFile,
  saveBenchmarkDatasetFile
} from '../services/benchmark-api.js';

type DatasetMode = { kind: 'preview' } | { kind: 'create' } | { kind: 'modify' };
type DatasetItem = Record<string, unknown>;
type CopyField = 'prompt' | 'system_prompt' | 'interaction_mode' | 'expected_format' | 'tags';

const DEFAULT_ITEM: DatasetItem = {
  id: 'item-1',
  prompt: '',
  system_prompt: '',
  interaction_mode: 'chat',
  expected_format: 'free_text',
  tags: []
};

const COMPLEX_FIELDS = [
  'tools',
  'tool_choice',
  'expected_tool_calls',
  'expected_answer',
  'expected_schema',
  'evaluation',
  'metadata'
] as const;

const INTERACTION_MODES = ['chat', 'tool_calling', 'structured_output', 'multi_turn', 'agentic'];
const EXPECTED_FORMATS = ['free_text', 'json', 'markdown', 'code', 'boolean', 'number', 'schema', 'regex'];

function datasetIdFromPath(value: string): string {
  return value
    .replace(/\.jsonl$/i, '')
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'dataset';
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tagsText(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(', ') : '';
}

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeItemForDraft(item: DatasetItem, index: number): DatasetItem {
  return {
    ...item,
    id: textValue(item.id) || `item-${index + 1}`,
    prompt: textValue(item.prompt),
    system_prompt: item.system_prompt === null ? '' : textValue(item.system_prompt),
    interaction_mode: INTERACTION_MODES.includes(String(item.interaction_mode)) ? item.interaction_mode : 'chat',
    expected_format: EXPECTED_FORMATS.includes(String(item.expected_format)) ? item.expected_format : 'free_text',
    tags: Array.isArray(item.tags) ? item.tags.filter((entry) => typeof entry === 'string') : []
  };
}

function cleanItemForSave(item: DatasetItem): DatasetItem {
  const cleaned: DatasetItem = {
    id: textValue(item.id).trim(),
    prompt: textValue(item.prompt)
  };
  const systemPrompt = textValue(item.system_prompt).trim();
  if (systemPrompt) cleaned.system_prompt = systemPrompt;
  if (item.interaction_mode && item.interaction_mode !== 'chat') cleaned.interaction_mode = item.interaction_mode;
  if (item.expected_format && item.expected_format !== 'free_text') cleaned.expected_format = item.expected_format;
  if (Array.isArray(item.tags) && item.tags.length > 0) cleaned.tags = item.tags;
  for (const field of COMPLEX_FIELDS) {
    if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
      cleaned[field] = item[field];
    }
  }
  return cleaned;
}

function itemsToJsonl(items: DatasetItem[]): string {
  return items.map((item) => JSON.stringify(cleanItemForSave(item))).join('\n');
}

function parseJsonlDraft(value: string): DatasetItem[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => normalizeItemForDraft(JSON.parse(line) as DatasetItem, index));
}

function isEmptyField(value: unknown): boolean {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function fieldLabel(field: CopyField): string {
  return field.replace('_', ' ');
}

function DatasetsRail({
  datasets,
  selectedPath,
  query,
  mode,
  busy,
  onQuery,
  onSelect,
  onNew
}: {
  datasets: BenchmarkDatasetFileRecord[];
  selectedPath: string | null;
  query: string;
  mode: DatasetMode;
  busy: boolean;
  onQuery: (value: string) => void;
  onSelect: (path: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="datasets-rail templates-rail">
      <div className="templates-rail-tools">
        <div className="templates-rail-search">
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search datasets" />
          <button type="button" className="templates-rail-new" onClick={onNew} disabled={busy} aria-label="New dataset">
            + New
          </button>
        </div>
      </div>
      <div className="templates-list">
        {datasets.map((dataset) => (
          <button
            key={dataset.path}
            type="button"
            className={selectedPath === dataset.path && mode.kind === 'preview' ? 'template-row dataset-row is-selected' : 'template-row dataset-row'}
            onClick={() => onSelect(dataset.path)}
          >
            <span className="template-row__name">{dataset.dataset_id}</span>
            <span className="template-row__chip">{dataset.format}</span>
            <span className="template-row__description">
              {dataset.path} · {dataset.item_count ?? 'invalid'} items
            </span>
            {dataset.error ? <span className="dataset-row__error">{dataset.error}</span> : null}
          </button>
        ))}
        {datasets.length === 0 ? <p className="muted templates-list-empty">No datasets match.</p> : null}
      </div>
    </aside>
  );
}

function DatasetPreview({
  dataset,
  onModify,
  onDelete
}: {
  dataset: BenchmarkDatasetFileDocument;
  onModify: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="template-preview-panel dataset-preview-panel">
      <header>
        <div>
          <span className="template-kind template-kind--benchmark">dataset</span>
          <h2>{dataset.dataset_id}</h2>
          <p>{dataset.path}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={onModify}>Modify</button>
          <button type="button" className="btn btn--ghost" onClick={onDelete}>Delete</button>
        </div>
      </header>
      <div className="template-preview-grid">
        <div className="kv"><span>Items</span><strong>{dataset.item_count}</strong></div>
        <div className="kv"><span>Format</span><strong>{dataset.format}</strong></div>
        <div className="kv"><span>Updated</span><strong>{formatDate(dataset.updated_at)}</strong></div>
        <div className="kv"><span>Hash</span><strong title={dataset.dataset_hash}>{dataset.dataset_hash.slice(0, 19)}...</strong></div>
      </div>
      <div className="dataset-preview-table-wrap">
        <table className="dataset-table dataset-table--preview">
          <thead>
            <tr>
              <th>ID</th>
              <th>Prompt</th>
              <th>System</th>
              <th>Format</th>
            </tr>
          </thead>
          <tbody>
            {dataset.items.slice(0, 25).map((item, index) => (
              <tr key={`${item.id ?? index}`}>
                <td>{String(item.id ?? '')}</td>
                <td><span tabIndex={0} className="dataset-prompt-cell" title={textValue(item.prompt)}>{textValue(item.prompt)}</span></td>
                <td>{textValue(item.system_prompt)}</td>
                <td>{String(item.expected_format ?? 'free_text')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function DatasetEditor({
  initial,
  mode,
  busy,
  error,
  onCancel,
  onSave
}: {
  initial: BenchmarkDatasetFileDocument | null;
  mode: 'create' | 'modify';
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: { path: string; dataset_id: string; items: DatasetItem[] }) => Promise<void>;
}) {
  const [filePath, setFilePath] = useState(initial?.path ?? 'new-dataset.jsonl');
  const [datasetId, setDatasetId] = useState(initial?.dataset_id ?? 'new-dataset');
  const [items, setItems] = useState<DatasetItem[]>(() => (initial?.items ?? [DEFAULT_ITEM]).map(normalizeItemForDraft));
  const [rawJsonl, setRawJsonl] = useState(() => itemsToJsonl(initial?.items ?? [DEFAULT_ITEM]));
  const [jsonRowIndex, setJsonRowIndex] = useState<number | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const selectedJsonRow = jsonRowIndex === null ? null : items[jsonRowIndex] ?? null;

  function updateItem(index: number, patch: DatasetItem) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? normalizeItemForDraft({ ...item, ...patch }, itemIndex) : item));
  }

  function addRow() {
    setItems((current) => [...current, normalizeItemForDraft({ ...DEFAULT_ITEM, id: `item-${current.length + 1}` }, current.length)]);
  }

  function removeRow(index: number) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setJsonRowIndex((current) => current === null ? null : Math.max(0, Math.min(current, items.length - 2)));
  }

  function copyDown(index: number, field: CopyField) {
    const source = items[index]?.[field];
    const overwrite = window.confirm(`Copy ${fieldLabel(field)} to following rows?\n\nOK: overwrite existing values\nCancel: fill empty values only`);
    setItems((current) => current.map((item, itemIndex) => {
      if (itemIndex <= index) return item;
      if (!overwrite && !isEmptyField(item[field])) return item;
      return normalizeItemForDraft({ ...item, [field]: Array.isArray(source) ? [...source] : source }, itemIndex);
    }));
  }

  function applyRawJsonl() {
    setJsonError(null);
    try {
      setItems(parseJsonlDraft(rawJsonl));
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Unable to parse JSONL draft');
    }
  }

  function updateComplexField(field: string, value: string) {
    if (jsonRowIndex === null) return;
    setJsonError(null);
    try {
      updateItem(jsonRowIndex, { [field]: value.trim() ? JSON.parse(value) : undefined });
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : `Invalid JSON for ${field}`);
    }
  }

  return (
    <section className="dataset-editor-panel">
      <header className="dataset-editor-header">
        <div>
          <span className="template-kind template-kind--benchmark">{mode === 'create' ? 'new dataset' : 'edit dataset'}</span>
          <h2>{mode === 'create' ? 'New JSONL dataset' : datasetId}</h2>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave({ path: filePath, dataset_id: datasetId, items: items.map(cleanItemForSave) })}
          >
            {busy ? 'Saving...' : 'Save dataset'}
          </button>
        </div>
      </header>
      {error ? <div className="error templates-page-error">{error}</div> : null}
      {jsonError ? <div className="error templates-page-error">{jsonError}</div> : null}
      <div className="dataset-editor-fields">
        <label>
          File path
          <input disabled={mode === 'modify'} value={filePath} onChange={(event) => {
            const next = event.target.value;
            setFilePath(next);
            if (mode === 'create') setDatasetId(datasetIdFromPath(next));
          }} />
        </label>
        <label>
          Dataset ID
          <input value={datasetId} onChange={(event) => setDatasetId(event.target.value)} />
        </label>
      </div>
      <div className="dataset-table-toolbar">
        <button type="button" onClick={addRow}>Add row</button>
        <button type="button" className="btn btn--ghost" onClick={() => setRawJsonl(itemsToJsonl(items))}>Refresh raw JSONL</button>
      </div>
      <div className="dataset-table-wrap">
        <table className="dataset-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Prompt</th>
              <th>System prompt</th>
              <th>Mode</th>
              <th>Format</th>
              <th>Tags</th>
              <th>JSON</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={`${index}:${item.id}`}>
                <td><input value={textValue(item.id)} onChange={(event) => updateItem(index, { id: event.target.value })} /></td>
                <td>
                  <textarea
                    className="dataset-prompt-input"
                    rows={3}
                    title={textValue(item.prompt)}
                    value={textValue(item.prompt)}
                    onChange={(event) => updateItem(index, { prompt: event.target.value })}
                  />
                  <button type="button" className="dataset-copy-down" onClick={() => copyDown(index, 'prompt')}>copy down</button>
                </td>
                <td>
                  <textarea
                    rows={3}
                    title={textValue(item.system_prompt)}
                    value={textValue(item.system_prompt)}
                    onChange={(event) => updateItem(index, { system_prompt: event.target.value })}
                  />
                  <button type="button" className="dataset-copy-down" onClick={() => copyDown(index, 'system_prompt')}>copy down</button>
                </td>
                <td>
                  <select value={String(item.interaction_mode)} onChange={(event) => updateItem(index, { interaction_mode: event.target.value })}>
                    {INTERACTION_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <button type="button" className="dataset-copy-down" onClick={() => copyDown(index, 'interaction_mode')}>copy down</button>
                </td>
                <td>
                  <select value={String(item.expected_format)} onChange={(event) => updateItem(index, { expected_format: event.target.value })}>
                    {EXPECTED_FORMATS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <button type="button" className="dataset-copy-down" onClick={() => copyDown(index, 'expected_format')}>copy down</button>
                </td>
                <td>
                  <input value={tagsText(item.tags)} onChange={(event) => updateItem(index, { tags: parseTags(event.target.value) })} />
                  <button type="button" className="dataset-copy-down" onClick={() => copyDown(index, 'tags')}>copy down</button>
                </td>
                <td><button type="button" className="btn btn--ghost" onClick={() => setJsonRowIndex(index)}>JSON</button></td>
                <td><button type="button" className="btn btn--ghost" onClick={() => removeRow(index)} disabled={items.length <= 1}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="dataset-raw-jsonl">
        <summary>Raw JSONL</summary>
        <textarea value={rawJsonl} onChange={(event) => setRawJsonl(event.target.value)} />
        <button type="button" onClick={applyRawJsonl}>Update draft from JSONL</button>
      </details>
      {selectedJsonRow ? (
        <aside className="dataset-json-drawer">
          <header>
            <strong>Row JSON · {textValue(selectedJsonRow.id)}</strong>
            <button type="button" onClick={() => setJsonRowIndex(null)}>Close</button>
          </header>
          {COMPLEX_FIELDS.map((field) => (
            <label key={field}>
              {field}
              <textarea
                value={selectedJsonRow[field] === undefined ? '' : JSON.stringify(selectedJsonRow[field], null, 2)}
                onChange={(event) => updateComplexField(field, event.target.value)}
              />
            </label>
          ))}
        </aside>
      ) : null}
    </section>
  );
}

export function Datasets() {
  const [datasets, setDatasets] = useState<BenchmarkDatasetFileRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<BenchmarkDatasetFileDocument | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<DatasetMode>({ kind: 'preview' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredDatasets = useMemo(() => {
    const lower = query.trim().toLowerCase();
    if (!lower) return datasets;
    return datasets.filter((dataset) => [dataset.path, dataset.dataset_id].some((value) => value.toLowerCase().includes(lower)));
  }, [datasets, query]);

  const loadDatasets = useCallback(async () => {
    const records = await listBenchmarkDatasetFiles();
    setDatasets(records);
    setSelectedPath((current) => current && records.some((dataset) => dataset.path === current) ? current : records[0]?.path ?? null);
  }, []);

  useEffect(() => {
    loadDatasets().catch((err) => {
      setDatasets([]);
      setError(err instanceof Error ? err.message : 'Unable to load datasets');
    });
  }, [loadDatasets]);

  useEffect(() => {
    if (!selectedPath || mode.kind !== 'preview') {
      setSelectedDataset(null);
      return;
    }
    let active = true;
    readBenchmarkDatasetFile(selectedPath)
      .then((dataset) => {
        if (active) {
          setSelectedDataset(dataset);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to read dataset');
      });
    return () => {
      active = false;
    };
  }, [mode.kind, selectedPath]);

  async function handleSave(input: { path: string; dataset_id: string; items: DatasetItem[] }) {
    setError(null);
    setBusy(true);
    try {
      const saved = await saveBenchmarkDatasetFile(input);
      await loadDatasets();
      setSelectedPath(saved.path);
      setSelectedDataset(saved);
      setMode({ kind: 'preview' });
      window.dispatchEvent(new CustomEvent('datasets:changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save dataset');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(dataset: BenchmarkDatasetFileDocument) {
    const confirmed = window.confirm(`Delete dataset "${dataset.dataset_id}" and its JSONL file?`);
    if (!confirmed) return;
    setError(null);
    setBusy(true);
    try {
      await deleteBenchmarkDatasetFile(dataset.path);
      await loadDatasets();
      setSelectedDataset(null);
      window.dispatchEvent(new CustomEvent('datasets:changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete dataset');
    } finally {
      setBusy(false);
    }
  }

  const subtitle = mode.kind === 'create'
    ? 'Datasets / New / JSONL item file.'
    : mode.kind === 'modify' && selectedDataset
      ? `Datasets / ${selectedDataset.dataset_id} / Modify`
      : 'JSONL dataset item files with synced dataset_manifest documents.';

  return (
    <>
      <MergedPageHeader title="Datasets" subtitle={subtitle} />
      <section className="page templates-page datasets-page">
        {datasets.length === 0 && mode.kind === 'preview' ? (
          <>
            {error ? <div className="error templates-page-error">{error}</div> : null}
            <EmptyState
              className="templates-empty"
              title="Your dataset item files live here"
              body="Create a JSONL dataset under the configured dataset root."
              actions={<button type="button" onClick={() => setMode({ kind: 'create' })}>New dataset</button>}
            />
          </>
        ) : (
          <div className="templates-layout">
            <DatasetsRail
              datasets={filteredDatasets}
              selectedPath={selectedPath}
              query={query}
              mode={mode}
              busy={busy}
              onQuery={setQuery}
              onSelect={(path) => {
                setSelectedPath(path);
                setMode({ kind: 'preview' });
                setError(null);
              }}
              onNew={() => {
                setMode({ kind: 'create' });
                setError(null);
              }}
            />
            <main className="templates-main">
              {mode.kind === 'create' ? (
                <DatasetEditor mode="create" initial={null} busy={busy} error={error} onCancel={() => setMode({ kind: 'preview' })} onSave={handleSave} />
              ) : mode.kind === 'modify' && selectedDataset ? (
                <DatasetEditor mode="modify" initial={selectedDataset} busy={busy} error={error} onCancel={() => setMode({ kind: 'preview' })} onSave={handleSave} />
              ) : selectedDataset ? (
                <>
                  {error ? <div className="error templates-page-error">{error}</div> : null}
                  <DatasetPreview dataset={selectedDataset} onModify={() => setMode({ kind: 'modify' })} onDelete={() => handleDelete(selectedDataset)} />
                </>
              ) : (
                <EmptyState title="Select a dataset" body="Choose a JSONL dataset file from the list to preview and edit its benchmark items." />
              )}
            </main>
          </div>
        )}
      </section>
    </>
  );
}
