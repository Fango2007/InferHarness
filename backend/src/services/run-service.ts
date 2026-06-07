import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb } from '../models/db.js';
import { getInferenceServerById } from '../models/inference-server.js';
import { getProfileById } from '../models/profile.js';
import { getLatestTestDefinition } from '../models/test-definition.js';
import { nowIso, parseJson } from '../models/repositories.js';
import { getRetentionDays } from './retention.js';
import { AssertionOutcomeDraft, executeRun, RunExecutionResult, StepResultSnapshot } from './run-executor.js';
import { cancelRun, clearRunAbortController, registerRunAbortController } from './run-cancel.js';
import { logEvent } from './observability.js';
import { validateWithSchema } from './schema-validator.js';

export interface RunRecord {
  id: string;
  inference_server_id: string;
  suite_id: string | null;
  test_id: string | null;
  profile_id: string | null;
  profile_version: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  environment_snapshot: Record<string, unknown> | null;
  retention_days: number | null;
}

export interface RunResultRecord {
  id: string;
  run_id: string;
  test_id: string;
  verdict: string;
  failure_reason: string | null;
  metrics: Record<string, unknown> | null;
  artefacts: Record<string, unknown> | null;
  raw_events: Record<string, unknown>[] | null;
  repetition_stats: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
}

export type DeleteRunResult =
  | { ok: true }
  | { ok: false; code: 'RUN_NOT_FOUND' | 'RUN_ACTIVE'; error: string };

export interface CreateRunInput {
  run_id?: string | null;
  inference_server_id: string;
  test_id?: string | null;
  suite_id?: string | null;
  profile_id?: string | null;
  profile_version?: string | null;
  test_overrides?: Record<string, unknown> | null;
  profile_defaults?: Record<string, unknown> | null;
  model_metadata?: Record<string, unknown> | null;
  environment_snapshot?: Record<string, unknown> | null;
}

const RESULT_SCHEMA_VERSION = '1.0.0';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const RESULT_SCHEMA_PATH = path.resolve(
  moduleDir,
  '../schemas/test-run-result.schema.json'
);

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function toString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toTransportFormat(value: unknown): 'sse' | 'jsonl' | 'chunked' | 'unknown' | null {
  if (value === 'sse' || value === 'jsonl' || value === 'chunked' || value === 'unknown') {
    return value;
  }
  return null;
}

function buildEffectiveSettings(effectiveConfig: Record<string, unknown> | null): Record<string, unknown> {
  const config = effectiveConfig ?? {};
  return {
    generation: {
      temperature: toNumber(config.temperature),
      top_p: toNumber(config.top_p),
      max_tokens: toInteger(config.max_tokens ?? config.max_completion_tokens),
      tool: toString(config.tool),
      tool_choice: toString(config.tool_choice),
      parallel_tool_calls: toBoolean(config.parallel_tool_calls)
    },
    context: {
      context_window_tokens: toInteger(config.context_window_tokens),
      max_input_tokens: toInteger(config.max_input_tokens),
      truncation_strategy: toString(config.truncation_strategy),
      system_prompt_strategy: toString(config.system_prompt_strategy)
    },
    transport: {
      stream: toBoolean(config.stream),
      format: toTransportFormat(config.stream_format)
    }
  };
}

function assignAssertionIds(stepId: string, assertions: AssertionOutcomeDraft[]): Array<Record<string, unknown>> {
  return assertions.map((assertion, index) => ({
    id: crypto.createHash('sha256').update(`${stepId}:assertion:${index}`).digest('hex').slice(0, 20),
    ...assertion
  }));
}

interface PersistedStepResult {
  index: number;
  id: string;
  name: string | null;
  status: string;
  attempts: number;
  request: StepResultSnapshot['request'];
  response: StepResultSnapshot['response'];
  extract: Array<Record<string, unknown>>;
  vars_delta: Record<string, unknown>;
  assertions: Array<Record<string, unknown>>;
  metrics: StepResultSnapshot['metrics'];
  timing: StepResultSnapshot['timing'];
  error: StepResultSnapshot['error'];
  notes: string | null;
}

function buildStepResults(
  runId: string,
  testId: string,
  steps: StepResultSnapshot[]
): PersistedStepResult[] {
  return steps.map((step, index) => {
    const stepIndex = Number.isInteger(step.index) ? step.index : index;
    const stepId = crypto
      .createHash('sha256')
      .update(`${runId}:${testId}:step:${stepIndex}`)
      .digest('hex')
      .slice(0, 20);

    return {
      index: stepIndex,
      id: stepId,
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      request: step.request,
      response: step.response,
      extract: step.extract ?? [],
      vars_delta: step.vars_delta ?? {},
      assertions: assignAssertionIds(stepId, step.assertions),
      metrics: step.metrics,
      timing: step.timing,
      error: step.error,
      notes: step.notes ?? null
    };
  });
}

