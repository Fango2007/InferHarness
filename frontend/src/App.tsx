import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import packageInfo from '../package.json' with { type: 'json' };
import { MergedPageHeader } from './components/MergedPageHeader.js';
import { Sidebar } from './components/Sidebar.js';
import { Catalog } from './pages/Catalog.js';
import { Evaluate } from './pages/Evaluate.js';
import { ModelDetails } from './pages/ModelDetails.js';
import { ResultsUnified } from './pages/ResultsUnified.js';
import { RunUnified } from './pages/RunUnified.js';
import { Templates } from './pages/Templates.js';
import { legacyRedirectSearch, normalizeResultsTab, resultsSearch } from './navigation.js';
import { apiGet } from './services/api.js';
import { InferenceServerHealth, getConnectivityConfig, getInferenceServerHealth } from './services/connectivity-api.js';
import { InferenceServerRecord, listInferenceServers } from './services/inference-servers-api.js';
import { listModels } from './services/models-api.js';
import { clearDatabase, EnvEntry, listEnvEntries, setEnvEntry } from './services/system-api.js';
import { listTemplates } from './services/templates-api.js';

type SystemHealthMetrics = {
  db: {
    ok: boolean;
  };
};

function LegacyRedirect({ target }: { target: string }) {
  const location = useLocation();
  return <Navigate to={legacyRedirectSearch(target, location.search)} replace />;
}

function CatalogRoute({ servers, connectivity }: { servers: InferenceServerRecord[]; connectivity: Record<string, InferenceServerHealth> }) {
  return <Catalog serversSnapshot={servers} connectivitySnapshot={connectivity} />;
}

function CatalogModelDetailsRoute({
  servers,
  connectivity
}: {
  servers: InferenceServerRecord[];
  connectivity: Record<string, InferenceServerHealth>;
}) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [modelCount, setModelCount] = useState<number | null>(null);
  const serverId = searchParams.get('serverId');
  const reachable = servers.filter((server) => connectivity[server.inference_server.server_id]?.ok).length;
  const discoveredCount = servers.reduce((sum, server) => sum + server.discovery.model_list.normalised.length, 0);
  const displayedModelCount = modelCount ?? discoveredCount;

  useEffect(() => {
    let active = true;
    listModels()
      .then((records) => {
        if (active) setModelCount(records.length || discoveredCount);
      })
      .catch(() => {
        if (active) setModelCount(discoveredCount);
      });
    return () => {
      active = false;
    };
  }, [discoveredCount]);

  const shell = (content: ReactNode) => (
    <>
      <MergedPageHeader
        title="Catalog · Inspect"
        subtitle={`Servers and models · ${reachable} reachable · ${displayedModelCount} models discovered`}
        tabs={[
          { id: 'servers', label: 'Servers', sub: `${servers.length}` },
          { id: 'models', label: 'Models', sub: `${displayedModelCount}` }
        ]}
        activeTab="models"
        onTabChange={(tab) => navigate({ pathname: '/catalog', search: `?tab=${tab}` })}
      />
      {content}
    </>
  );

  if (!id) {
    return <Navigate to="/catalog?tab=models" replace />;
  }
  if (!serverId) {
    return shell(
      <div className="catalog-empty">
        <h3>Server required</h3>
        <p>Open this inspector from a Catalog model card so the hosting server is included.</p>
      </div>
    );
  }

  return shell(
    <ModelDetails
      serverId={serverId}
      modelId={id}
      onBack={() => navigate({ pathname: '/catalog', search: `?tab=models&servers=${encodeURIComponent(serverId)}` })}
    />
  );
}

function ResultsRoute({ runCount }: { runCount: number | null }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeResultsTab(searchParams.get('tab'));

  useEffect(() => {
    if (searchParams.get('tab') === activeTab) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('tab', activeTab);
    setSearchParams(next, { replace: true });
  }, [activeTab, searchParams, setSearchParams]);

  return <ResultsUnified runCount={runCount} />;
}

function RunRoute({ connectivity }: { connectivity: Record<string, InferenceServerHealth> }) {
  return <RunUnified connectivitySnapshot={connectivity} />;
}

