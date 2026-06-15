import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import packageInfo from '../package.json' with { type: 'json' };
import { MergedPageHeader } from './components/MergedPageHeader.js';
import { WelcomeCanvas } from './components/Onboarding.js';
import { SettingsModal } from './components/SettingsModal.js';
import { Sidebar } from './components/Sidebar.js';
import { OnboardingProvider } from './onboarding-context.js';
import {
  deriveOnboardingStatus,
  markRibbonDismissed,
  onboardingRouteForStep,
  readOnboardingUiState,
  writeOnboardingUiState,
  type OnboardingUiState
} from './onboarding.js';
import { Catalog } from './pages/Catalog.js';
import { Evaluate } from './pages/Evaluate.js';
import { ModelDetails } from './pages/ModelDetails.js';
import { ResultsUnified } from './pages/ResultsUnified.js';
import { RunUnified } from './pages/RunUnified.js';
import { Templates } from './pages/Templates.js';
import { normalizeResultsTab, resultsSearch } from './navigation.js';
import { apiGet } from './services/api.js';
import { listBenchmarkDocuments, type BenchmarkTestTemplateDocument } from './services/benchmark-api.js';
import { InferenceServerHealth, getConnectivityConfig, getInferenceServerHealth } from './services/connectivity-api.js';
import { InferenceServerRecord, listInferenceServers } from './services/inference-servers-api.js';
import { listModels, type ModelRecord } from './services/models-api.js';
import {
  clearDatabase,
  EnvEntry,
  getAppSettings,
  listEnvEntries,
  setEnvEntry,
  setTemplateAgentModel,
  type AppSettings
} from './services/system-api.js';

type SystemHealthMetrics = {
  db: {
    ok: boolean;
  };
};