function buildResultDocument(
  runId: string,
  result: RunExecutionResult['results'][number],
  server: ReturnType<typeof getInferenceServerById>,
  effectiveConfig: Record<string, unknown> | null,
  profileId: string | null,
  profileVersion: string | null,
  modelMetadata: Record<string, unknown> | null
): Record<string, unknown> {
  const now = nowIso();
  const testDefinition = getLatestTestDefinition(result.test_id);
  const profile = profileId && profileVersion ? getProfileById(profileId, profileVersion) : null;

  const steps = buildStepResults(runId, result.test_id, result.step_results);
  const stepErrors = steps
    .map((step) => ({
      step_index: step.index as number,
      error: step.error as Record<string, unknown> | null
    }))
    .filter((entry) => entry.error);

  const hasErrorStep = steps.some((step) => step.status === 'error');
  const status = hasErrorStep
    ? 'error'
    : result.verdict === 'skip'
      ? 'skipped'
      : result.verdict === 'fail'
        ? 'fail'
        : 'pass';

  const selectedModelId = toString(effectiveConfig?.model);

  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: runId,
    status,
    started_at: result.started_at,
    ended_at: result.ended_at,
    duration_ms: new Date(result.ended_at).getTime() - new Date(result.started_at).getTime(),
    test: {
      id: result.test_id,
      version: testDefinition?.version ?? null,
      type: testDefinition?.runner_type === 'python' ? 'scenario-python' : 'scenario-json',
      definition_ref: testDefinition?.spec_path ?? null,
      definition_sha256: null,
      archived: false,
      tags: testDefinition?.tags ?? []
    },
    profile: {
      id: profile?.id ?? profileId ?? 'ad-hoc',
      version: profile?.version ?? profileVersion ?? null,
      definition_ref: null,
      definition_sha256: null
    },
    server_instance: {
      cache_key: server ? `${server.inference_server.server_id}:${server.endpoints.base_url}` : 'unknown',
      base_url: server?.endpoints.base_url ?? '',
      retrieved_at: server?.runtime.retrieved_at ?? now,
      ttl_ms: server?.discovery.ttl_seconds != null ? server.discovery.ttl_seconds * 1000 : Number(process.env.INFERHARNESS_CONTEXT_PROBE_TIMEOUT_MS || 300000),
      capabilities_snapshot: server?.capabilities ?? null,
      runtime_snapshot: server?.runtime ?? null,
      models_snapshot: server?.discovery.model_list.normalised ?? null,
      hardware_snapshot: server?.runtime.hardware ?? null
    },
    selected_model: selectedModelId
      ? {
          id: selectedModelId,
          alias: null,
          metadata: modelMetadata ?? null,
          retrieved_at: now
        }
      : null,
    effective_settings: buildEffectiveSettings(effectiveConfig),
    steps,
    final_assert: [],
    summary: {
      passed_steps: steps.filter((step) => step.status === 'pass').length,
      failed_steps: steps.filter((step) => step.status === 'fail' || step.status === 'error').length,
      errors: stepErrors.map((entry) => ({
        code: (entry.error?.code as string) ?? 'unknown',
        message: (entry.error?.message as string) ?? 'Step error',
        step_index: entry.step_index,
        details: (entry.error?.details as Record<string, unknown> | null) ?? null
      })),
      warnings: []
    }
  };
}

export function resolveOverrides(input: CreateRunInput): Record<string, unknown> {
  return {
    ...(input.profile_defaults ?? {}),
    ...(input.test_overrides ?? {})
  };
}
function buildRunId(input: CreateRunInput): string {
  if (input.run_id) {
    return input.run_id;
  }
  const key = `${input.inference_server_id}:${input.test_id ?? input.suite_id}:${Date.now()}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
}

function insertRunRecord(
  input: CreateRunInput,
  status: string,
  startedAt: string,
  environmentSnapshot: Record<string, unknown>,
  retentionDays: number,
  id: string
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (
      id, inference_server_id, suite_id, test_id, profile_id, profile_version,
      status, started_at, ended_at, environment_snapshot, retention_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.inference_server_id,
    input.suite_id ?? null,
    input.test_id ?? null,
    input.profile_id ?? null,
    input.profile_version ?? null,
    status,
    startedAt,
    null,
    JSON.stringify(environmentSnapshot),
    retentionDays
  );
}

function updateRunStatus(id: string, status: string, endedAt: string): void {
  const db = getDb();
  db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, id);
}

function insertTestResult(runId: string, result: RunExecutionResult['results'][number]): string {
  const db = getDb();
  const id = crypto.createHash('sha256').update(`${runId}:${result.test_id}:${Date.now()}`).digest('hex').slice(0, 20);
  db.prepare(
    `INSERT INTO test_results (
      id, run_id, test_id, verdict, failure_reason, metrics, artefacts, raw_events,
      repetition_stats, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runId,
    result.test_id,
    result.verdict,
    result.failure_reason,
    result.metrics ? JSON.stringify(result.metrics) : null,
    result.artefacts ? JSON.stringify(result.artefacts) : null,
    result.raw_events ? JSON.stringify(result.raw_events) : null,
    JSON.stringify({ repetitions: 1 }),
    result.started_at,
    result.ended_at
  );
  return id;
}