export function App() {
  const [healthStatus, setHealthStatus] = useState<'unknown' | 'up' | 'down'>('unknown');
  const [dbStatus, setDbStatus] = useState<'unknown' | 'up' | 'down'>('unknown');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsEntries, setSettingsEntries] = useState<EnvEntry[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [servers, setServers] = useState<InferenceServerRecord[]>([]);
  const [serversError, setServersError] = useState(false);
  const [connectivity, setConnectivity] = useState<Record<string, InferenceServerHealth>>({});
  const [templateCount, setTemplateCount] = useState<number | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);

  useEffect(() => {
    let isActive = true;
    const checkHealth = async () => {
      try {
        await apiGet<{ status: string }>('/health');
        if (isActive) {
          setHealthStatus('up');
        }
      } catch {
        if (isActive) {
          setHealthStatus('down');
        }
      }
    };

    checkHealth();
    const intervalId = window.setInterval(checkHealth, 15000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const checkDatabase = async () => {
      try {
        const data = await apiGet<SystemHealthMetrics>('/system/metrics');
        if (isActive) {
          setDbStatus(data.db.ok ? 'up' : 'down');
        }
      } catch {
        if (isActive) {
          setDbStatus('down');
        }
      }
    };

    checkDatabase();
    const intervalId = window.setInterval(checkDatabase, 15000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);


  useEffect(() => {
    let isActive = true;
    let intervalId: number | null = null;

    const fetchHealth = async () => {
      try {
        const results = await getInferenceServerHealth();
        if (!isActive) return;
        const nextMap: Record<string, InferenceServerHealth> = {};
        for (const entry of results) {
          nextMap[entry.server_id] = entry;
        }
        setConnectivity(nextMap);
      } catch {
        if (isActive) setConnectivity({});
      }
    };

    const setup = async () => {
      try {
        const config = await getConnectivityConfig();
        const interval = Math.max(1000, config.poll_interval_ms);
        await fetchHealth();
        intervalId = window.setInterval(fetchHealth, interval);
      } catch {
        await fetchHealth();
        intervalId = window.setInterval(fetchHealth, 30000);
      }
    };

    setup();
    return () => {
      isActive = false;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const fetchServers = async () => {
      try {
        const data = await listInferenceServers();
        if (isActive) {
          setServers(data);
          setServersError(false);
        }
      } catch {
        if (isActive) {
          setServersError(true);
        }
      }
    };

    fetchServers();
    const intervalId = window.setInterval(fetchServers, 10000);
    window.addEventListener('inference-servers:updated', fetchServers);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
      window.removeEventListener('inference-servers:updated', fetchServers);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const refreshCounts = async () => {
      const [templatesResult, runsResult] = await Promise.allSettled([
        listTemplates(),
        apiGet<Record<string, unknown>[]>('/runs')
      ]);
      if (!isActive) {
        return;
      }
      setTemplateCount(templatesResult.status === 'fulfilled' ? templatesResult.value.length : null);
      setRunCount(runsResult.status === 'fulfilled' ? runsResult.value.length : null);
    };

    refreshCounts();
    const intervalId = window.setInterval(refreshCounts, 30000);
    window.addEventListener('database:cleared', refreshCounts);
    window.addEventListener('runs:changed', refreshCounts);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
      window.removeEventListener('database:cleared', refreshCounts);
      window.removeEventListener('runs:changed', refreshCounts);
    };
  }, []);

  useEffect(() => {
    if (!showSettings) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    listEnvEntries()
      .then((entries) => {
        setSettingsEntries(entries);
        setSettingsMessage(null);
      })
      .catch((err) => setSettingsError(err instanceof Error ? err.message : 'Unable to load env entries'))
      .finally(() => setSettingsBusy(false));
  }, [showSettings]);

  const sidebarHealth = useMemo(() => {
    const failed = servers.filter((server) => connectivity[server.inference_server.server_id]?.ok === false).length;
    return {
      backend: healthStatus,
      database: dbStatus,
      servers: {
        total: servers.length,
        failed,
        unavailable: serversError
      }
    };
  }, [connectivity, dbStatus, healthStatus, servers, serversError]);

  async function handleClearDb() {
    const confirmed = window.confirm('Clear all database tables? This cannot be undone.');
    if (!confirmed) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await clearDatabase();
      window.dispatchEvent(new CustomEvent('database:cleared'));
      setSettingsMessage('Database cleared.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Unable to clear database');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleSaveEnvEntry(key: string, value: string | null) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const entries = await setEnvEntry(trimmedKey, value);
      setSettingsEntries(entries);
      setSettingsMessage(`${value === null ? 'Removed' : 'Saved'} ${trimmedKey}.`);
      if (trimmedKey === newEnvKey.trim()) {
        setNewEnvKey('');
        setNewEnvValue('');
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Unable to update env entry');
    } finally {
      setSettingsBusy(false);
    }
  }

  function updateEnvValue(key: string, value: string) {
    setSettingsEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, value } : entry))
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        version={packageInfo.version}
        health={sidebarHealth}
        templateCount={templateCount}
        runCount={runCount}
        onSettings={() => setShowSettings(true)}
      />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/catalog?tab=servers" replace />} />
          <Route path="/catalog" element={<CatalogRoute servers={servers} connectivity={connectivity} />} />
          <Route path="/catalog/models/:id" element={<CatalogModelDetailsRoute servers={servers} connectivity={connectivity} />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/run" element={<RunRoute connectivity={connectivity} />} />
          <Route path="/results" element={<ResultsRoute runCount={runCount} />} />
          <Route path="/runs/:id" element={<Navigate to={{ pathname: '/results', search: resultsSearch('history') }} replace />} />
          <Route path="/evaluate" element={<Evaluate />} />
          <Route path="/servers" element={<LegacyRedirect target="servers" />} />
          <Route path="/models" element={<LegacyRedirect target="models" />} />
          <Route path="/run-single" element={<LegacyRedirect target="run-single" />} />
          <Route path="/compare" element={<LegacyRedirect target="compare" />} />
          <Route path="/dashboard" element={<LegacyRedirect target="dashboard" />} />
          <Route path="/leaderboard" element={<LegacyRedirect target="leaderboard" />} />
          <Route path="*" element={<Navigate to="/catalog?tab=servers" replace />} />
        </Routes>
      </main>
      {showSettings ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card settings-card">
            <div className="modal-header">
              <h3>Settings</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowSettings(false)}
                aria-label="Close"
              >
                <span aria-hidden="true">x</span>
              </button>
            </div>
            {settingsError ? <div className="error">{settingsError}</div> : null}
            {settingsMessage ? <p className="muted">{settingsMessage}</p> : null}
            <div className="settings-section">
              <h4>Database</h4>
              <p className="muted">Clear all tables in the current SQLite database.</p>
              <button type="button" onClick={handleClearDb} disabled={settingsBusy}>
                {settingsBusy ? 'Working...' : 'Empty database'}
              </button>
            </div>
            <div className="divider" />
            <div className="settings-section">
              <h4>Environment (.env)</h4>
              <p className="muted">Changes update the .env file at the app root.</p>
              {settingsEntries.length === 0 ? <p className="muted">No env variables found.</p> : null}
              <div className="env-list">
                {settingsEntries.map((entry) => (
                  <div key={entry.key} className="env-row">
                    <div className="env-key">{entry.key}</div>
                    <input
                      value={entry.value}
                      onChange={(event) => updateEnvValue(entry.key, event.target.value)}
                      disabled={settingsBusy}
                    />
                    <button
                      type="button"
                      onClick={() => handleSaveEnvEntry(entry.key, entry.value)}
                      disabled={settingsBusy}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveEnvEntry(entry.key, null)}
                      disabled={settingsBusy}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="env-add">
                <input
                  placeholder="ENV_KEY"
                  value={newEnvKey}
                  onChange={(event) => setNewEnvKey(event.target.value)}
                  disabled={settingsBusy}
                />
                <input
                  placeholder="value"
                  value={newEnvValue}
                  onChange={(event) => setNewEnvValue(event.target.value)}
                  disabled={settingsBusy}
                />
                <button
                  type="button"
                  onClick={() => handleSaveEnvEntry(newEnvKey, newEnvValue)}
                  disabled={settingsBusy || !newEnvKey.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
