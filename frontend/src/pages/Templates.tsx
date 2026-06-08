import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { TemplateEditor } from '../components/TemplateEditor.js';
import {
  TemplateInput,
  TemplateRecord,
  TemplateType,
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate
} from '../services/templates-api.js';

type TemplateMode = { kind: 'preview' } | { kind: 'create'; type: TemplateType } | { kind: 'edit' };

function parseTemplateStats(template: TemplateRecord): { stepCount: number; assertionCount: number; summary: string } {
  try {
    const parsed = JSON.parse(template.content) as Record<string, unknown>;
    const steps = Array.isArray(parsed.steps) ? parsed.steps.length : 0;
    const assertions = Array.isArray(parsed.assertions) ? parsed.assertions.length : 0;
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    return { stepCount: steps, assertionCount: assertions, summary: description || `${template.type.toUpperCase()} template` };
  } catch {
    return { stepCount: 0, assertionCount: 0, summary: `${template.type.toUpperCase()} template` };
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function Templates() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<TemplateMode>({ kind: 'preview' });
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | TemplateType>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId]
  );

  const filteredTemplates = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (typeFilter !== 'all' && template.type !== typeFilter) return false;
      if (!lower) return true;
      return [template.name, template.id, template.type].some((value) => value.toLowerCase().includes(lower));
    });
  }, [query, templates, typeFilter]);

  const loadTemplates = useCallback(async () => {
    const data = await listTemplates();
    setTemplates(data);
    setSelectedId((current) => current && data.some((template) => template.id === current) ? current : data[0]?.id ?? null);
  }, []);

  useEffect(() => {
    loadTemplates().catch(() => setTemplates([]));
  }, [loadTemplates]);

  async function handleSave(input: TemplateInput, isUpdate: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (isUpdate) {
        await updateTemplate(input.id, {
          name: input.name,
          type: input.type,
          content: input.content,
          version: input.version
        });
      } else {
        await createTemplate(input);
      }
      await loadTemplates();
      setSelectedId(input.id);
      setMode({ kind: 'preview' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save template');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(template: TemplateRecord) {
    const confirmed = window.confirm(`Delete template "${template.name}"?`);
    if (!confirmed) return;
    setError(null);
    setBusy(true);
    try {
      await deleteTemplate(template.id);
      await loadTemplates();
      if (selectedId === template.id) {
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete template');
    } finally {
      setBusy(false);
    }
  }

  function handleRailCreate() {
    setMode({ kind: 'create', type: typeFilter === 'python' ? 'python' : 'json' });
  }

  return (
    <>
      <MergedPageHeader title="Templates" subtitle="JSON and Python test definitions." />
      <section className="page templates-page templates-page--polish">
        {error ? <div className="error">{error}</div> : null}
        {templates.length === 0 && mode.kind === 'preview' ? (
          <EmptyState
            className="templates-empty"
            title="Your tests live here"
            body="Create one from a JSON schema or a Python script."
            actions={(
              <>
                <button type="button" onClick={() => setMode({ kind: 'create', type: 'json' })}>New JSON</button>
                <button type="button" className="btn btn--ghost" onClick={() => setMode({ kind: 'create', type: 'python' })}>New Python</button>
              </>
            )}
          />
        ) : (
          <div className="templates-layout">
            <aside className="templates-rail">
              <div className="templates-rail-tools">
                <div className="templates-rail-search">
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates" />
                  <button type="button" className="templates-rail-new" onClick={handleRailCreate} disabled={busy} aria-label={typeFilter === 'python' ? 'New Python' : 'New JSON'}>
                    + new
                  </button>
                </div>
                <div className="segmented-control" aria-label="Template type">
                  {(['all', 'json', 'python'] as const).map((value) => (
                    <button key={value} type="button" className={typeFilter === value ? 'is-active' : ''} onClick={() => setTypeFilter(value)}>
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
                      <span className={`template-kind template-kind--${template.type}`}>{template.type}</span>
                      <span>
                        <strong>{template.name}</strong>
                        <small>v{template.version} · {stats.stepCount} steps · {stats.assertionCount} asserts</small>
                      </span>
                    </button>
                  );
                })}
                {filteredTemplates.length === 0 ? <p className="muted">No templates match the current filters.</p> : null}
              </div>
            </aside>
            <main className="templates-preview">
              {mode.kind === 'create' ? (
                <TemplateEditor template={null} onSave={handleSave} error={error} busy={busy} initialType={mode.type} />
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
                  body="Choose a JSON or Python template from the list to preview its schema, invocation, and version details."
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
  template: TemplateRecord;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stats = parseTemplateStats(template);
  return (
    <article className="template-preview-panel">
      <header>
        <div>
          <span className={`template-kind template-kind--${template.type}`}>{template.type}</span>
          <h2>{template.name}</h2>
          <p>{stats.summary}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={onEdit}>Edit</button>
          <button type="button" className="btn btn--ghost" onClick={onDelete}>Delete</button>
        </div>
      </header>
      <div className="template-preview-grid">
        <div className="kv"><span>Template ID</span><strong>{template.id}</strong></div>
        <div className="kv"><span>Version</span><strong>{template.version}</strong></div>
        <div className="kv"><span>Updated</span><strong>{formatDate(template.updated_at)}</strong></div>
        <div className="kv"><span>Shape</span><strong>{stats.stepCount} steps · {stats.assertionCount} asserts</strong></div>
      </div>
      <section>
        <h3>Schema view</h3>
        <pre>{template.content}</pre>
      </section>
      <section>
        <h3>Example invocation</h3>
        <code>Run {'->'} {template.id}@{template.version}</code>
      </section>
    </article>
  );
}