function insertResultDocument(
  testResultId: string,
  runId: string,
  testId: string,
  document: Record<string, unknown>
): void {
  const schemaResult = validateWithSchema(RESULT_SCHEMA_PATH, document);
  if (!schemaResult.ok) {
    const detail = schemaResult.issues.map((issue) => `${issue.path ?? 'root'}: ${issue.message}`).join('; ');
    logEvent({
      level: 'warn',
      message: 'Run result document failed schema validation',
      run_id: runId,
      test_id: testId,
      meta: { issues: schemaResult.issues, detail }
    });
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO test_result_documents (
      test_result_id, run_id, test_id, schema_version, document, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    testResultId,
    runId,
    testId,
    RESULT_SCHEMA_VERSION,
    JSON.stringify(document),
    nowIso()
  );
}

export async function createSingleRun(input: CreateRunInput): Promise<RunRecord> {
  const now = nowIso();
  const retentionDays = getRetentionDays();
  const id = buildRunId(input);
  const server = getInferenceServerById(input.inference_server_id);
  if (!server) {
    throw new Error(`Inference server not found: ${input.inference_server_id}`);
  }
  const effectiveConfig = resolveOverrides({ ...input });
  const environmentSnapshot = {
    ...input.environment_snapshot,
    effective_config: effectiveConfig,
    model_metadata: input.model_metadata ?? null
  };

  insertRunRecord(input, 'running', now, environmentSnapshot, retentionDays, id);

  const abortSignal = registerRunAbortController(id);
  const execution = await executeRun({
    run_id: id,
    inference_server_id: input.inference_server_id,
    test_id: input.test_id ?? null,
    suite_id: input.suite_id ?? null,
    profile_id: input.profile_id ?? null,
    profile_version: input.profile_version ?? null,
    effective_config: effectiveConfig,
    abort_signal: abortSignal
  });
  clearRunAbortController(id);

  for (const result of execution.results) {
    const resultId = insertTestResult(id, result);
    const document = buildResultDocument(
      id,
      result,
      server,
      effectiveConfig,
      input.profile_id ?? null,
      input.profile_version ?? null,
      input.model_metadata ?? null
    );
    insertResultDocument(resultId, id, result.test_id, document);
  }

  updateRunStatus(id, execution.status, execution.ended_at);

  return {
    id,
    inference_server_id: input.inference_server_id,
    suite_id: input.suite_id ?? null,
    test_id: input.test_id ?? null,
    profile_id: input.profile_id ?? null,
    profile_version: input.profile_version ?? null,
    status: execution.status,
    started_at: now,
    ended_at: execution.ended_at,
    environment_snapshot: environmentSnapshot,
    retention_days: retentionDays
  };
}

export function requestCancelRun(id: string): RunRecord | null {
  const run = getRun(id);
  if (!run) {
    return null;
  }
  cancelRun(id);
  updateRunStatus(id, 'canceled', nowIso());
  return getRun(id);
}

export function getRun(id: string): RunRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  if (!row) {
    return null;
  }
  return {
    ...row,
    environment_snapshot: parseJson(row.environment_snapshot as unknown as string)
  };
}

export function listRunResults(runId: string): RunResultRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM test_results WHERE run_id = ?')
    .all(runId) as RunResultRecord[];

  return rows.map((row) => ({
    ...row,
    metrics: parseJson(row.metrics as unknown as string),
    artefacts: parseJson(row.artefacts as unknown as string),
    raw_events: parseJson(row.raw_events as unknown as string),
    repetition_stats: parseJson(row.repetition_stats as unknown as string)
  }));
}

export function deleteRun(id: string): DeleteRunResult {
  const db = getDb();
  const row = db.prepare('SELECT id, status FROM runs WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  if (!row) {
    return { ok: false, code: 'RUN_NOT_FOUND', error: 'Run not found' };
  }
  if (row.status === 'queued' || row.status === 'running') {
    return { ok: false, code: 'RUN_ACTIVE', error: 'Active runs cannot be deleted' };
  }

  const transaction = db.transaction((runId: string) => {
    const resultRows = db.prepare('SELECT id FROM test_results WHERE run_id = ?').all(runId) as Array<{ id: string }>;
    const resultIds = resultRows.map((result) => result.id);

    if (resultIds.length > 0) {
      const placeholders = resultIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM metric_samples WHERE test_result_id IN (${placeholders})`).run(...resultIds);
      db.prepare(`DELETE FROM evaluation_queue_skips WHERE test_result_id IN (${placeholders})`).run(...resultIds);
      db.prepare(`DELETE FROM test_result_documents WHERE test_result_id IN (${placeholders})`).run(...resultIds);
    }

    db.prepare('DELETE FROM test_results WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  });

  transaction(id);
  logEvent({
    level: 'info',
    message: 'run deleted',
    meta: { run_id: id }
  });
  return { ok: true };
}
