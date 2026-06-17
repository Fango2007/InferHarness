import { useEffect, useMemo, useRef, useState } from 'react';

import {
  BenchmarkOperation,
  BenchmarkTestTemplateDocument,
  BenchmarkTestTemplateRecord
} from '../services/benchmark-api.js';

interface TemplateEditorProps {
  template: BenchmarkTestTemplateRecord | null;
  initialDocument?: BenchmarkTestTemplateDocument | null;
  onSave: (input: BenchmarkTestTemplateDocument, isUpdate: boolean) => Promise<void>;
  onDraftChange?: (input: BenchmarkTestTemplateDocument) => void;
  error?: string | null;
  busy?: boolean;
  embedded?: boolean;
}

type StageType = 'dataset_loop' | 'single_request' | 'paired_request_loop';
type StageOrder = 'sequential' | 'random';
type PairRole = '' | 'baseline' | 'comparison' | 'control' | 'variant' | 'technical';

interface PairMemberEditor {
  id: string;
  role: PairRole;
}

interface DerivedMetricEditor {
  id: string;
  left: string;
  right: string;
  unit: string;
}

const OPERATIONS: BenchmarkOperation[] = ['chat_completion', 'completion', 'embedding', 'list_models', 'healthcheck'];
const ADDITIONAL_CAPABILITIES = [
  'streaming',
  'tool_calling',
  'structured_output'
] as const;
const STAGE_TYPES: StageType[] = ['dataset_loop', 'single_request', 'paired_request_loop'];
const STAGE_ORDERS: StageOrder[] = ['sequential', 'random'];
const PAIR_ROLES: PairRole[] = ['', 'baseline', 'comparison', 'control', 'variant', 'technical'];
const METRICS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'elapsed_ms',
  'first_token_ms',
  'tokens_per_second',
  'decode_tokens_per_second',
  'prefill_tokens_per_second',
  'output_input_token_ratio',
  'tool_call_count',
  'tool_selected_correctly',
  'tool_arguments_valid',
  'missing_tool_call',
  'hallucinated_tool_call',
  'json_valid',
  'schema_valid',
  'regex_match',
  'exact_match',
  'contains_required_terms'
] as const;
const AGGREGATIONS = ['mean', 'median', 'min', 'max', 'sum', 'count', 'p50', 'p90', 'p95', 'p99', 'stddev', 'variance'] as const;
const DEFAULT_PAIR_MEMBERS: PairMemberEditor[] = [
  { id: 'cold', role: 'baseline' },
  { id: 'hot', role: 'comparison' }
];
const DEFAULT_DERIVED_METRIC: DerivedMetricEditor = {
  id: 'cold_penalty_ms',
  left: 'cold.elapsed_ms',
  right: 'hot.elapsed_ms',
  unit: 'ms'
};

