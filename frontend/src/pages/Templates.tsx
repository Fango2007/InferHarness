import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { TOOL_CALL_ASSERTION_METRIC } from '../services/benchmark-metric-metadata.js';
import { listModels, type ModelRecord } from '../services/models-api.js';
import { getAppSettings, type AppSettings } from '../services/system-api.js';

type TemplateMode = { kind: 'grid' } | { kind: 'preview' } | { kind: 'create' } | { kind: 'modify' };
type TemplateOperationFilter = 'all' | BenchmarkOperation;
type TemplateCategory = 'all' | 'tool' | 'agentic' | 'structured';
type AuthorTab = 'live' | 'advanced' | 'raw';
type DraftSource = 'none' | 'seed' | 'agent' | 'advanced' | 'raw';

interface JsonLine {
  text: string;
  note?: string;
  isNew?: boolean;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  questions?: string[];
}

interface TemplateCategoryDefinition {
  id: TemplateCategory;
  name: string;
  blurb: string;
}

const OPERATION_FILTERS: TemplateOperationFilter[] = ['all', 'chat_completion', 'completion', 'embedding', 'list_models', 'healthcheck'];
const ENABLED_OPERATION_FILTERS = new Set<TemplateOperationFilter>(['all', 'chat_completion']);
const TEMPLATE_CATEGORIES: TemplateCategoryDefinition[] = [
  { id: 'all', name: 'All templates', blurb: 'Every benchmark in the workspace' },
  { id: 'tool', name: 'Tool calling', blurb: 'Selection, arguments, and tool-choice mechanics' },
  { id: 'agentic', name: 'Agentic', blurb: 'Multi-step agents, repo edits, and workflow execution' },
  { id: 'structured', name: 'Structured output', blurb: 'JSON contracts and schema validation' }
];

const DEFAULT_TEMPLATE_DRAFT: BenchmarkTestTemplateDocument = {
  kind: 'test_template',
  schema_version: 'benchmark_test_template_v1',
  template_id: 'template-id',
  template_version: '1.0.0',
  name: 'Template name',
  description: 'Reusable benchmark test template.',
  operation: 'chat_completion',
  required_capabilities: {
    chat_completion: true,
    streaming: false,
    tool_calling: false,
    structured_output: false
  },
  input_contract: {
    required_fields: ['prompt'],
    optional_fields: ['system_prompt'],
    min_items: 1
  },
  stages: [
    {
      id: 'chat',
      type: 'dataset_loop',
      iterations_per_item: 1,
      record_metrics: true,
      order: 'sequential',
      cooldown_ms: 0,
      stop_on_error: false
    }
  ],
  metrics: ['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms', 'first_token_ms', 'tokens_per_second'],
  aggregations: ['mean', 'p95', 'count'],
  metadata: {
    source: 'templates-page'
  }
};

function parseTemplateStats(template: BenchmarkTestTemplateRecord): {
  stageCount: number;
  metricCount: number;
  aggregationCount: number;
  capabilityCount: number;
  summary: string;
} {
  const document = template.document;
  const capabilities = document.required_capabilities ?? {};
  return {
    stageCount: document.stages.length,
    metricCount: document.metrics.length,
    aggregationCount: document.aggregations.length,
    capabilityCount: Object.values(capabilities).filter(Boolean).length,
    summary: document.description || `${document.operation} benchmark template`
  };
}

function categorizeTemplateDocument(document: BenchmarkTestTemplateDocument): Exclude<TemplateCategory, 'all'> {
  const id = document.template_id.toLowerCase();
  if (id.startsWith('agent-')) {
    return 'agentic';
  }
  if (id.startsWith('functional-')) {
    return 'structured';
  }
  if (document.required_capabilities?.structured_output && !document.required_capabilities?.tool_calling) {
    return 'structured';
  }
  if (document.required_capabilities?.tool_calling) {
    return 'tool';
  }
  return 'tool';
}