function CatalogRoute({
  servers,
  connectivity,
  showWelcome
}: {
  servers: InferenceServerRecord[];
  connectivity: Record<string, InferenceServerHealth>;
  showWelcome: boolean;
}) {
  const [searchParams] = useSearchParams();
  if (showWelcome && searchParams.get('startOnboarding') !== '1') {
    return <WelcomeCanvas />;
  }
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

function RunRoute({
  connectivity,
  onFirstRunSuccess
}: {
  connectivity: Record<string, InferenceServerHealth>;
  onFirstRunSuccess: () => void;
}) {
  return <RunUnified connectivitySnapshot={connectivity} onFirstRunSuccess={onFirstRunSuccess} />;
}

export function App() {
  const navigate = useNavigate();
  const [healthStatus, setHealthStatus] = useState<'unknown' | 'up' | 'down'>('unknown');
  const [dbStatus, setDbStatus] = useState<'unknown' | 'up' | 'down'>('unknown');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsEntries, setSettingsEntries] = useState<EnvEntry[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsModels, setSettingsModels] = useState<ModelRecord[]>([]);
  const [settingsModelsError, setSettingsModelsError] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>({ template_agent_model: null });
  const [servers, setServers] = useState<InferenceServerRecord[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [serversError, setServersError] = useState(false);
  const [connectivity, setConnectivity] = useState<Record<string, InferenceServerHealth>>({});
  const [templateCount, setTemplateCount] = useState<number | null>(null);
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [onboardingUiState, setOnboardingUiState] = useState<OnboardingUiState>(() => readOnboardingUiState());

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
          setServersLoaded(true);
        }
      } catch {
        if (isActive) {
          setServersError(true);
          setServersLoaded(true);
        }
      }
    };

    fetchServers();
    const intervalId = window.setInterval(fetchServers, 10000);
    window.addEventListener('inference-servers:updated', fetchServers);
    window.addEventListener('database:cleared', fetchServers);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
      window.removeEventListener('inference-servers:updated', fetchServers);
      window.removeEventListener('database:cleared', fetchServers);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const refreshCounts = async () => {
      const [templatesResult, modelsResult, runsResult] = await Promise.allSettled([
        listBenchmarkDocuments<BenchmarkTestTemplateDocument>('test_template'),
        listModels(),
        apiGet<Record<string, unknown>[]>('/runs')
      ]);
      if (!isActive) {
        return;
      }
      setTemplateCount(templatesResult.status === 'fulfilled' ? templatesResult.value.length : null);
      setModelCount(modelsResult.status === 'fulfilled' ? modelsResult.value.length : null);
      setRunCount(runsResult.status === 'fulfilled' ? runsResult.value.length : null);
    };

    refreshCounts();
    const intervalId = window.setInterval(refreshCounts, 30000);
    window.addEventListener('database:cleared', refreshCounts);
    window.addEventListener('runs:changed', refreshCounts);
    window.addEventListener('templates:changed', refreshCounts);
    window.addEventListener('inference-servers:updated', refreshCounts);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
      window.removeEventListener('database:cleared', refreshCounts);
      window.removeEventListener('runs:changed', refreshCounts);
      window.removeEventListener('templates:changed', refreshCounts);
      window.removeEventListener('inference-servers:updated', refreshCounts);
    };
  }, []);

  useEffect(() => {
    if (!showSettings) {
      return;
    }
    let isActive = true;
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsModelsError(null);
    Promise.allSettled([listEnvEntries(), listModels(), getAppSettings()])
      .then(([entriesResult, modelsResult, appSettingsResult]) => {
        if (!isActive) return;
        if (entriesResult.status === 'fulfilled') {
          setSettingsEntries(entriesResult.value);
          setSettingsMessage(null);
        } else {
          const reason = entriesResult.reason;
          setSettingsError(reason instanceof Error ? reason.message : 'Unable to load env entries');
        }
        if (modelsResult.status === 'fulfilled') {
          setSettingsModels(modelsResult.value);
        } else {
          const reason = modelsResult.reason;
          setSettingsModelsError(reason instanceof Error ? reason.message : 'Unable to load models');
        }
        if (appSettingsResult.status === 'fulfilled') {
          setAppSettings(appSettingsResult.value);
        } else {
          const reason = appSettingsResult.reason;
          setSettingsError(reason instanceof Error ? reason.message : 'Unable to load app settings');
        }
      })
      .finally(() => {
        if (isActive) setSettingsBusy(false);
      });
    return () => {
      isActive = false;
    };
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

  const onboardingStatus = useMemo(() => {
    return deriveOnboardingStatus({
      serverCount: serversLoaded ? servers.length : 0,
      modelCount: modelCount ?? 0,
      templateCount: templateCount ?? 0,
      uiState: onboardingUiState
    });
  }, [modelCount, onboardingUiState, servers.length, serversLoaded, templateCount]);

  function persistOnboarding(next: OnboardingUiState) {
    const saved = writeOnboardingUiState(next);
    setOnboardingUiState(saved);
  }

  function handleDismissSetup() {
    persistOnboarding({ ...onboardingUiState, dismissedAt: new Date().toISOString(), replaying: false });
  }

  function handleResetOnboarding() {
    const resetState: OnboardingUiState = {
      dismissedAt: undefined,
      completedAt: undefined,
      replaying: false,
      resetBaseline: {
        serverCount: serversLoaded ? servers.length : 0,
        modelCount: modelCount ?? 0,
        templateCount: templateCount ?? 0
      },
      ribbonsDismissed: []
    };
    persistOnboarding(resetState);
    setShowSettings(false);
    const resetStatus = deriveOnboardingStatus({
      serverCount: serversLoaded ? servers.length : 0,
      modelCount: modelCount ?? 0,
      templateCount: templateCount ?? 0,
      uiState: resetState
    });
    navigate(onboardingRouteForStep(resetStatus.step));
  }

  function handleReplayOnboarding() {
    persistOnboarding({
      ...onboardingUiState,
      dismissedAt: undefined,
      completedAt: undefined,
      replaying: true,
      ribbonsDismissed: []
    });
    setShowSettings(false);
    navigate('/welcome');
  }

  function handleCompleteOnboarding() {
    persistOnboarding({
      ...onboardingUiState,
      completedAt: new Date().toISOString(),
      dismissedAt: undefined,
      replaying: false
    });
  }

  function handleDismissRibbon(id: string) {
    persistOnboarding(markRibbonDismissed(onboardingUiState, id));
  }

  const onboardingContext = useMemo(() => ({
    status: onboardingStatus,
    uiState: onboardingUiState,
    dismissSetup: handleDismissSetup,
    resetOnboarding: handleResetOnboarding,
    replayOnboarding: handleReplayOnboarding,
    completeOnboarding: handleCompleteOnboarding,
    dismissRibbon: handleDismissRibbon
  }), [onboardingStatus, onboardingUiState]);

  async function handleClearDb() {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await clearDatabase();
      persistOnboarding({ ribbonsDismissed: [] });
      setServers([]);
      setTemplateCount(0);
      setModelCount(0);
      setRunCount(0);
      window.dispatchEvent(new CustomEvent('database:cleared'));
      setSettingsMessage('Database cleared.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Unable to clear database');
      throw err;
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
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Unable to update env entry');
      throw err;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleSaveTemplateAgentModel(serverId: string, modelId: string) {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const settings = await setTemplateAgentModel({ server_id: serverId, model_id: modelId });
      setAppSettings(settings);
      setSettingsMessage('Saved template agent model.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Unable to update template agent model');
      throw err;
    } finally {
      setSettingsBusy(false);
    }
  }

  return (
    <OnboardingProvider value={onboardingContext}>
      <div className="app-shell">
        <Sidebar
          version={packageInfo.version}
          health={sidebarHealth}
          templateCount={templateCount}
          runCount={runCount}
          onboarding={onboardingStatus.active ? onboardingStatus : undefined}
          onSettings={() => setShowSettings(true)}
        />
        <main className="app-main">
          <Routes>
            <Route path="/" element={onboardingStatus.showWelcome ? <Navigate to="/welcome" replace /> : <Navigate to="/catalog?tab=servers" replace />} />
            <Route path="/welcome" element={<WelcomeCanvas />} />
            <Route path="/catalog" element={<CatalogRoute servers={servers} connectivity={connectivity} showWelcome={onboardingStatus.showWelcome} />} />
            <Route path="/catalog/models/:id" element={<CatalogModelDetailsRoute servers={servers} connectivity={connectivity} />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/run" element={<RunRoute connectivity={connectivity} onFirstRunSuccess={handleCompleteOnboarding} />} />
            <Route path="/results" element={<ResultsRoute runCount={runCount} />} />
            <Route path="/runs/:id" element={<Navigate to={{ pathname: '/results', search: resultsSearch('history') }} replace />} />
            <Route path="/evaluate" element={<Evaluate />} />
            <Route path="*" element={<Navigate to="/catalog?tab=servers" replace />} />
          </Routes>
        </main>
        {showSettings ? (
          <SettingsModal
            entries={settingsEntries}
            busy={settingsBusy}
            error={settingsError}
            message={settingsMessage}
            models={settingsModels}
            modelsError={settingsModelsError}
            appSettings={appSettings}
            onboardingState={onboardingUiState}
            onboardingStatus={onboardingStatus}
            onClose={() => setShowSettings(false)}
            onSaveEntry={handleSaveEnvEntry}
            onSaveTemplateAgentModel={handleSaveTemplateAgentModel}
            onClearDatabase={handleClearDb}
            onResetOnboarding={handleResetOnboarding}
            onReplayOnboarding={handleReplayOnboarding}
          />
        ) : null}
      </div>
    </OnboardingProvider>
  );
}