const DEFAULT_BENCHMARK_TEMPLATE: BenchmarkTestTemplateDocument = {
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

const MODELED_STAGE_KEYS = new Set([
  'id',
  'type',
  'iterations_per_item',
  'record_metrics',
  'order',
  'cooldown_ms',
  'pre_iteration_delay_ms',
  'intra_pair_delay_ms',
  'pair',
  'derived_metrics',
  'observability',
  'stop_on_error'
]);

function stringifyDocument(document: BenchmarkTestTemplateDocument): string {
  return JSON.stringify(document, null, 2);
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinCsv(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(', ') : '';
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metricSelection(document: BenchmarkTestTemplateDocument): string[] {
  return Array.isArray(document.metrics) ? document.metrics.filter((metric) => typeof metric === 'string') : [];
}

function aggregationSelection(document: BenchmarkTestTemplateDocument): string[] {
  return Array.isArray(document.aggregations) ? document.aggregations.filter((entry) => typeof entry === 'string') : [];
}

function builtInMetricSelection(document: BenchmarkTestTemplateDocument): string[] {
  return metricSelection(document).filter((metric) => (METRICS as readonly string[]).includes(metric));
}

function customMetricSelection(document: BenchmarkTestTemplateDocument): string {
  return metricSelection(document)
    .filter((metric) => !(METRICS as readonly string[]).includes(metric))
    .join(', ');
}

function unmodeledStageFields(stage: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(stage).filter(([key]) => !MODELED_STAGE_KEYS.has(key)));
}

function pairMembersFromStage(stage: Record<string, unknown>): PairMemberEditor[] {
  if (!Array.isArray(stage.pair)) {
    return DEFAULT_PAIR_MEMBERS;
  }
  const members = stage.pair
    .filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === 'object' && !Array.isArray(member))
    .map((member) => ({
      id: typeof member.id === 'string' ? member.id : '',
      role: PAIR_ROLES.includes(member.role as PairRole) ? member.role as PairRole : ''
    }))
    .filter((member) => member.id.trim().length > 0);
  return members.length >= 2 ? members : DEFAULT_PAIR_MEMBERS;
}

function derivedMetricsFromStage(stage: Record<string, unknown>): DerivedMetricEditor[] {
  if (!Array.isArray(stage.derived_metrics)) {
    return [];
  }
  return stage.derived_metrics
    .filter((metric): metric is Record<string, unknown> => Boolean(metric) && typeof metric === 'object' && !Array.isArray(metric))
    .map((metric) => ({
      id: typeof metric.id === 'string' ? metric.id : '',
      left: typeof metric.left === 'string' ? metric.left : '',
      right: typeof metric.right === 'string' ? metric.right : '',
      unit: typeof metric.unit === 'string' ? metric.unit : ''
    }))
    .filter((metric) => metric.id.trim() || metric.left.trim() || metric.right.trim() || metric.unit.trim());
}

function buildPairMembers(members: PairMemberEditor[]): Array<Record<string, unknown>> {
  return members
    .map((member) => ({ id: member.id.trim(), role: member.role }))
    .filter((member) => member.id)
    .map((member) => ({
      id: member.id,
      ...(member.role ? { role: member.role } : {}),
      request: { reuse: 'default' }
    }));
}

function buildDerivedMetrics(metrics: DerivedMetricEditor[]): Array<Record<string, unknown>> {
  return metrics
    .map((metric) => ({
      id: metric.id.trim(),
      type: 'difference',
      left: metric.left.trim(),
      right: metric.right.trim(),
      unit: metric.unit.trim()
    }))
    .filter((metric) => metric.id && metric.left && metric.right)
    .map((metric) => ({
      id: metric.id,
      type: 'difference',
      left: metric.left,
      right: metric.right,
      ...(metric.unit ? { unit: metric.unit } : {})
    }));
}

function normalizeForEditor(document: BenchmarkTestTemplateDocument): BenchmarkTestTemplateDocument {
  const stage = objectOrEmpty(document.stages?.[0]);
  const contract = objectOrEmpty(document.input_contract);
  const stageType = STAGE_TYPES.includes(stage.type as StageType) ? stage.type as StageType : 'dataset_loop';
  const observability = objectOrEmpty(stage.observability);
  const pairedStageFields = stageType === 'paired_request_loop'
    ? {
        pre_iteration_delay_ms: numberOrDefault(stage.pre_iteration_delay_ms, 0),
        intra_pair_delay_ms: numberOrDefault(stage.intra_pair_delay_ms, 0),
        pair: buildPairMembers(pairMembersFromStage(stage)),
        derived_metrics: buildDerivedMetrics(derivedMetricsFromStage(stage)),
        ...(Object.keys(observability).length > 0 ? { observability } : {})
      }
    : {};

  return {
    kind: 'test_template',
    schema_version: 'benchmark_test_template_v1',
    template_id: document.template_id.trim(),
    template_version: document.template_version.trim(),
    name: (document.name ?? document.template_id).trim(),
    description: (document.description ?? '').trim(),
    operation: document.operation,
    required_capabilities: normalizeCapabilities(document.operation, objectOrEmpty(document.required_capabilities)),
    input_contract: {
      required_fields: Array.isArray(contract.required_fields) ? contract.required_fields.filter((entry): entry is string => typeof entry === 'string') : [],
      optional_fields: Array.isArray(contract.optional_fields) ? contract.optional_fields.filter((entry): entry is string => typeof entry === 'string') : [],
      min_items: numberOrDefault(contract.min_items, 1)
    },
    stages: [
      {
        ...unmodeledStageFields(stage),
        id: typeof stage.id === 'string' ? stage.id.trim() : 'chat',
        type: stageType,
        iterations_per_item: numberOrDefault(stage.iterations_per_item, 1),
        record_metrics: booleanOrDefault(stage.record_metrics, true),
        order: STAGE_ORDERS.includes(stage.order as StageOrder) ? stage.order as StageOrder : 'sequential',
        cooldown_ms: numberOrDefault(stage.cooldown_ms, 0),
        ...pairedStageFields,
        stop_on_error: booleanOrDefault(stage.stop_on_error, false)
      }
    ],
    metrics: [...new Set([...builtInMetricSelection(document), ...splitCsv(customMetricSelection(document))])],
    aggregations: aggregationSelection(document),
    metadata: objectOrEmpty(document.metadata),
    extensions: objectOrEmpty(document.extensions)
  };
}

function normalizeCapabilities(operation: BenchmarkOperation, value: Record<string, unknown>): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  for (const capability of OPERATIONS) {
    capabilities[capability] = capability === operation;
  }
  for (const capability of ADDITIONAL_CAPABILITIES) {
    capabilities[capability] = value[capability] === true;
  }
  return capabilities;
}