function categoryName(category: TemplateCategory): string {
  return TEMPLATE_CATEGORIES.find((entry) => entry.id === category)?.name ?? 'Templates';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function templateLabel(template: BenchmarkTestTemplateRecord): string {
  return template.document.name ?? template.document.template_id;
}

function modelKey(record: ModelRecord) {
  return `${record.model.server_id}::${record.model.model_id}`;
}

function modelLabel(record: ModelRecord) {
  return record.model.display_name || record.model.model_id;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonLines(value: unknown, baseline?: unknown): JsonLine[] {
  const text = stringifyJson(value);
  const baselineLines = baseline ? new Set(stringifyJson(baseline).split('\n').map((line) => line.trim())) : null;
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    const changed = Boolean(baselineLines && !baselineLines.has(trimmed));
    return {
      text: line,
      ...(changed ? { isNew: true, note: 'changed by this draft' } : {})
    };
  });
}

function skeletonFromMessage(message: string): BenchmarkTestTemplateDocument {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'new-template';
  return {
    ...DEFAULT_TEMPLATE_DRAFT,
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: `${slug}-v1`,
    template_version: '1.0.0',
    name: 'New benchmark template',
    description: message || 'Reusable benchmark test template.',
    operation: 'chat_completion'
  };
}

function highlightJsonLine(line: string): Array<{ className: string; text: string }> {
  const tokens: Array<{ className: string; text: string }> = [];
  const push = (className: string, text: string) => {
    if (text) tokens.push({ className, text });
  };
  const whitespace = line.match(/^\s*/)?.[0] ?? '';
  push('tp', whitespace);
  let rest = line.slice(whitespace.length);
  const keyMatch = rest.match(/^"([^"]*)"(\s*):/);
  if (keyMatch) {
    push('tk', `"${keyMatch[1]}"`);
    push('tp', `${keyMatch[2]}:`);
    rest = rest.slice(keyMatch[0].length);
  }

  const tokenPattern = /"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?|[{}[\],]|\s+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(rest)) !== null) {
    if (match.index > last) push('ts', rest.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('"')) push('ts', token);
    else if (token === 'true' || token === 'false' || token === 'null') push('tb', token);
    else if (/^-?\d/.test(token)) push('tn', token);
    else push('tp', token);
    last = match.index + token.length;
  }
  if (last < rest.length) push('ts', rest.slice(last));
  return tokens;
}

function JsonView({ lines, showNotes }: { lines: JsonLine[]; showNotes: boolean }) {
  return (
    <pre className="template-json-code">
      {lines.map((line, index) => (
        <span key={`${index}:${line.text}`} className={['template-json-line', line.note && showNotes ? 'has-note' : '', line.isNew ? 'is-new' : ''].filter(Boolean).join(' ')}>
          {highlightJsonLine(line.text).map((token, tokenIndex) => (
            <span key={tokenIndex} className={token.className}>{token.text}</span>
          ))}
          {line.note && showNotes ? <span className="template-json-note">{line.note}</span> : null}
        </span>
      ))}
    </pre>
  );
}

