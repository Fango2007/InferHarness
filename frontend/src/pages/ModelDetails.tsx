import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { RegLight } from '../components/RegLight.js';
import { ArchitectureLayerNode, ArchitectureTree, getArchitecture, inspectArchitecture, patchSettings } from '../services/architecture-api.js';
import { ModelRecord, listModels } from '../services/models-api.js';
import { InferenceServerRecord, listInferenceServers } from '../services/inference-servers-api.js';
import { ArchitectureTreeView, formatParams } from '../components/ArchitectureTree.js';

const HF_MODEL_ID_RE = /^\/?[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]+$/;
const LOCAL_PATH_KEYS = ['model_path', 'modelPath', 'local_path', 'localPath', 'file_path', 'filePath', 'path'];

function localPathHint(record: ModelRecord): string | null {
  const raw = record.raw ?? {};
  const nestedModel = raw.model && typeof raw.model === 'object' ? (raw.model as Record<string, unknown>) : undefined;
  for (const source of [raw, nestedModel]) {
    if (!source) continue;
    for (const key of LOCAL_PATH_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

function isInspectable(record: ModelRecord | null, modelId: string): boolean {
  if (!record) return HF_MODEL_ID_RE.test(modelId);
  if (record.architecture.format === 'GGUF') return Boolean(localPathHint(record));
  if (record.architecture.format === 'MLX') return HF_MODEL_ID_RE.test(modelId) || Boolean(localPathHint(record));
  if (record.architecture.format === 'SafeTensors') return HF_MODEL_ID_RE.test(modelId) || Boolean(localPathHint(record));
  if (record.architecture.format === 'GPTQ' || record.architecture.format === 'AWQ') return HF_MODEL_ID_RE.test(modelId) || Boolean(localPathHint(record));
  return HF_MODEL_ID_RE.test(modelId);
}

function inspectionErrorFrom(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const maybeError = err as { code?: unknown; error?: unknown; message?: unknown };
    const code = typeof maybeError.code === 'string' && maybeError.code.trim() ? maybeError.code.trim() : 'unknown';
    const message = [maybeError.error, maybeError.message].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    return { code, message: message?.trim() ?? 'Architecture inspection failed.' };
  }
  if (err instanceof Error && err.message.trim()) return { code: 'unknown', message: err.message.trim() };
  return { code: 'unknown', message: 'Architecture inspection failed.' };
}

function childFocusPath(parent: string, child: ArchitectureLayerNode): string {
  const name = child.name.trim();
  if (!name) return parent;
  return parent ? `${parent}.${name}` : name;
}

function collectNodePaths(node: ArchitectureLayerNode, path: string, out: Array<{ path: string; node: ArchitectureLayerNode }>) {
  out.push({ path, node });
  for (const child of node.children) {
    collectNodePaths(child, childFocusPath(path, child), out);
  }
}

function findNodeByPath(root: ArchitectureLayerNode, focusPath: string | null): { node: ArchitectureLayerNode; path: string } {
  const nodes: Array<{ path: string; node: ArchitectureLayerNode }> = [];
  collectNodePaths(root, '', nodes);
  if (!focusPath) return nodes[0];
  return nodes.find((entry) => entry.path === focusPath)
    ?? nodes.find((entry) => entry.path.endsWith(`.${focusPath}`))
    ?? nodes[0];
}

function valueFromRaw(raw: unknown, keys: string[]): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  for (const nestedKey of ['config', 'model', 'architecture']) {
    const nested = record[nestedKey];
    if (nested && typeof nested === 'object') {
      const value = valueFromRaw(nested, keys);
      if (value != null) return value;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString();
  if (typeof value === 'boolean') return String(value);
  return null;
}

function flattenConfig(value: unknown, prefix = '', out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (!value || typeof value !== 'object' || depth > 2) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (raw == null) continue;
    if (Array.isArray(raw)) {
      out.push([path, raw.length > 8 ? `[${raw.slice(0, 8).join(', ')}, ...]` : JSON.stringify(raw)]);
    } else if (typeof raw === 'object') {
      flattenConfig(raw, path, out, depth + 1);
    } else {
      out.push([path, String(raw)]);
    }
  }
  return out;
}

function configEntries(record: ModelRecord | null, tree: ArchitectureTree | null): Array<[string, string]> {
  const rawEntries = flattenConfig(record?.raw ?? {});
  const curated: Array<[string, string]> = [
    ['model_id', record?.model.model_id ?? tree?.model_id ?? 'unknown'],
    ['format', record?.architecture.format ?? tree?.format ?? 'unknown'],
    ['provider', record?.identity.provider ?? 'unknown'],
    ['precision', record?.architecture.precision ?? 'unknown'],
    ['quantisation.method', record?.architecture.quantisation.method ?? 'unknown'],
    ['quantisation.bits', stringValue(record?.architecture.quantisation.bits) ?? 'unknown'],
    ['limits.context_window_tokens', stringValue(record?.limits.context_window_tokens) ?? 'unknown'],
    ['limits.max_output_tokens', stringValue(record?.limits.max_output_tokens) ?? 'unknown']
  ];
  const seen = new Set<string>();
  return [...curated, ...rawEntries]
    .filter(([key]) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80);
}

function serverState(server: InferenceServerRecord | null): 'healthy' | 'down' | 'unknown' {
  if (!server) return 'unknown';
  return server.inference_server.active && !server.inference_server.archived ? 'healthy' : 'down';
}

interface ModelDetailsProps {
  serverId: string;
  modelId: string;
  onBack: () => void;
}

type InspectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; tree: ArchitectureTree }
  | { status: 'error'; code: string; message: string };

type SideTab = 'config' | 'tokenizer' | 'runs' | 'readme';

export function ModelDetails({ serverId, modelId, onBack }: ModelDetailsProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [record, setRecord] = useState<ModelRecord | null>(null);
  const [server, setServer] = useState<InferenceServerRecord | null>(null);
  const [inspection, setInspection] = useState<InspectionState>({ status: 'idle' });
  const [showTrustSection, setShowTrustSection] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustEnabled, setTrustEnabled] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>('config');

  const focusPath = searchParams.get('focus');

  useEffect(() => {
    Promise.all([listModels(), listInferenceServers()])
      .then(([records, servers]) => {
        setRecord(records.find((r) => r.model.server_id === serverId && r.model.model_id === modelId) ?? null);
        setServer(servers.find((candidate) => candidate.inference_server.server_id === serverId) ?? null);
      })
      .catch(() => {
        setRecord(null);
        setServer(null);
      });
  }, [serverId, modelId]);

  useEffect(() => {
    let active = true;
    setInspection({ status: 'loading' });
    getArchitecture(serverId, modelId)
      .catch(() => inspectArchitecture(serverId, modelId))
      .then((tree) => {
        if (active) setInspection({ status: 'done', tree });
      })
      .catch((err) => {
        if (!active) return;
        const apiErr = inspectionErrorFrom(err);
        if (apiErr.code === 'unregistered_architecture') setShowTrustSection(true);
        setInspection({ status: 'error', code: apiErr.code, message: apiErr.message });
      });
    return () => {
      active = false;
    };
  }, [serverId, modelId]);

  async function handleInspect() {
    setInspection({ status: 'loading' });
    setShowTrustSection(false);
    try {
      const tree = await inspectArchitecture(serverId, modelId);
      setInspection({ status: 'done', tree });
    } catch (err) {
      const apiErr = inspectionErrorFrom(err);
      if (apiErr.code === 'unregistered_architecture') setShowTrustSection(true);
      setInspection({ status: 'error', code: apiErr.code, message: apiErr.message });
    }
  }

  async function handleEnableTrust() {
    setTrustBusy(true);
    try {
      await patchSettings(serverId, modelId, { trust_remote_code: true });
      setTrustEnabled(true);
    } finally {
      setTrustBusy(false);
    }
  }

  const inspectable = isInspectable(record, modelId);
  const tree = inspection.status === 'done' ? inspection.tree : null;
  const focused = useMemo(() => tree ? findNodeByPath(tree.root, focusPath) : null, [tree, focusPath]);
  const focusedNode = focused?.node ?? null;
  const focusedPath = focused?.path ?? '';
  const configRows = useMemo(() => configEntries(record, tree), [record, tree]);
  const hiddenSize = stringValue(valueFromRaw(record?.raw, ['hidden_size', 'hiddenSize', 'n_embd']));
  const vocabSize = stringValue(valueFromRaw(record?.raw, ['vocab_size', 'vocabSize', 'n_vocab']));
  const layerCount = stringValue(valueFromRaw(record?.raw, ['num_hidden_layers', 'numHiddenLayers', 'n_layer']))
    ?? (tree ? String(tree.summary.by_type.reduce((sum, entry) => sum + (entry.type.toLowerCase().includes('layer') ? entry.count : 0), 0) || tree.summary.by_type.reduce((sum, entry) => sum + entry.count, 0)) : null);
  const serverLabel = server?.inference_server.display_name ?? serverId;
  const serverUrl = server?.endpoints.base_url ?? serverId;
  const stats = [
    ['Params', tree ? formatParams(tree.summary.total_parameters) : record?.architecture.parameter_count ? formatParams(record.architecture.parameter_count) : 'N/A'],
    ['Trainable', tree ? formatParams(tree.summary.trainable_parameters) : 'N/A'],
    ['Layers', layerCount ?? 'N/A'],
    ['Hidden size', hiddenSize ?? 'N/A'],
    ['Vocab size', vocabSize ?? 'N/A']
  ];

  function updateFocus(path: string) {
    const next = new URLSearchParams(searchParams);
    if (path) {
      next.set('focus', path);
    } else {
      next.delete('focus');
    }
    setSearchParams(next);
  }

  return (
    <section className="model-inspector">
      <header className="model-inspector-header">
        <div className="model-inspector-topline">
          <button type="button" className="btn btn--ghost" onClick={onBack}>← Back to Catalog</button>
          <span className="label--uppercase">Model · Inspect</span>
          <div className="model-inspector-actions">
            {inspectable ? <button type="button" className="btn btn--ghost" onClick={handleInspect}>Inspect Architecture</button> : null}
            <button type="button" onClick={() => navigate(`/run?serverId=${encodeURIComponent(serverId)}&modelId=${encodeURIComponent(modelId)}`)}>Run a test</button>
          </div>
        </div>
        <div className="model-inspector-title">
          <h2>{modelId}</h2>
          <span className="model-inspector-server">
            <RegLight state={serverState(server)} label={serverLabel} compact />
            <span>{serverLabel}</span>
            <small>{serverUrl}</small>
          </span>
        </div>
        <div className="model-inspector-stats">
          {stats.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div className="model-inspector-path">
          <span>path:</span>
          <button type="button" onClick={() => updateFocus('')}>{'<root>'}</button>
          {focusedPath ? focusedPath.split('.').map((part, index) => (
            <strong key={`${part}-${index}`}>{part}</strong>
          )) : null}
        </div>
      </header>

      {!inspectable ? (
        <div className="catalog-empty">
          <h3>Architecture inspection is not available</h3>
          <p>This model needs a Hugging Face-style ID or a local path hint before it can be inspected.</p>
        </div>
      ) : inspection.status === 'loading' ? (
        <div className="catalog-empty"><h3>Inspecting architecture...</h3><p>This may take up to 30 seconds.</p></div>
      ) : inspection.status === 'error' ? (
        <div className="error model-inspector-error">
          <strong>Architecture inspection failed.</strong>
          <p>{inspection.code === 'hf_token_required' ? 'This model requires a Hugging Face API token. Add your token in Settings → Environment.' : inspection.message}</p>
          {inspection.code !== 'unknown' ? <p className="muted">Error code: {inspection.code}</p> : null}
          <div className="actions">
            <button type="button" onClick={handleInspect}>Retry</button>
          </div>
          {showTrustSection ? (
            <label className="checkbox">
              <input type="checkbox" checked={trustEnabled} disabled={trustBusy} onChange={async (event) => {
                if (event.target.checked) await handleEnableTrust();
              }} />
              Allow remote code execution for this model
            </label>
          ) : null}
        </div>
      ) : tree ? (
        <div className="model-inspector-grid">
          <aside className="model-inspector-tree">
            <ArchitectureTreeView
              root={tree.root}
              summary={tree.summary}
              accuracy={tree.accuracy}
              inspectionMethod={tree.inspection_method}
              warnings={tree.warnings}
              selectedPath={focusPath}
              onSelect={updateFocus}
              showSummary={false}
            />
          </aside>
          <main className="model-inspector-detail">
            <span className="label--uppercase">{focusedNode?.type ?? 'Root'} · selected node</span>
            <h3>{focusedNode?.name || '<root>'}</h3>
            <p className="model-inspector-node-path">{focusedPath || '<root>'}</p>
            <div className="model-node-stats">
              <div><span>Parameters</span><strong>{focusedNode ? formatParams(focusedNode.parameters) : 'N/A'}</strong></div>
              <div><span>Shape</span><strong>{focusedNode?.shape ? `[${focusedNode.shape.join(' x ')}]` : 'N/A'}</strong></div>
              <div><span>Dtype</span><strong>{record?.architecture.precision ?? tree.format}</strong></div>
              <div><span>Children</span><strong>{focusedNode?.children.length ?? 0}</strong></div>
            </div>
            <div className="model-share-card">
              <div>
                <span>Share of total parameters</span>
                <strong>
                  {focusedNode ? `${formatParams(focusedNode.parameters)} / ${formatParams(tree.summary.total_parameters)}` : 'N/A'}
                </strong>
              </div>
              <div className="model-share-bar">
                <i style={{ width: `${Math.max(0.5, Math.min(100, focusedNode && tree.summary.total_parameters ? (focusedNode.parameters / tree.summary.total_parameters) * 100 : 0))}%` }} />
              </div>
            </div>
            <h4 className="model-inspector-section-title">Configuration</h4>
            <div className="details-grid">
              {configRows.map(([key, value]) => (
                <div key={key} className="detail-row"><span>{key}</span><strong>{value}</strong></div>
              ))}
            </div>
          </main>
          <aside className="model-inspector-side">
            <div className="details-tabs">
              {(['config', 'tokenizer', 'runs', 'readme'] as SideTab[]).map((tab) => (
                <button key={tab} type="button" className={sideTab === tab ? 'active' : undefined} onClick={() => setSideTab(tab)}>
                  <span className="details-tab-name">{tab === 'config' ? 'Config JSON' : tab}</span>
                </button>
              ))}
            </div>
            {sideTab === 'config' ? (
              <pre className="code-block">{JSON.stringify({ record, architecture: tree }, null, 2)}</pre>
            ) : (
              <div className="catalog-empty">
                <h3>{sideTab === 'runs' ? 'Recent runs' : sideTab}</h3>
                <p>No {sideTab === 'runs' ? 'recent run' : sideTab} data is available for this model yet.</p>
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