export function TemplateEditor({ template, initialDocument, onSave, onDraftChange, error, busy, embedded = false }: TemplateEditorProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [operation, setOperation] = useState<BenchmarkOperation>('chat_completion');
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [requiredFields, setRequiredFields] = useState('prompt');
  const [optionalFields, setOptionalFields] = useState('system_prompt');
  const [minItems, setMinItems] = useState(1);
  const [stageId, setStageId] = useState('chat');
  const [stageType, setStageType] = useState<StageType>('dataset_loop');
  const [iterationsPerItem, setIterationsPerItem] = useState(1);
  const [recordMetrics, setRecordMetrics] = useState(true);
  const [stageOrder, setStageOrder] = useState<StageOrder>('sequential');
  const [cooldownMs, setCooldownMs] = useState(0);
  const [preIterationDelayMs, setPreIterationDelayMs] = useState(0);
  const [intraPairDelayMs, setIntraPairDelayMs] = useState(0);
  const [pairMembers, setPairMembers] = useState<PairMemberEditor[]>(DEFAULT_PAIR_MEMBERS);
  const [derivedMetrics, setDerivedMetrics] = useState<DerivedMetricEditor[]>([]);
  const [observabilityJson, setObservabilityJson] = useState('{}');
  const [stopOnError, setStopOnError] = useState(false);
  const [stageExtras, setStageExtras] = useState<Record<string, unknown>>({});
  const [metrics, setMetrics] = useState<string[]>([]);
  const [customMetrics, setCustomMetrics] = useState('');
  const [aggregations, setAggregations] = useState<string[]>([]);
  const [metadataJson, setMetadataJson] = useState('{}');
  const [extensionsJson, setExtensionsJson] = useState('{}');
  const [rawJson, setRawJson] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const lastEmittedDraft = useRef('');
  const lastLoadedDocument = useRef('');
  const skipNextDraftEmission = useRef(false);

  function loadDocument(document: BenchmarkTestTemplateDocument): void {
    const documentJson = stringifyDocument(normalizeForEditor(document));
    if (documentJson === lastLoadedDocument.current) return;
    lastLoadedDocument.current = documentJson;
    skipNextDraftEmission.current = true;
    const stage = objectOrEmpty(document.stages?.[0]);
    const contract = objectOrEmpty(document.input_contract);
    setId(document.template_id);
    setName(document.name ?? document.template_id);
    setVersion(document.template_version);
    setDescription(document.description ?? '');
    setOperation(document.operation);
    setCapabilities(normalizeCapabilities(document.operation, objectOrEmpty(document.required_capabilities)));
    setRequiredFields(joinCsv(contract.required_fields));
    setOptionalFields(joinCsv(contract.optional_fields));
    setMinItems(numberOrDefault(contract.min_items, 1));
    setStageId(typeof stage.id === 'string' ? stage.id : 'chat');
    setStageType(STAGE_TYPES.includes(stage.type as StageType) ? stage.type as StageType : 'dataset_loop');
    setIterationsPerItem(numberOrDefault(stage.iterations_per_item, 1));
    setRecordMetrics(booleanOrDefault(stage.record_metrics, true));
    setStageOrder(STAGE_ORDERS.includes(stage.order as StageOrder) ? stage.order as StageOrder : 'sequential');
    setCooldownMs(numberOrDefault(stage.cooldown_ms, 0));
    setPreIterationDelayMs(numberOrDefault(stage.pre_iteration_delay_ms, 0));
    setIntraPairDelayMs(numberOrDefault(stage.intra_pair_delay_ms, 0));
    setPairMembers(pairMembersFromStage(stage));
    setDerivedMetrics(derivedMetricsFromStage(stage));
    setObservabilityJson(JSON.stringify(objectOrEmpty(stage.observability), null, 2));
    setStopOnError(booleanOrDefault(stage.stop_on_error, false));
    setStageExtras(unmodeledStageFields(stage));
    setMetrics(builtInMetricSelection(document));
    setCustomMetrics(customMetricSelection(document));
    setAggregations(aggregationSelection(document));
    setMetadataJson(JSON.stringify(objectOrEmpty(document.metadata), null, 2));
    setExtensionsJson(JSON.stringify(objectOrEmpty(document.extensions), null, 2));
    setRawJson(stringifyDocument(document));
  }

  useEffect(() => {
    loadDocument(initialDocument ?? template?.document ?? DEFAULT_BENCHMARK_TEMPLATE);
  }, [initialDocument, template]);

  const isUpdate = Boolean(template);

  const structuredDocument = useMemo((): BenchmarkTestTemplateDocument => {
    let metadata: Record<string, unknown> = {};
    let extensions: Record<string, unknown> = {};
    let observability: Record<string, unknown> = {};
    try {
      metadata = objectOrEmpty(JSON.parse(metadataJson));
    } catch {
      metadata = {};
    }
    try {
      extensions = objectOrEmpty(JSON.parse(extensionsJson));
    } catch {
      extensions = {};
    }
    try {
      observability = objectOrEmpty(JSON.parse(observabilityJson));
    } catch {
      observability = {};
    }

    const customMetricIds = splitCsv(customMetrics);
    const pairedStageFields = stageType === 'paired_request_loop'
      ? {
          pre_iteration_delay_ms: preIterationDelayMs,
          intra_pair_delay_ms: intraPairDelayMs,
          pair: buildPairMembers(pairMembers),
          derived_metrics: buildDerivedMetrics(derivedMetrics),
          ...(Object.keys(observability).length > 0 ? { observability } : {})
        }
      : {};

    return {
      kind: 'test_template',
      schema_version: 'benchmark_test_template_v1',
      template_id: id.trim(),
      template_version: version.trim(),
      name: name.trim(),
      description: description.trim(),
      operation,
      required_capabilities: normalizeCapabilities(operation, capabilities),
      input_contract: {
        required_fields: splitCsv(requiredFields),
        optional_fields: splitCsv(optionalFields),
        min_items: minItems
      },
      stages: [
        {
          ...stageExtras,
          id: stageId.trim(),
          type: stageType,
          iterations_per_item: iterationsPerItem,
          record_metrics: recordMetrics,
          order: stageOrder,
          cooldown_ms: cooldownMs,
          ...pairedStageFields,
          stop_on_error: stopOnError
        }
      ],
      metrics: [...new Set([...metrics, ...customMetricIds])],
      aggregations,
      metadata,
      extensions
    };
  }, [
    aggregations,
    capabilities,
    cooldownMs,
    customMetrics,
    description,
    derivedMetrics,
    extensionsJson,
    id,
    intraPairDelayMs,
    iterationsPerItem,
    metadataJson,
    metrics,
    minItems,
    name,
    observabilityJson,
    operation,
    optionalFields,
    pairMembers,
    preIterationDelayMs,
    recordMetrics,
    requiredFields,
    stageExtras,
    stageId,
    stageOrder,
    stageType,
    stopOnError,
    version
  ]);

  useEffect(() => {
    if (!onDraftChange) return;
    const nextDraft = stringifyDocument(structuredDocument);
    if (nextDraft === lastLoadedDocument.current) {
      skipNextDraftEmission.current = false;
      lastEmittedDraft.current = nextDraft;
      return;
    }
    if (skipNextDraftEmission.current) {
      skipNextDraftEmission.current = false;
      return;
    }
    if (nextDraft === lastEmittedDraft.current) return;
    lastEmittedDraft.current = nextDraft;
    lastLoadedDocument.current = nextDraft;
    onDraftChange(structuredDocument);
  }, [onDraftChange, structuredDocument]);

  function toggleCapability(key: string): void {
    setCapabilities((current) => ({ ...current, [key]: !current[key] }));
  }

  function toggleMetric(metric: string): void {
    setMetrics((current) =>
      current.includes(metric) ? current.filter((entry) => entry !== metric) : [...current, metric]
    );
  }

  function toggleAggregation(aggregation: string): void {
    setAggregations((current) =>
      current.includes(aggregation) ? current.filter((entry) => entry !== aggregation) : [...current, aggregation]
    );
  }

  function updatePairMember(index: number, updates: Partial<PairMemberEditor>): void {
    setPairMembers((current) => current.map((member, memberIndex) => (
      memberIndex === index ? { ...member, ...updates } : member
    )));
  }

  function addPairMember(): void {
    setPairMembers((current) => [...current, { id: `member_${current.length + 1}`, role: '' }]);
  }

  function removePairMember(index: number): void {
    setPairMembers((current) => current.filter((_, memberIndex) => memberIndex !== index));
  }

  function updateDerivedMetric(index: number, updates: Partial<DerivedMetricEditor>): void {
    setDerivedMetrics((current) => current.map((metric, metricIndex) => (
      metricIndex === index ? { ...metric, ...updates } : metric
    )));
  }

  function addDerivedMetric(): void {
    setDerivedMetrics((current) => [...current, current.length === 0 ? DEFAULT_DERIVED_METRIC : { id: '', left: '', right: '', unit: '' }]);
  }

  function removeDerivedMetric(index: number): void {
    setDerivedMetrics((current) => current.filter((_, metricIndex) => metricIndex !== index));
  }

  function openRawDrawer(): void {
    setRawJson(stringifyDocument(structuredDocument));
    setDrawerOpen(true);
    setLocalError(null);
  }

  function applyRawJson(): void {
    setLocalError(null);
    try {
      const parsed = JSON.parse(rawJson) as BenchmarkTestTemplateDocument;
      loadDocument({
        ...parsed,
        kind: 'test_template',
        schema_version: 'benchmark_test_template_v1'
      });
      setDrawerOpen(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Unable to parse benchmark template JSON');
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    if ([...metrics, ...splitCsv(customMetrics)].length === 0) {
      setLocalError('Select at least one required metric.');
      return;
    }
    if (aggregations.length === 0) {
      setLocalError('Select at least one required aggregation.');
      return;
    }
    try {
      JSON.parse(metadataJson);
      JSON.parse(extensionsJson);
      JSON.parse(observabilityJson);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Metadata, observability, and extensions must be valid JSON objects.');
      return;
    }
    if (stageType === 'paired_request_loop') {
      if (buildPairMembers(pairMembers).length < 2) {
        setLocalError('Paired stages require at least two pair members.');
        return;
      }
      const incompleteMetric = derivedMetrics.some((metric) =>
        Boolean(metric.id.trim() || metric.left.trim() || metric.right.trim() || metric.unit.trim())
        && (!metric.id.trim() || !metric.left.trim() || !metric.right.trim())
      );
      if (incompleteMetric) {
        setLocalError('Derived metrics require ID, left metric, and right metric.');
        return;
      }
    }
    await onSave(structuredDocument, isUpdate);
  }

  return (
    <>
      <form onSubmit={handleSubmit} className={embedded ? 'template-editor-card template-editor-card--embedded' : 'template-editor-card'}>
        {!embedded ? (
          <div className="template-editor-header">
            <h2>{isUpdate ? 'Edit benchmark template' : 'Create benchmark template'}</h2>
            <button type="button" className="btn btn--ghost" onClick={openRawDrawer} disabled={busy}>
              Raw JSON
            </button>
          </div>
        ) : null}
        {error || localError ? <div className="error">{error ?? localError}</div> : null}

        <div className="template-editor-grid">
          <label className="template-field--schema-required">
            Template ID
            <input value={id} onChange={(event) => setId(event.target.value)} disabled={isUpdate || busy} required />
          </label>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
          </label>
          <label className="template-field--schema-required">
            Operation
            <select value={operation} onChange={(event) => setOperation(event.target.value as BenchmarkOperation)} disabled={busy} required>
              {OPERATIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="template-field--schema-required">
            Version
            <input value={version} onChange={(event) => setVersion(event.target.value)} disabled={busy} required />
          </label>
        </div>

        <label>
          Description
          <input value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
        </label>

        <section className="template-editor-section">
          <h3>Additional capabilities</h3>
          <div className="template-check-grid">
            {ADDITIONAL_CAPABILITIES.map((capability) => (
              <label key={capability} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={capabilities[capability] === true}
                  onChange={() => toggleCapability(capability)}
                  disabled={busy}
                />
                {capability}
              </label>
            ))}
          </div>
        </section>

        <section className="template-editor-section">
          <h3>Input contract</h3>
          <div className="template-editor-grid">
            <label>
              Required fields
              <input value={requiredFields} onChange={(event) => setRequiredFields(event.target.value)} disabled={busy} />
            </label>
            <label>
              Optional fields
              <input value={optionalFields} onChange={(event) => setOptionalFields(event.target.value)} disabled={busy} />
            </label>
            <label>
              Minimum items per dataset
              <input type="number" min={0} value={minItems} onChange={(event) => setMinItems(Number(event.target.value))} disabled={busy} />
            </label>
          </div>
        </section>

        <section className="template-editor-section">
          <h3>Stage</h3>
          <div className="template-editor-grid">
            <label className="template-field--schema-required">
              Stage ID
              <input value={stageId} onChange={(event) => setStageId(event.target.value)} disabled={busy} required />
            </label>
            <label className="template-field--schema-required">
              Stage type
              <select value={stageType} onChange={(event) => setStageType(event.target.value as StageType)} disabled={busy} required>
                {STAGE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              Iterations per item
              <input type="number" min={1} value={iterationsPerItem} onChange={(event) => setIterationsPerItem(Number(event.target.value))} disabled={busy} />
            </label>
            <label>
              Order
              <select value={stageOrder} onChange={(event) => setStageOrder(event.target.value as StageOrder)} disabled={busy}>
                {STAGE_ORDERS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              Cooldown ms
              <input type="number" min={0} value={cooldownMs} onChange={(event) => setCooldownMs(Number(event.target.value))} disabled={busy} />
            </label>
          </div>
          <div className="template-check-grid">
            <label className="checkbox-row">
              <input type="checkbox" checked={recordMetrics} onChange={(event) => setRecordMetrics(event.target.checked)} disabled={busy} />
              record_metrics
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={stopOnError} onChange={(event) => setStopOnError(event.target.checked)} disabled={busy} />
              stop_on_error
            </label>
          </div>
        </section>

        {stageType === 'paired_request_loop' ? (
          <section className="template-editor-section">
            <h3>Paired request loop</h3>
            <div className="template-editor-grid">
              <label>
                Pre-iteration delay ms
                <input type="number" min={0} value={preIterationDelayMs} onChange={(event) => setPreIterationDelayMs(Number(event.target.value))} disabled={busy} />
              </label>
              <label>
                Intra-pair delay ms
                <input type="number" min={0} value={intraPairDelayMs} onChange={(event) => setIntraPairDelayMs(Number(event.target.value))} disabled={busy} />
              </label>
            </div>

            <div className="template-dynamic-list">
              <div className="template-dynamic-list__header">
                <h4>Pair members</h4>
                <button type="button" className="btn btn--ghost" onClick={addPairMember} disabled={busy}>Add member</button>
              </div>
              {pairMembers.map((member, index) => (
                <div key={`${index}:${member.id}`} className="template-dynamic-row template-dynamic-row--pair">
                  <label>
                    Member ID
                    <input value={member.id} onChange={(event) => updatePairMember(index, { id: event.target.value })} disabled={busy} />
                  </label>
                  <label>
                    Role
                    <select value={member.role} onChange={(event) => updatePairMember(index, { role: event.target.value as PairRole })} disabled={busy}>
                      {PAIR_ROLES.map((role) => <option key={role || 'none'} value={role}>{role || 'unset'}</option>)}
                    </select>
                  </label>
                  <button type="button" className="btn btn--ghost" onClick={() => removePairMember(index)} disabled={busy || pairMembers.length <= 2}>Remove</button>
                </div>
              ))}
            </div>

            <div className="template-dynamic-list">
              <div className="template-dynamic-list__header">
                <h4>Derived metrics</h4>
                <button type="button" className="btn btn--ghost" onClick={addDerivedMetric} disabled={busy}>Add metric</button>
              </div>
              {derivedMetrics.length === 0 ? <p className="muted">No derived metrics.</p> : null}
              {derivedMetrics.map((metric, index) => (
                <div key={`${index}:${metric.id}`} className="template-dynamic-row template-dynamic-row--derived">
                  <label>
                    Metric ID
                    <input value={metric.id} onChange={(event) => updateDerivedMetric(index, { id: event.target.value })} disabled={busy} />
                  </label>
                  <label>
                    Left metric
                    <input value={metric.left} onChange={(event) => updateDerivedMetric(index, { left: event.target.value })} disabled={busy} />
                  </label>
                  <label>
                    Right metric
                    <input value={metric.right} onChange={(event) => updateDerivedMetric(index, { right: event.target.value })} disabled={busy} />
                  </label>
                  <label>
                    Unit
                    <input value={metric.unit} onChange={(event) => updateDerivedMetric(index, { unit: event.target.value })} disabled={busy} />
                  </label>
                  <button type="button" className="btn btn--ghost" onClick={() => removeDerivedMetric(index)} disabled={busy}>Remove</button>
                </div>
              ))}
            </div>

            <label>
              Observability JSON
              <textarea value={observabilityJson} onChange={(event) => setObservabilityJson(event.target.value)} rows={4} disabled={busy} />
            </label>
          </section>
        ) : null}

        <section className="template-editor-section template-section--schema-required">
          <h3>Metrics</h3>
          <div className="template-check-grid">
            {METRICS.map((metric) => (
              <label key={metric} className="checkbox-row">
                <input type="checkbox" checked={metrics.includes(metric)} onChange={() => toggleMetric(metric)} disabled={busy} />
                {metric}
              </label>
            ))}
          </div>
          <label>
            Additional metric IDs
            <input value={customMetrics} onChange={(event) => setCustomMetrics(event.target.value)} disabled={busy} placeholder="pair.cold.elapsed_ms, pair.hot.elapsed_ms, cold_penalty_ms" />
          </label>
        </section>

        <section className="template-editor-section template-section--schema-required">
          <h3>Aggregations</h3>
          <div className="template-check-grid">
            {AGGREGATIONS.map((aggregation) => (
              <label key={aggregation} className="checkbox-row">
                <input type="checkbox" checked={aggregations.includes(aggregation)} onChange={() => toggleAggregation(aggregation)} disabled={busy} />
                {aggregation}
              </label>
            ))}
          </div>
        </section>

        <section className="template-editor-section">
          <h3>Metadata</h3>
          <div className="template-editor-grid">
            <label>
              Metadata JSON
              <textarea value={metadataJson} onChange={(event) => setMetadataJson(event.target.value)} rows={5} disabled={busy} />
            </label>
            <label>
              Extensions JSON
              <textarea value={extensionsJson} onChange={(event) => setExtensionsJson(event.target.value)} rows={5} disabled={busy} />
            </label>
          </div>
        </section>

        {!embedded ? (
          <button type="submit" disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        ) : null}
      </form>

      {drawerOpen ? (
        <div className="drawer-overlay" role="dialog" aria-modal="true" aria-label="Raw template JSON">
          <aside className="server-drawer template-json-drawer">
            <div className="drawer-header">
              <div>
                <span className="template-kind template-kind--benchmark">benchmark</span>
                <h2>Raw template JSON</h2>
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => setDrawerOpen(false)}>Close</button>
            </div>
            <div className="drawer-body template-json-drawer__body">
              <textarea value={rawJson} onChange={(event) => setRawJson(event.target.value)} />
            </div>
            <div className="drawer-footer">
              <button type="button" onClick={applyRawJson}>Apply JSON</button>
              <button type="button" className="btn btn--ghost" onClick={() => setDrawerOpen(false)}>Cancel</button>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