function TemplateCategoryRail({
  category,
  counts,
  onCategory
}: {
  category: TemplateCategory;
  counts: Record<TemplateCategory, number>;
  onCategory: (value: TemplateCategory) => void;
}) {
  return (
    <aside className="template-category-rail">
      <div className="template-category-rail__top">
        <div className="template-category-rail__label">Browse by</div>
        <nav className="template-category-rail__list" aria-label="Template categories">
          {TEMPLATE_CATEGORIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={category === entry.id ? 'template-category-item is-active' : 'template-category-item'}
              onClick={() => onCategory(entry.id)}
            >
              <span className="template-category-item__body">
                <span className="template-category-item__name">{entry.name}</span>
                <span className="template-category-item__blurb">{entry.blurb}</span>
              </span>
              <span className="template-category-item__count">{counts[entry.id] ?? 0}</span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function TemplateCard({
  template,
  onSelect
}: {
  template: BenchmarkTestTemplateRecord;
  onSelect: (templateId: string) => void;
}) {
  return (
    <button type="button" className="template-card" onClick={() => onSelect(template.id)}>
      <div className="template-card__top">
        <span className="template-card__name">{templateLabel(template)}</span>
        <span className="template-card__chip">{template.document.operation}</span>
      </div>
      <p className="template-card__description">{template.document.description ?? `${template.document.operation} benchmark template`}</p>
      <div className="template-card__footer">
        <span className="template-card__id">{template.document.template_id}</span>
        <span className="template-card__meta">{template.document.metrics.length} metrics</span>
      </div>
    </button>
  );
}

function TemplateBrowseGrid({
  templates,
  category,
  query,
  operationFilter,
  onQuery,
  onFilter,
  onSelect,
  onNew
}: {
  templates: BenchmarkTestTemplateRecord[];
  category: TemplateCategory;
  query: string;
  operationFilter: TemplateOperationFilter;
  onQuery: (value: string) => void;
  onFilter: (value: TemplateOperationFilter) => void;
  onSelect: (templateId: string) => void;
  onNew: () => void;
}) {
  const groupedSections = category === 'all'
    ? TEMPLATE_CATEGORIES
        .filter((entry): entry is TemplateCategoryDefinition & { id: Exclude<TemplateCategory, 'all'> } => entry.id !== 'all')
        .map((entry) => ({
          category: entry,
          items: templates.filter((template) => categorizeTemplateDocument(template.document) === entry.id)
        }))
        .filter((section) => section.items.length > 0)
    : [];

  return (
    <section className="template-browse">
      <div className="template-browse__bar">
        <div className="template-browse__title">
          <h2>{categoryName(category)}</h2>
          <span className="template-browse__count">{templates.length} template{templates.length === 1 ? '' : 's'}</span>
        </div>
        <div className="template-browse__tools">
          <div className="template-browse__search">
            <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search templates" />
          </div>
          <button type="button" className="templates-rail-new" onClick={onNew}>+ New</button>
        </div>
      </div>
      <div className="templates-operation-filter template-browse__filters" aria-label="Template operation">
        {OPERATION_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={operationFilter === value ? 'is-active' : ''}
            onClick={() => onFilter(value)}
            disabled={!ENABLED_OPERATION_FILTERS.has(value)}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="template-browse__body">
        {templates.length === 0 ? (
          <div className="template-browse-empty">
            <h3>No templates match</h3>
            <p>Try a different category, clear the search, or create a new template.</p>
            <button type="button" className="btn btn--sm" onClick={onNew}>+ New template</button>
          </div>
        ) : category === 'all' ? (
          groupedSections.map((section) => (
            <section key={section.category.id} className="template-category-section">
              <div className="template-category-section__head">
                <span className="template-category-section__name">{section.category.name}</span>
                <span className="template-category-section__count">{section.items.length}</span>
                <span className="template-category-section__rule" />
              </div>
              <div className="template-card-grid">
                {section.items.map((template) => <TemplateCard key={template.id} template={template} onSelect={onSelect} />)}
              </div>
            </section>
          ))
        ) : (
          <div className="template-card-grid">
            {templates.map((template) => <TemplateCard key={template.id} template={template} onSelect={onSelect} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function TemplateJsonWindow({
  filename,
  lines,
  showNotes,
  onToggleNotes,
  readOnly,
  children
}: {
  filename: string;
  lines: JsonLine[];
  showNotes: boolean;
  onToggleNotes?: () => void;
  readOnly?: boolean;
  children?: ReactNode;
}) {
  const hasNotes = lines.some((line) => line.note);
  return (
    <div className="template-json-window">
      <div className="template-json-window__bar">
        <span className="template-json-window__dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="template-json-window__filename">{filename}</span>
        <span className="template-json-window__spacer" />
        {onToggleNotes && hasNotes ? (
          <button type="button" className={showNotes ? 'template-notes-toggle is-on' : 'template-notes-toggle'} onClick={onToggleNotes}>
            AI notes {showNotes ? 'on' : 'off'}
          </button>
        ) : null}
        {readOnly ? <span className="template-json-window__state">read-only</span> : null}
      </div>
      {children ?? <JsonView lines={lines} showNotes={showNotes} />}
    </div>
  );
}

function TemplatePreview({
  template,
  onBack,
  onModify,
  onDelete
}: {
  template: BenchmarkTestTemplateRecord;
  onBack: () => void;
  onModify: () => void;
  onDelete: () => void;
}) {
  const stats = parseTemplateStats(template);
  const document = template.document;
  const requiresToolCalling = document.required_capabilities?.tool_calling === true;
  const includesToolCallAssertion = document.metrics.includes(TOOL_CALL_ASSERTION_METRIC);
  return (
    <article className="template-preview-panel">
      <button type="button" className="template-preview-backlink" onClick={onBack}>← All templates</button>
      <header>
        <div>
          <span className="template-kind template-kind--benchmark">benchmark</span>
          <h2>{document.name ?? document.template_id}</h2>
          <p>{stats.summary}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={onModify}>Modify</button>
          <button type="button" className="btn btn--ghost" onClick={onDelete}>Delete</button>
        </div>
      </header>
      <div className="template-preview-grid">
        <div className="kv"><span>Template ID</span><strong title={document.template_id}>{document.template_id}</strong></div>
        <div className="kv"><span>Version</span><strong>{document.template_version}</strong></div>
        <div className="kv"><span>Operation</span><strong>{document.operation}</strong></div>
        <div className="kv"><span>Updated</span><strong>{formatDate(template.updated_at)}</strong></div>
        <div className="kv"><span>Stages</span><strong>{stats.stageCount}</strong></div>
        <div className="kv"><span>Metrics</span><strong>{stats.metricCount}</strong></div>
        <div className="kv"><span>Aggregations</span><strong>{stats.aggregationCount}</strong></div>
        <div className="kv"><span>Capabilities</span><strong>{stats.capabilityCount}</strong></div>
      </div>
      {requiresToolCalling ? (
        <div className={includesToolCallAssertion ? 'template-tool-status is-pass' : 'template-tool-status is-warning'}>
          <strong>{includesToolCallAssertion ? 'Tool-call assertion included' : 'Tool-call assertion missing'}</strong>
          <code>{TOOL_CALL_ASSERTION_METRIC}</code>
        </div>
      ) : null}
      <section>
        <h3>Benchmark document</h3>
        <TemplateJsonWindow filename={`${document.template_id}.json`} lines={jsonLines(document)} showNotes={false} readOnly />
      </section>
      <section>
        <h3>Template contract</h3>
        <code className="template-contract">{document.template_id}@{document.template_version} / {document.operation}</code>
      </section>
    </article>
  );
}

function TemplateAgentPanel({
  mode,
  selectedTemplate,
  currentDraft,
  busy,
  onDraft,
  onSkeleton,
  onBusy,
  onError
}: {
  mode: 'create' | 'modify';
  selectedTemplate: BenchmarkTestTemplateRecord | null;
  currentDraft: BenchmarkTestTemplateDocument | null;
  busy: boolean;
  onDraft: (document: BenchmarkTestTemplateDocument) => void;
  onSkeleton: (document: BenchmarkTestTemplateDocument) => void;
  onBusy: (value: boolean) => void;
  onError: (value: string | null) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>({ template_agent_model: null });
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [message, setMessage] = useState('');
  const [conversation, setConversation] = useState<TemplateAgentMessage[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([{
    role: 'assistant',
    content: mode === 'modify'
      ? 'Tell me what to change about this template. I will edit the document on the left and highlight the changed lines.'
      : 'Describe the benchmark template you want to build. I will ask for missing details, then draft a validated test_template.'
  }]);
  const chatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([getAppSettings(), listModels()])
      .then(([settingsResult, modelsResult]) => {
        if (!active) return;
        if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value);
        if (modelsResult.status === 'fulfilled') setModels(modelsResult.value);
      })
      .catch(() => {
        if (active) onError('Unable to load template agent settings.');
      });
    return () => {
      active = false;
    };
  }, [onError]);

  useEffect(() => {
    setConversation([]);
    setEntries([{
      role: 'assistant',
      content: mode === 'modify'
        ? 'Tell me what to change about this template. I will edit the document on the left and highlight the changed lines.'
        : 'Describe the benchmark template you want to build. I will ask for missing details, then draft a validated test_template.'
    }]);
    setMessage('');
  }, [mode, selectedTemplate?.id]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [entries, busy]);

  const selectedModelKey = settings.template_agent_model
    ? `${settings.template_agent_model.server_id}::${settings.template_agent_model.model_id}`
    : '';
  const selectedModel = models.find((record) => modelKey(record) === selectedModelKey) ?? null;
  const canSend = Boolean(settings.template_agent_model) && message.trim().length > 0 && !busy;

  async function sendMessage(value?: string) {
    const content = (value ?? message).trim();
    if (!content || !settings.template_agent_model || busy) return;
    const userMessage: TemplateAgentMessage = { role: 'user', content };
    const requestConversation = conversation;
    setConversation((current) => [...current, userMessage]);
    setEntries((current) => [...current, { role: 'user', content }]);
    setMessage('');
    onError(null);
    onBusy(true);
    try {
      const response = await runTemplateAgent({
        mode,
        message: content,
        conversation: requestConversation,
        existing_template: selectedTemplate?.document
      });
      const assistantMessage: TemplateAgentMessage = { role: 'assistant', content: response.reply };
      setConversation((current) => [...current, assistantMessage]);
      setEntries((current) => [...current, {
        role: 'assistant',
        content: response.reply,
        questions: response.status === 'needs_input' ? response.questions : undefined
      }]);
      if (response.status === 'needs_input') {
        onSkeleton(skeletonFromMessage(content));
      } else {
        onDraft(response.template);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Template agent failed');
    } finally {
      onBusy(false);
    }
  }

  return (
    <section className="template-agent-panel">
      <header className="template-agent-panel__header">
        <span className="eyebrow">Benchmark agent / {mode}</span>
        <h3>{mode === 'modify' ? 'Modify template' : 'Author a template'}</h3>
        <div className="template-agent-engine">
          <span className="template-agent-engine__dot" aria-hidden="true" />
          <span>Engine</span>
          <code>{selectedModel ? `${modelLabel(selectedModel)} (${selectedModel.model.server_id})` : settings.template_agent_model ? selectedModelKey : 'No model configured'}</code>
        </div>
      </header>

      {!settings.template_agent_model ? (
        <div className="error template-agent-error">Configure a template agent model in Settings before using the agent.</div>
      ) : null}

      <div className="template-agent-chat" ref={chatRef} aria-live="polite">
        {entries.map((entry, index) => (
          <section key={`${entry.role}-${index}`} className={`template-agent-message is-${entry.role}`}>
            <span>{entry.role === 'user' ? 'you' : 'assistant'}</span>
            <div>
              <p>{entry.content}</p>
              {entry.questions?.length ? (
                <ul>
                  {entry.questions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              ) : null}
            </div>
          </section>
        ))}
        {busy ? (
          <section className="template-agent-message is-assistant">
            <span>assistant</span>
            <div><span className="template-agent-typing"><i /><i /><i /></span></div>
          </section>
        ) : null}
      </div>

      {currentDraft ? (
        <div className="template-agent-draft-card">
          <strong>Validated draft / passes benchmark_test_template_v1</strong>
          <p>{currentDraft.name ?? currentDraft.template_id} / {currentDraft.operation} / {currentDraft.metrics.length} metrics</p>
        </div>
      ) : null}

      <footer className="template-agent-composer">
        <div className="template-agent-input-row">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendMessage();
              }
            }}
            rows={4}
            placeholder={currentDraft ? 'Draft ready - save it, or keep refining...' : mode === 'modify' ? 'Describe how this template should change.' : 'Describe what you want...'}
          />
          <button type="button" className="template-agent-send" onClick={() => sendMessage()} disabled={!canSend}>Send</button>
        </div>
      </footer>
    </section>
  );
}

function TemplateAuthor({
  mode,
  selectedTemplate,
  error,
  busy,
  onCancel,
  onSave,
  onBusy,
  onError
}: {
  mode: 'create' | 'modify';
  selectedTemplate: BenchmarkTestTemplateRecord | null;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (document: BenchmarkTestTemplateDocument) => Promise<void>;
  onBusy: (value: boolean) => void;
  onError: (value: string | null) => void;
}) {
  const seedDocument = mode === 'modify' ? selectedTemplate?.document ?? DEFAULT_TEMPLATE_DRAFT : DEFAULT_TEMPLATE_DRAFT;
  const [tab, setTab] = useState<AuthorTab>('live');
  const [currentDraft, setCurrentDraft] = useState<BenchmarkTestTemplateDocument | null>(mode === 'modify' ? seedDocument : null);
  const [draftSource, setDraftSource] = useState<DraftSource>(mode === 'modify' ? 'seed' : 'none');
  const [skeleton, setSkeleton] = useState<BenchmarkTestTemplateDocument | null>(null);
  const [rawJson, setRawJson] = useState(() => stringifyJson(seedDocument));
  const [rawDirty, setRawDirty] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const draftJsonRef = useRef(currentDraft ? stringifyJson(currentDraft) : '');

  useEffect(() => {
    const nextSeed = mode === 'modify' ? selectedTemplate?.document ?? DEFAULT_TEMPLATE_DRAFT : DEFAULT_TEMPLATE_DRAFT;
    setTab('live');
    setCurrentDraft(mode === 'modify' ? nextSeed : null);
    setDraftSource(mode === 'modify' ? 'seed' : 'none');
    draftJsonRef.current = mode === 'modify' ? stringifyJson(nextSeed) : '';
    setSkeleton(null);
    setRawJson(stringifyJson(nextSeed));
    setRawDirty(false);
    setShowNotes(true);
  }, [mode, selectedTemplate?.id]);

  const authorDocument = currentDraft ?? skeleton ?? seedDocument;

  useEffect(() => {
    if (!rawDirty) {
      setRawJson(stringifyJson(authorDocument));
    }
  }, [authorDocument, rawDirty]);

  const baseline = mode === 'modify' ? seedDocument : undefined;
  const liveLines = useMemo(() => {
    if (currentDraft) return jsonLines(currentDraft, baseline);
    if (skeleton) return jsonLines(skeleton, undefined).map((line) => line.text.includes('"template_id"') || line.text.includes('"operation"')
      ? { ...line, note: 'inferred from your first message', isNew: true }
      : line);
    return [
      { text: '// Your benchmark document will build here as you talk.' },
      { text: '// Answer the assistant questions on the right.' }
    ];
  }, [baseline, currentDraft, skeleton]);

  const canSave = Boolean(currentDraft?.template_id?.trim() && currentDraft.metrics?.length && currentDraft.aggregations?.length);
  const saveEnabled = canSave && (mode === 'modify' || draftSource !== 'none');
  const title = mode === 'modify' ? 'Modify template' : 'Create template';
  const filename = `${currentDraft?.template_id || selectedTemplate?.document.template_id || 'template'}.json`;
  const category = categorizeTemplateDocument(authorDocument);

  function openTab(nextTab: AuthorTab) {
    if (nextTab === 'raw' && !rawDirty) {
      setRawJson(stringifyJson(authorDocument));
    }
    setTab(nextTab);
  }

  const handleDraftChange = useCallback((document: BenchmarkTestTemplateDocument) => {
    if (
      mode === 'create'
      && draftSource === 'none'
      && document.template_id === DEFAULT_TEMPLATE_DRAFT.template_id
      && document.name === DEFAULT_TEMPLATE_DRAFT.name
    ) {
      return;
    }
    const nextJson = stringifyJson(document);
    if (nextJson === draftJsonRef.current) return;
    draftJsonRef.current = nextJson;
    setCurrentDraft(document);
    setDraftSource('advanced');
  }, [draftSource, mode]);

  function applyRawJson() {
    onError(null);
    try {
      const parsed = JSON.parse(rawJson) as BenchmarkTestTemplateDocument;
      const normalized = {
        ...parsed,
        kind: 'test_template',
        schema_version: 'benchmark_test_template_v1'
      } satisfies BenchmarkTestTemplateDocument;
      draftJsonRef.current = stringifyJson(normalized);
      setCurrentDraft(normalized);
      setDraftSource('raw');
      setRawDirty(false);
      setTab('live');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Raw JSON must be valid before it can be applied.');
    }
  }

  async function saveDraft() {
    if (!currentDraft) return;
    await onSave(currentDraft);
  }

  return (
    <div className="template-author">
      <div className="template-author__center">
        <div className="template-author__header">
          <div className="template-author__heading">
            <h2>{title}</h2>
            <span className="template-category-badge">
              <i className="template-category-badge__dot" aria-hidden="true" />
              Category <strong>{categoryName(category)}</strong>
            </span>
          </div>
          <div className="template-author-tabs">
            <button type="button" className={tab === 'live' ? 'is-active' : ''} onClick={() => openTab('live')}>Live JSON</button>
            <button type="button" className={tab === 'advanced' ? 'is-active' : ''} onClick={() => openTab('advanced')}>Advanced form</button>
            <button type="button" className={tab === 'raw' ? 'is-active' : ''} onClick={() => openTab('raw')}>Raw JSON</button>
            {saveEnabled ? <button type="button" className="template-author-save" onClick={saveDraft} disabled={busy}>Save template</button> : null}
            <button type="button" onClick={onCancel}>x Close</button>
          </div>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {tab === 'advanced' ? (
          <div className="template-advanced-panel">
            <div className="template-advanced-note">Advanced editing - every field the assistant set is here, fully editable. Changes stay in sync with the JSON before save.</div>
            <TemplateEditor
              template={mode === 'modify' ? selectedTemplate : null}
              initialDocument={authorDocument}
              onSave={onSave}
              onDraftChange={handleDraftChange}
              error={null}
              busy={busy}
              embedded
            />
          </div>
        ) : tab === 'raw' ? (
          <TemplateJsonWindow filename={filename} lines={[]} showNotes={false}>
            <textarea
              className="template-raw-json"
              value={rawJson}
              onChange={(event) => {
                setRawJson(event.target.value);
                setRawDirty(true);
              }}
              spellCheck={false}
            />
            <div className="template-raw-actions">
              <button type="button" onClick={applyRawJson}>Update draft</button>
              <button type="button" className="btn btn--ghost" onClick={() => {
                setRawJson(stringifyJson(authorDocument));
                setRawDirty(false);
              }}>Reset</button>
            </div>
          </TemplateJsonWindow>
        ) : (
          <TemplateJsonWindow filename={filename} lines={liveLines} showNotes={showNotes} onToggleNotes={() => setShowNotes((value) => !value)} />
        )}
      </div>
      <TemplateAgentPanel
        mode={mode}
        selectedTemplate={selectedTemplate}
        currentDraft={currentDraft}
        busy={busy}
        onDraft={(document) => {
          draftJsonRef.current = stringifyJson(document);
          setCurrentDraft(document);
          setDraftSource('agent');
          setSkeleton(null);
          setTab('live');
          setRawDirty(false);
        }}
        onSkeleton={(document) => {
          if (!currentDraft) setSkeleton(document);
          setTab('live');
        }}
        onBusy={onBusy}
        onError={onError}
      />
    </div>
  );
}

export function Templates() {
  const [templates, setTemplates] = useState<BenchmarkTestTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<TemplateMode>({ kind: 'grid' });
  const [category, setCategory] = useState<TemplateCategory>('all');
  const [query, setQuery] = useState('');
  const [operationFilter, setOperationFilter] = useState<TemplateOperationFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ENABLED_OPERATION_FILTERS.has(operationFilter)) return;
    setOperationFilter('all');
  }, [operationFilter]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId]
  );

  const categoryCounts = useMemo<Record<TemplateCategory, number>>(() => {
    const counts: Record<TemplateCategory, number> = {
      all: templates.length,
      tool: 0,
      agentic: 0,
      structured: 0
    };
    templates.forEach((template) => {
      counts[categorizeTemplateDocument(template.document)] += 1;
    });
    return counts;
  }, [templates]);

  const categorizedTemplates = useMemo(() => {
    if (category === 'all') return templates;
    return templates.filter((template) => categorizeTemplateDocument(template.document) === category);
  }, [category, templates]);

  const filteredTemplates = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return categorizedTemplates.filter((template) => {
      if (operationFilter !== 'all' && template.document.operation !== operationFilter) return false;
      if (!lower) return true;
      return [
        template.document.name ?? '',
        template.document.template_id,
        template.document.operation,
        template.document.description ?? ''
      ].some((value) => value.toLowerCase().includes(lower));
    });
  }, [categorizedTemplates, operationFilter, query]);

  const loadTemplates = useCallback(async () => {
    const data = await listBenchmarkDocuments<BenchmarkTestTemplateDocument>('test_template');
    setTemplates(data);
    return data;
  }, []);

  useEffect(() => {
    loadTemplates().catch(() => setTemplates([]));
  }, [loadTemplates]);

  useEffect(() => {
    if (mode.kind !== 'preview' && mode.kind !== 'modify') return;
    if (selectedTemplate) return;
    setMode({ kind: 'grid' });
    setSelectedId(null);
  }, [mode.kind, selectedTemplate]);

  async function handleSave(input: BenchmarkTestTemplateDocument) {
    setError(null);
    setBusy(true);
    try {
      await saveBenchmarkDocument(input);
      const data = await loadTemplates();
      const savedTemplate = data.find((template) => template.id === input.template_id || template.document.template_id === input.template_id) ?? null;
      setSelectedId(savedTemplate?.id ?? input.template_id);
      setCategory(categorizeTemplateDocument(input));
      setMode({ kind: 'preview' });
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
      setSelectedId(null);
      setMode({ kind: 'grid' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete benchmark template');
    } finally {
      setBusy(false);
    }
  }

  const selectedCategory = selectedTemplate ? categorizeTemplateDocument(selectedTemplate.document) : category;
  const breadcrumb = mode.kind === 'create'
    ? 'Templates / New'
    : mode.kind === 'modify' && selectedTemplate
      ? `Templates / ${templateLabel(selectedTemplate)} / Modify`
      : mode.kind === 'preview' && selectedTemplate
        ? `Templates / ${categoryName(selectedCategory)} / ${templateLabel(selectedTemplate)}`
        : undefined;

  const subtitle = breadcrumb ? `${breadcrumb} / Reusable benchmark test_template documents.` : 'Reusable benchmark test_template documents.';

  return (
    <>
      <MergedPageHeader title="Templates" subtitle={subtitle} />
      <section className="page templates-page templates-page--polish">
        <div className="templates-layout templates-layout--catalog">
          <TemplateCategoryRail
            category={category}
            counts={categoryCounts}
            onCategory={(nextCategory) => {
              setCategory(nextCategory);
              setMode({ kind: 'grid' });
              setSelectedId(null);
              setError(null);
            }}
          />
          <main className="templates-main">
            {mode.kind === 'create' ? (
              <TemplateAuthor
                mode="create"
                selectedTemplate={null}
                error={error}
                busy={busy}
                onCancel={() => {
                  setMode({ kind: 'grid' });
                  setError(null);
                }}
                onSave={handleSave}
                onBusy={setBusy}
                onError={setError}
              />
            ) : mode.kind === 'modify' && selectedTemplate ? (
              <TemplateAuthor
                mode="modify"
                selectedTemplate={selectedTemplate}
                error={error}
                busy={busy}
                onCancel={() => {
                  setMode({ kind: 'preview' });
                  setError(null);
                }}
                onSave={handleSave}
                onBusy={setBusy}
                onError={setError}
              />
            ) : mode.kind === 'preview' && selectedTemplate ? (
              <>
                {error ? <div className="error templates-page-error">{error}</div> : null}
                <TemplatePreview
                  template={selectedTemplate}
                  onBack={() => {
                    setMode({ kind: 'grid' });
                    setError(null);
                  }}
                  onModify={() => {
                    setMode({ kind: 'modify' });
                    setError(null);
                  }}
                  onDelete={() => handleDelete(selectedTemplate)}
                />
              </>
            ) : templates.length === 0 ? (
              <EmptyState
                className="templates-empty"
                title="Your benchmark templates live here"
                body="Create a reusable test_template document for benchmark runs."
                actions={<button type="button" onClick={() => setMode({ kind: 'create' })}>New benchmark template</button>}
              />
            ) : (
              <>
                {error ? <div className="error templates-page-error">{error}</div> : null}
                <TemplateBrowseGrid
                  templates={filteredTemplates}
                  category={category}
                  query={query}
                  operationFilter={operationFilter}
                  onQuery={setQuery}
                  onFilter={setOperationFilter}
                  onSelect={(templateId) => {
                    setSelectedId(templateId);
                    setMode({ kind: 'preview' });
                    setError(null);
                  }}
                  onNew={() => {
                    setMode({ kind: 'create' });
                    setError(null);
                  }}
                />
              </>
            )}
          </main>
        </div>
      </section>
    </>
  );
}
