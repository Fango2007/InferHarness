import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { TemplateEditor } from '../components/TemplateEditor.js';
import {
  BenchmarkOperation,
  BenchmarkTestTemplateDocument,
  BenchmarkTestTemplateRecord,
  deleteBenchmarkDocument,
  listBenchmarkDocuments,
  saveBenchmarkDocument
} from '../services/benchmark-api.js';

type TemplateMode = { kind: 'preview' } | { kind: 'create' } | { kind: 'edit' };
type TemplateOperationFilter = 'all' | BenchmarkOperation;

function parseTemplateStats(template: BenchmarkTestTemplateRecord): {
  stageCount: number;
  metricCount: number;
  aggregationCount: number;
  summary: string;
} {
  const document = template.document;
  return {
    stageCount: document.stages.length,
    metricCount: document.metrics.length,
    aggregationCount: document.aggregations.length,
    summary: document.description || `${document.operation} benchmark template`
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function Templates() {
  const [templates, setTemplates] = useState<BenchmarkTestTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<TemplateMode>({ kind: 'preview' });
  const [query, setQuery] = useState('');
  const [operationFilter, setOperationFilter] = useState<TemplateOperationFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId]
  );

  const filteredTemplates = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (operationFilter !== 'all' && template.document.operation !== operationFilter) return false;
      if (!lower) return true;
      return [
        template.document.name ?? '',
        template.document.template_id,
        template.document.operation,
        template.document.description ?? ''
      ].some((value) => value.toLowerCase().includes(lower));
    });
  }, [operationFilter, query, templates]);

  const loadTemplates = useCallback(async () => {
    const data = await listBenchmarkDocuments<BenchmarkTestTemplateDocument>('test_template');
    setTemplates(data);
    setSelectedId((current) => current && data.some((template) => template.id === current) ? current : data[0]?.id ?? null);
  }, []);

  useEffect(() => {
    loadTemplates().catch(() => setTemplates([]));
  }, [loadTemplates]);

  async function handleSave(input: BenchmarkTestTemplateDocument, _isUpdate = false) {
    setError(null);
    setBusy(true);
    try {
      await saveBenchmarkDocument(input);
      await loadTemplates();
      setSelectedId(input.template_id);
      setMode({ kind: 'preview' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save benchmark template');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(template: BenchmarkTestTemplateRecord) {
    const name = template.document.name ?? template.document.template_id;
    const confirmed = window.confirm(`Delete benchmark template "${name}"?`);
    if (!confirmed) return;
    setError(null);
    setBusy(true);
    try {
      await deleteBenchmarkDocument('test_template', template.id);
      await loadTemplates();
      if (selectedId === template.id) {
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete benchmark template');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MergedPageHeader title="Templates" subtitle="Benchmark test_template documents." />
      <section className="page templates-page templates-page--polish">
        {error ? <div className="error">{error}</div> : null}
        {templates.length === 0 && mode.kind === 'preview' ? (
          <EmptyState
            className="templates-empty"
            title="Your benchmark templates live here"
            body="Create a reusable test_template document for benchmark runs."
            actions={(
              <button type="button" onClick={() => setMode({ kind: 'create' })}>New benchmark template</button>
            )}
          />
        ) : (
          <div className="templates-layout">
            <aside className="templates-rail">
              <div className="templates-rail-tools">
                <div className="templates-rail-search">
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates" />
                  <button type="button" className="templates-rail-new" onClick={() => setMode({ kind: 'create' })} disabled={busy} aria-label="New benchmark template">
                    + new
                  </button>
                </div>
                <div className="segmented-control segmented-control--operations" aria-label="Template operation">
                  {(['all', 'chat_completion', 'completion', 'embedding', 'list_models', 'healthcheck'] as const).map((value) => (
                    <button key={value} type="button" className={operationFilter === value ? 'is-active' : ''} onClick={() => setOperationFilter(value)}>
                      {value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="templates-list">
                {filteredTemplates.map((template) => {
                  const stats = parseTemplateStats(template);
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={selectedId === template.id && mode.kind !== 'create' ? 'template-row is-selected' : 'template-row'}
                      onClick={() => {
                        setSelectedId(template.id);
                        setMode({ kind: 'preview' });
                      }}
                    >
                      <span className="template-kind template-kind--benchmark">{template.document.operation}</span>
                      <span>
                        <strong>{template.document.name ?? template.document.template_id}</strong>
                        <small>v{template.document.template_version} · {stats.stageCount} stages · {stats.metricCount} metrics</small>
                      </span>
                    </button>
                  );
                })}
                {filteredTemplates.length === 0 ? <p className="muted">No templates match the current filters.</p> : null}
              </div>
            </aside>
            <main className="templates-preview">
              {mode.kind === 'create' ? (
                <TemplateEditor template={null} onSave={handleSave} error={error} busy={busy} />
              ) : mode.kind === 'edit' && selectedTemplate ? (
                <TemplateEditor template={selectedTemplate} onSave={handleSave} error={error} busy={busy} />
              ) : selectedTemplate ? (
                <TemplatePreview
                  template={selectedTemplate}
                  onEdit={() => setMode({ kind: 'edit' })}
                  onDelete={() => handleDelete(selectedTemplate)}
                />
              ) : (
                <EmptyState
                  title="Select a template"
                  body="Choose a benchmark test_template from the list to preview its schema, metrics, and version details."
                />
              )}
            </main>
          </div>
        )}
      </section>
    </>
  );
}

function TemplatePreview({
  template,
  onEdit,
  onDelete
}: {
  template: BenchmarkTestTemplateRecord;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stats = parseTemplateStats(template);
  const document = template.document;
  return (
    <article className="template-preview-panel">
      <header>
        <div>
          <span className="template-kind template-kind--benchmark">benchmark</span>
          <h2>{document.name ?? document.template_id}</h2>
          <p>{stats.summary}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={onEdit}>Edit</button>
          <button type="button" className="btn btn--ghost" onClick={onDelete}>Delete</button>
        </div>
      </header>
      <div className="template-preview-grid">
        <div className="kv"><span>Template ID</span><strong>{document.template_id}</strong></div>
        <div className="kv"><span>Version</span><strong>{document.template_version}</strong></div>
        <div className="kv"><span>Operation</span><strong>{document.operation}</strong></div>
        <div className="kv"><span>Updated</span><strong>{formatDate(template.updated_at)}</strong></div>
        <div className="kv"><span>Stages</span><strong>{stats.stageCount}</strong></div>
        <div className="kv"><span>Metrics</span><strong>{stats.metricCount}</strong></div>
        <div className="kv"><span>Aggregations</span><strong>{stats.aggregationCount}</strong></div>
      </div>
      <section>
        <h3>Benchmark document</h3>
        <pre>{JSON.stringify(document, null, 2)}</pre>
      </section>
      <section>
        <h3>Template contract</h3>
        <code>{document.template_id}@{document.template_version} · {document.operation}</code>
      </section>
    </article>
  );
}
