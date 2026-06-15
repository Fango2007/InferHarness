import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { TemplateEditor } from '../components/TemplateEditor.js';
import {
  BenchmarkOperation,
  TemplateAgentMessage,
  BenchmarkTestTemplateDocument,
  BenchmarkTestTemplateRecord,
  deleteBenchmarkDocument,
  listBenchmarkDocuments,
  runTemplateAgent,
  saveBenchmarkDocument
} from '../services/benchmark-api.js';
import { getAppSettings, type AppSettings } from '../services/system-api.js';
import { listModels, type ModelRecord } from '../services/models-api.js';

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
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentDraft, setAgentDraft] = useState<BenchmarkTestTemplateDocument | null>(null);

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
      setAgentDraft(null);
      window.dispatchEvent(new CustomEvent('templates:changed'));
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
      window.dispatchEvent(new CustomEvent('templates:changed'));
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
              <>
                <button type="button" onClick={() => {
                  setAgentDraft(null);
                  setMode({ kind: 'create' });
                }}>New benchmark template</button>
                <button type="button" className="btn btn--ghost" onClick={() => setAgentOpen(true)}>Agent</button>
              </>
            )}
          />
        ) : (
          <div className="templates-layout">
            <aside className="templates-rail">
              <div className="templates-rail-tools">
                <div className="templates-rail-search">
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates" />
                  <button type="button" className="templates-rail-new" onClick={() => {
                    setAgentDraft(null);
                    setMode({ kind: 'create' });
                  }} disabled={busy} aria-label="New benchmark template">
                    + new
                  </button>
                </div>
                <button type="button" className="btn btn--ghost templates-agent-button" onClick={() => setAgentOpen(true)} disabled={busy}>
                  Agent
                </button>
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
                        setAgentDraft(null);
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
                <TemplateEditor template={null} initialDocument={agentDraft} onSave={handleSave} error={error} busy={busy} />
              ) : mode.kind === 'edit' && selectedTemplate ? (
                <TemplateEditor template={selectedTemplate} initialDocument={agentDraft} onSave={handleSave} error={error} busy={busy} />
              ) : selectedTemplate ? (
                <TemplatePreview
                  template={selectedTemplate}
                  onEdit={() => {
                    setAgentDraft(null);
                    setMode({ kind: 'edit' });
                  }}
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
      {agentOpen ? (
        <TemplateAgentModal
          selectedTemplate={selectedTemplate}
          onClose={() => setAgentOpen(false)}
          onApply={(template) => {
            setAgentDraft(template);
            setMode(selectedTemplate ? { kind: 'edit' } : { kind: 'create' });
            setAgentOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function modelKey(record: ModelRecord) {
  return `${record.model.server_id}::${record.model.model_id}`;
}

function modelLabel(record: ModelRecord) {
  return record.model.display_name || record.model.model_id;
}

function TemplateAgentModal({
  selectedTemplate,
  onClose,
  onApply
}: {
  selectedTemplate: BenchmarkTestTemplateRecord | null;
  onClose: () => void;
  onApply: (template: BenchmarkTestTemplateDocument) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>({ template_agent_model: null });
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [message, setMessage] = useState('');
  const [conversation, setConversation] = useState<TemplateAgentMessage[]>([]);
  const [draft, setDraft] = useState<BenchmarkTestTemplateDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([getAppSettings(), listModels()])
      .then(([settingsResult, modelsResult]) => {
        if (!active) return;
        if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value);
        if (modelsResult.status === 'fulfilled') setModels(modelsResult.value);
      })
      .catch(() => {
        if (active) setError('Unable to load template agent settings.');
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedModelKey = settings.template_agent_model
    ? `${settings.template_agent_model.server_id}::${settings.template_agent_model.model_id}`
    : '';
  const selectedModel = models.find((record) => modelKey(record) === selectedModelKey) ?? null;
  const canSend = Boolean(settings.template_agent_model) && message.trim().length > 0 && !busy;
  const mode = selectedTemplate ? 'modify' : 'create';

  async function sendMessage() {
    if (!canSend) return;
    const userMessage: TemplateAgentMessage = { role: 'user', content: message.trim() };
    const nextConversation = [...conversation, userMessage];
    setConversation(nextConversation);
    setMessage('');
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const response = await runTemplateAgent({
        mode,
        message: userMessage.content,
        conversation,
        existing_template: selectedTemplate?.document
      });
      const assistantMessage: TemplateAgentMessage = {
        role: 'assistant',
        content: response.status === 'needs_input' && response.questions?.length
          ? `${response.reply}\n\n${response.questions.map((question) => `- ${question}`).join('\n')}`
          : response.reply
      };
      setConversation([...nextConversation, assistantMessage]);
      if (response.status === 'draft_ready') {
        setDraft(response.template);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Template agent failed');
      setConversation(nextConversation);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay template-agent-overlay" role="dialog" aria-modal="true" aria-labelledby="template-agent-title">
      <div className="modal-card template-agent-modal">
        <header className="modal-header">
          <div>
            <span className="template-kind template-kind--benchmark">benchmark agent</span>
            <h2 id="template-agent-title">{selectedTemplate ? 'Modify template' : 'Create template'}</h2>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
        </header>

        <div className="template-agent-engine">
          <span>Engine</span>
          <strong>{selectedModel ? `${modelLabel(selectedModel)} (${selectedModel.model.server_id})` : settings.template_agent_model ? selectedModelKey : 'No model configured'}</strong>
        </div>
        {!settings.template_agent_model ? (
          <div className="error">Configure a template agent model in Settings before using the agent.</div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="template-agent-chat" aria-live="polite">
          {conversation.length === 0 ? (
            <p className="muted">Describe the benchmark template you want. The agent will ask for missing details before drafting a runnable chat_completion template.</p>
          ) : null}
          {conversation.map((entry, index) => (
            <section className={`template-agent-message is-${entry.role}`} key={`${entry.role}-${index}`}>
              <span>{entry.role}</span>
              <pre>{entry.content}</pre>
            </section>
          ))}
          {busy ? (
            <section className="template-agent-message is-assistant">
              <span>assistant</span>
              <pre>Thinking...</pre>
            </section>
          ) : null}
        </div>

        {draft ? (
          <section className="template-agent-draft">
            <div>
              <strong>Validated draft</strong>
              <span>{draft.name ?? draft.template_id} · {draft.operation}</span>
            </div>
            <pre>{JSON.stringify(draft, null, 2)}</pre>
            <button type="button" onClick={() => onApply(draft)}>Apply to editor</button>
          </section>
        ) : null}

        <footer className="template-agent-composer">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={4}
            placeholder={selectedTemplate ? 'Describe how this template should change.' : 'Describe the benchmark template to create.'}
          />
          <button type="button" onClick={sendMessage} disabled={!canSend}>
            {busy ? 'Sending...' : 'Send'}
          </button>
        </footer>
      </div>
    </div>
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
