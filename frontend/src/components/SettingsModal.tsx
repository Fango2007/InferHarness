import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { EnvEntry } from '../services/system-api.js';
import { type ModelRecord } from '../services/models-api.js';

type EnvType = 'secret' | 'bool' | 'url' | 'path' | 'int' | 'text';
type SettingsSectionId = 'database' | 'model' | 'runtime' | 'auth' | 'connectivity' | 'frontend' | 'advanced';

type SettingsModalProps = {
  entries: EnvEntry[];
  busy: boolean;
  error: string | null;
  message: string | null;
  models: ModelRecord[];
  modelsError: string | null;
  onClose: () => void;
  onSaveEntry: (key: string, value: string | null) => Promise<void>;
  onClearDatabase: () => Promise<void>;
};

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
};

type EnvGroup = {
  id: string;
  label: string;
  glob: string;
  entries: EnvEntry[];
};

const SECRET_KEY = /TOKEN|SECRET|KEY$|PASSWORD/;
const VALID_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'database',
    label: 'Database',
    description: 'Storage controls and destructive maintenance actions.'
  },
  {
    id: 'model',
    label: 'Model Selection',
    description: 'Choose the model reserved for upcoming settings-driven workflows.'
  },
  {
    id: 'runtime',
    label: 'Runtime',
    description: 'Python, benchmark, dataset, timeout, and execution-related environment values.'
  },
  {
    id: 'auth',
    label: 'Providers & Auth',
    description: 'Provider credentials and non-frontend secret values.'
  },
  {
    id: 'connectivity',
    label: 'Connectivity',
    description: 'Proxy, TLS, health polling, and server connectivity values.'
  },
  {
    id: 'frontend',
    label: 'Frontend',
    description: 'Vite-exposed browser runtime values.'
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Unclassified environment values and new key creation.'
  }
];

function inferEnvType(key: string, value: string): EnvType {
  if (SECRET_KEY.test(key)) return 'secret';
  if (/^(true|false)$/i.test(value)) return 'bool';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (value.startsWith('/') || value.startsWith('\\')) return 'path';
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'int';
  return 'text';
}

function sectionForEntry(entry: EnvEntry): SettingsSectionId {
  const key = entry.key;
  if (key.startsWith('VITE_')) return 'frontend';
  if (key.includes('PROXY') || key.includes('TLS') || key.includes('CONNECTIVITY') || key.includes('HEALTH_POLL')) return 'connectivity';
  if (SECRET_KEY.test(key) || key.startsWith('HF_') || key.startsWith('HUGGINGFACE_') || key.includes('AUTH')) return 'auth';
  if (
    key.includes('PYTHON') ||
    key.includes('BENCHMARK') ||
    key.includes('DATASET') ||
    key.includes('CONTEXT') ||
    key.includes('TIMEOUT') ||
    key.includes('RETENTION') ||
    key.includes('TEMPLATE') ||
    key.includes('DRY_RUN') ||
    key.includes('RUNNER')
  ) {
    return 'runtime';
  }
  return 'advanced';
}

function groupEntries(entries: EnvEntry[], activeSection: SettingsSectionId, filter: string): EnvGroup[] {
  if (activeSection === 'database' || activeSection === 'model') return [];
  const normalizedFilter = filter.trim().toLowerCase();
  const visible = entries
    .filter((entry) => sectionForEntry(entry) === activeSection)
    .filter((entry) => (normalizedFilter ? entry.key.toLowerCase().includes(normalizedFilter) : true))
    .sort((a, b) => a.key.localeCompare(b.key));

  if (activeSection === 'frontend') {
    return [{ id: 'frontend', label: 'Frontend (Vite)', glob: 'VITE_*', entries: visible }].filter((group) => group.entries.length > 0);
  }
  if (activeSection === 'auth') {
    return [{ id: 'auth', label: 'Provider credentials', glob: '*TOKEN · *SECRET · *KEY', entries: visible }].filter((group) => group.entries.length > 0);
  }
  if (activeSection === 'connectivity') {
    return [{ id: 'connectivity', label: 'Network and health', glob: '*PROXY · *TLS · CONNECTIVITY_*', entries: visible }].filter((group) => group.entries.length > 0);
  }
  if (activeSection === 'runtime') {
    return [{ id: 'runtime', label: 'Execution runtime', glob: 'PYTHON · BENCHMARK · DATASET · TIMEOUT', entries: visible }].filter((group) => group.entries.length > 0);
  }
  return [{ id: 'advanced', label: 'Unclassified', glob: '*', entries: visible }].filter((group) => group.entries.length > 0);
}

function formatKey(key: string) {
  const prefix = key.startsWith('INFERHARNESS_') ? 'INFERHARNESS_' : key.startsWith('VITE_') ? 'VITE_' : '';
  if (!prefix) return key;
  return (
    <>
      <b>{prefix}</b>
      {key.slice(prefix.length)}
    </>
  );
}

function normalizeNewKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

function focusableElements(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute('aria-hidden'));
}

function modelKey(record: ModelRecord) {
  return `${record.model.server_id}::${record.model.model_id}`;
}

function modelLabel(record: ModelRecord) {
  return record.model.display_name || record.model.model_id;
}

function formatProvider(value: string) {
  return value === 'unknown' ? 'Unknown' : value.charAt(0).toUpperCase() + value.slice(1);
}

function formatContextWindow(value: number | null) {
  return value === null ? 'Unknown' : value.toLocaleString();
}

function sectionCount(entries: EnvEntry[], sectionId: SettingsSectionId, models: ModelRecord[]) {
  if (sectionId === 'database') return null;
  if (sectionId === 'model') return models.filter((record) => record.model.active && !record.model.archived).length;
  return entries.filter((entry) => sectionForEntry(entry) === sectionId).length;
}

export function SettingsModal({
  entries,
  busy,
  error,
  message,
  models,
  modelsError,
  onClose,
  onSaveEntry,
  onClearDatabase
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('runtime');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [clearState, setClearState] = useState<'idle' | 'armed' | 'done'>('idle');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [selectedModelKey, setSelectedModelKey] = useState('');

  useEffect(() => {
    setDrafts(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])));
  }, [entries]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    setFilter('');
  }, [activeSection]);

  useEffect(() => {
    if (clearState !== 'armed') return undefined;
    const timeoutId = window.setTimeout(() => setClearState('idle'), 2600);
    return () => window.clearTimeout(timeoutId);
  }, [clearState]);

  useEffect(() => {
    if (!savedKey) return undefined;
    const timeoutId = window.setTimeout(() => setSavedKey(null), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [savedKey]);

  useEffect(() => {
    if (!highlightedKey) return undefined;
    const timeoutId = window.setTimeout(() => setHighlightedKey(null), 900);
    return () => window.clearTimeout(timeoutId);
  }, [highlightedKey]);

  const selectableModels = useMemo(
    () =>
      models
        .filter((record) => record.model.active && !record.model.archived)
        .sort((a, b) => modelLabel(a).localeCompare(modelLabel(b))),
    [models]
  );
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0];
  const originalValues = useMemo(() => Object.fromEntries(entries.map((entry) => [entry.key, entry.value])), [entries]);
  const groups = useMemo(() => groupEntries(entries, activeSection, filter), [activeSection, entries, filter]);
  const activeCount = sectionCount(entries, activeSection, selectableModels);
  const selectedModel = selectableModels.find((record) => modelKey(record) === selectedModelKey) ?? null;
  const existingKeys = useMemo(() => new Set(entries.map((entry) => entry.key)), [entries]);
  const canAdd = VALID_ENV_KEY.test(newKey) && !existingKeys.has(newKey);

  useEffect(() => {
    if (selectableModels.length === 0) {
      if (selectedModelKey) setSelectedModelKey('');
      return;
    }
    if (!selectableModels.some((record) => modelKey(record) === selectedModelKey)) {
      setSelectedModelKey(modelKey(selectableModels[0]));
    }
  }, [selectableModels, selectedModelKey]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }
    const focusables = focusableElements(dialogRef.current);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function saveEntry(key: string) {
    const value = drafts[key] ?? '';
    try {
      await onSaveEntry(key, value);
      setSavedKey(key);
    } catch {
      // The parent owns the rendered error message.
    }
  }

  async function removeEntry(key: string) {
    setRemovingKey(key);
    window.setTimeout(() => {
      void onSaveEntry(key, null)
        .catch(() => {
          // The parent owns the rendered error message.
        })
        .finally(() => setRemovingKey(null));
    }, 180);
  }

  async function addEntry() {
    if (!canAdd) return;
    const key = newKey;
    try {
      await onSaveEntry(key, newValue);
      setNewKey('');
      setNewValue('');
      setHighlightedKey(key);
      setActiveSection(sectionForEntry({ key, value: newValue }));
    } catch {
      // The parent owns the rendered error message.
    }
  }

  async function clearDatabase() {
    if (clearState !== 'armed') {
      setClearState('armed');
      return;
    }
    try {
      await onClearDatabase();
      setClearState('done');
      window.setTimeout(() => setClearState('idle'), 1600);
    } catch {
      setClearState('idle');
    }
  }

  const clearLabel = busy
    ? 'Working...'
    : clearState === 'armed'
      ? 'Click again to confirm'
      : clearState === 'done'
        ? 'Database emptied'
        : 'Empty database';

  const countNoun = activeSection === 'model' ? 'model' : 'key';
  const showEnvControls = activeSection !== 'database' && activeSection !== 'model';

  return (
    <div className="modal-overlay settings-overlay">
      <div
        className="modal-card settings-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
      >
        <header className="modal-header settings-modal-head">
          <div className="settings-modal-title">
            <span className="eyebrow">AITestBench</span>
            <h2 className="h2" id="settings-title">Settings</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
            ref={closeButtonRef}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="settings-shell">
          <aside className="settings-nav" aria-label="Settings categories">
            {SETTINGS_SECTIONS.map((section) => {
              const count = sectionCount(entries, section.id, selectableModels);
              return (
                <button
                  type="button"
                  className={`settings-nav-item ${activeSection === section.id ? 'is-active' : ''}`}
                  onClick={() => setActiveSection(section.id)}
                  aria-current={activeSection === section.id ? 'page' : undefined}
                  key={section.id}
                >
                  <span>{section.label}</span>
                  {count !== null ? <code>{count}</code> : null}
                </button>
              );
            })}
          </aside>

          <div className="settings-modal-body">
            <div className="settings-status" aria-live="polite">
              {error ? <div className="error">{error}</div> : null}
              {message ? <p className="muted">{message}</p> : null}
            </div>

            <section className="settings-section">
              <div className="settings-section-head">
                <span className="label">{activeSectionMeta.label}</span>
                {activeCount !== null ? (
                  <span className="settings-section-count">{activeCount} {activeCount === 1 ? countNoun : `${countNoun}s`}</span>
                ) : null}
              </div>
              <p className="settings-section-desc">{activeSectionMeta.description}</p>

              {activeSection === 'database' ? (
                <div className="danger-zone">
                  <div className="danger-zone-text">
                    <strong>Empty the database</strong>
                    <span>Server registrations and <code className="code-inline">.env</code> values are preserved.</span>
                  </div>
                  <button type="button" className="btn btn--danger" onClick={clearDatabase} disabled={busy}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 4h11M6 4V2.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8V4M5 4l.5 8.5a1 1 0 0 0 1 .95h3a1 1 0 0 0 1-.95L11 4" />
                    </svg>
                    {clearLabel}
                  </button>
                </div>
              ) : null}

              {activeSection === 'model' ? (
                <div className="settings-model-picker">
                  {modelsError ? <div className="error">{modelsError}</div> : null}
                  {selectableModels.length === 0 ? (
                    <p className="muted">No active models are available.</p>
                  ) : (
                    <>
                      <label className="form-field-label" htmlFor="settings-model-picker">Model</label>
                      <select
                        id="settings-model-picker"
                        className="field"
                        value={selectedModelKey}
                        onChange={(event) => setSelectedModelKey(event.target.value)}
                        disabled={busy}
                      >
                        {selectableModels.map((record) => (
                          <option value={modelKey(record)} key={modelKey(record)}>
                            {modelLabel(record)} ({record.model.server_id})
                          </option>
                        ))}
                      </select>
                      {selectedModel ? (
                        <div className="settings-model-summary">
                          <div>
                            <span>Server</span>
                            <strong>{selectedModel.model.server_id}</strong>
                          </div>
                          <div>
                            <span>Provider</span>
                            <strong>{formatProvider(selectedModel.identity.provider)}</strong>
                          </div>
                          <div>
                            <span>Format</span>
                            <strong>{selectedModel.architecture.format ?? 'Unknown'}</strong>
                          </div>
                          <div>
                            <span>Context</span>
                            <strong>{formatContextWindow(selectedModel.limits.context_window_tokens)}</strong>
                          </div>
                        </div>
                      ) : null}
                      <p className="muted">Stored locally in this dialog until the execution feature is ready.</p>
                    </>
                  )}
                </div>
              ) : null}

              {showEnvControls ? (
                <>
                  <div className="env-toolbar">
                    <div className="env-search">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="M10.5 10.5L14 14" strokeLinecap="round" />
                      </svg>
                      <input
                        className="field"
                        type="text"
                        placeholder={`Filter ${activeSectionMeta.label.toLowerCase()} keys...`}
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  {activeCount === 0 ? <p className="muted">No keys are classified in this section.</p> : null}
                  {activeCount !== 0 && groups.length === 0 ? <p className="muted">No keys match this filter.</p> : null}

                  <div className="env-groups">
                    {groups.map((group) => {
                      const isCollapsed = !filter.trim() && collapsedGroups.has(group.id);
                      const rowsId = `settings-env-group-${group.id}`;
                      return (
                        <div className={`env-group ${isCollapsed ? 'is-collapsed' : ''}`} key={group.id}>
                          <button
                            type="button"
                            className="env-group-head"
                            onClick={() => toggleGroup(group.id)}
                            aria-expanded={!isCollapsed}
                            aria-controls={rowsId}
                          >
                            <span className="env-group-title">
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M6 4l4 4-4 4" />
                              </svg>
                              <span>{group.label}</span>
                            </span>
                            <code>{group.glob}</code>
                            <span className="env-group-count">{group.entries.length}</span>
                          </button>
                          <div className="env-group-rows" id={rowsId} hidden={isCollapsed}>
                            {group.entries.map((entry) => {
                              const value = drafts[entry.key] ?? entry.value;
                              const type = inferEnvType(entry.key, value);
                              const isSecret = type === 'secret';
                              const isRevealed = revealed.has(entry.key);
                              const isDirty = value !== (originalValues[entry.key] ?? '');
                              const isSaved = savedKey === entry.key;
                              const saveLabel = isSaved ? 'Saved' : isDirty ? 'Save' : 'Saved';
                              return (
                                <div
                                  className={`env-row ${isDirty ? 'is-dirty' : ''} ${isSaved ? 'is-saved-row' : ''} ${removingKey === entry.key ? 'is-removing' : ''} ${highlightedKey === entry.key ? 'is-highlighted' : ''}`}
                                  key={entry.key}
                                >
                                  <div className="env-row-head">
                                    <div className="env-row-key" title={entry.key}>{formatKey(entry.key)}</div>
                                    <span className={`type-badge type-badge--${type}`}>{type}</span>
                                    <span className="env-row-dot" aria-hidden="true" />
                                  </div>
                                  <div className="env-row-controls">
                                    <input
                                      className={`field ${isSecret && !isRevealed ? 'is-secret' : ''}`}
                                      type={isSecret && !isRevealed ? 'password' : 'text'}
                                      value={value}
                                      onChange={(event) => setDrafts((current) => ({ ...current, [entry.key]: event.target.value }))}
                                      disabled={busy || removingKey === entry.key}
                                      autoComplete="off"
                                      spellCheck={false}
                                    />
                                    {isSecret ? (
                                      <button
                                        type="button"
                                        className="reveal"
                                        onClick={() =>
                                          setRevealed((current) => {
                                            const next = new Set(current);
                                            if (next.has(entry.key)) next.delete(entry.key);
                                            else next.add(entry.key);
                                            return next;
                                          })
                                        }
                                        disabled={busy}
                                        aria-label={`${isRevealed ? 'Hide' : 'Show'} ${entry.key}`}
                                        title={isRevealed ? 'Hide value' : 'Show value'}
                                      >
                                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <path d="M1.8 8s2.3-4 6.2-4 6.2 4 6.2 4-2.3 4-6.2 4-6.2-4-6.2-4Z" />
                                          <circle cx="8" cy="8" r="1.8" />
                                        </svg>
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className={`btn btn--sm btn--save ${!isDirty && !isSaved ? 'is-clean' : ''} ${isSaved ? 'is-saved' : ''}`}
                                      onClick={() => saveEntry(entry.key)}
                                      disabled={busy || !isDirty}
                                    >
                                      {saveLabel}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--sm btn--remove"
                                      onClick={() => removeEntry(entry.key)}
                                      disabled={busy || removingKey === entry.key}
                                      aria-label={`Remove ${entry.key}`}
                                      title={`Remove ${entry.key}`}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {activeSection === 'advanced' ? (
                    <div className="env-add">
                      <input
                        className="field field--key"
                        placeholder="NEW_ENV_KEY"
                        value={newKey}
                        onChange={(event) => setNewKey(normalizeNewKey(event.target.value))}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <input
                        className="field"
                        placeholder="value"
                        value={newValue}
                        onChange={(event) => setNewValue(event.target.value)}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button type="button" className="btn" onClick={addEntry} disabled={busy || !canAdd}>
                        Add key
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
