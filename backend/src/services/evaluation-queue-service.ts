import { getDb } from '../models/db.js';
import * as evaluationModel from '../models/evaluation.js';
import { nowIso, parseJson } from '../models/repositories.js';
import { createEvaluation, EvaluationValidationError } from './evaluation-service.js';

type QueueStatus = 'pending' | 'done' | 'skipped';

interface QueueSourceRow {
  test_result_id: string;
  run_id: string;
  test_id: string;
  verdict: string;
  failure_reason: string | null;
  metrics: string | null;
  artefacts: string | null;
  raw_events: string | null;
  started_at: string;
  ended_at: string | null;
  document: string | null;
  run_status: string;
  environment_snapshot: string | null;
  server_id: string;
  server_name: string | null;
  template_id: string | null;
  template_name: string | null;
  runner_type: string | null;
}

export interface EvaluationQueueItem {
  test_result_id: string;
  run_id: string;
  test_id: string;
  template_id: string;
  template_label: string;
  model_name: string;
  server_id: string;
  server_name: string;
  verdict: string;
  status: QueueStatus;
  started_at: string;
  ended_at: string | null;
}

export interface EvaluationQueueDetail extends EvaluationQueueItem {
  inference_config: {
    temperature: number | null;
    top_p: number | null;
    max_tokens: number | null;
    quantization_level: string | null;
    stream: boolean | null;
  };
  prompt_text: string;
  answer_text: string;
  metrics: Record<string, unknown>;
  artefacts: Record<string, unknown>;
  raw_events: unknown;
  document: Record<string, unknown>;
  evaluation_id: string | null;
  skipped_at: string | null;
}

export class EvaluationQueueConflictError extends Error {}

function safeJson<T>(value: string | null): T | null {
  try {
    return parseJson<T>(value);
  } catch {
    return null;
  }
}

function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const entry = record[key];
    if (typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
  }
  return null;
}

function extractPrompt(document: Record<string, unknown> | null, artefacts: Record<string, unknown> | null): string {
  const fromArtefacts = findString(artefacts, ['prompt', 'prompt_text', 'request_prompt']);
  if (fromArtefacts) {
    return fromArtefacts;
  }
  const direct = findString(document, ['prompt', 'prompt_text', 'input', 'user_prompt']);
  if (direct) {
    return direct;
  }
  const request = document?.request;
  const requestText = findString(request, ['prompt', 'prompt_text']);
  if (requestText) {
    return requestText;
  }
  const steps = Array.isArray(document?.steps) ? document.steps : [];
  for (const step of steps) {
    const text = findString(step, ['prompt', 'prompt_text', 'input', 'user_prompt']);
    if (text) {
      return text;
    }
  }
  return 'Prompt unavailable';
}

function extractAnswer(artefacts: Record<string, unknown> | null, rawEvents: unknown): string {
  const fromArtefacts = findString(artefacts, ['response_body', 'response_preview', 'answer_text', 'output', 'completion']);
  if (fromArtefacts) {
    return fromArtefacts;
  }
  if (typeof rawEvents === 'string' && rawEvents.trim()) {
    return rawEvents;
  }
  return '';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function selectedModel(snapshot: Record<string, unknown> | null, document: Record<string, unknown> | null): string {
  const effective = snapshot?.effective_config;
  if (effective && typeof effective === 'object') {
    const model = (effective as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim()) {
      return model.trim();
    }
  }
  const direct = snapshot?.model;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const selected = document?.selected_model;
  if (selected && typeof selected === 'object') {
    const id = (selected as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  }
  return 'unknown';
}

function inferenceConfig(snapshot: Record<string, unknown> | null): EvaluationQueueDetail['inference_config'] {
  const effective = snapshot?.effective_config && typeof snapshot.effective_config === 'object'
    ? snapshot.effective_config as Record<string, unknown>
    : {};
  return {
    temperature: numberOrNull(effective.temperature),
    top_p: numberOrNull(effective.top_p),
    max_tokens: numberOrNull(effective.max_tokens),
    quantization_level: typeof effective.quantization_level === 'string' ? effective.quantization_level : null,
    stream: typeof effective.stream === 'boolean' ? effective.stream : null
  };
}

function templateLabel(row: QueueSourceRow): string {
  return row.template_name?.replace(/\s*\([^)]*\)\s*$/, '').trim() || row.template_id || row.test_id;
}

function sourceRows(): QueueSourceRow[] {
  return getDb().prepare(`
    SELECT
      tr.id AS test_result_id,
      tr.run_id,
      tr.test_id,
      tr.verdict,
      tr.failure_reason,
      tr.metrics,
      tr.artefacts,
      tr.raw_events,
      tr.started_at,
      tr.ended_at,
      trd.document,
      r.status AS run_status,
      r.environment_snapshot,
      r.inference_server_id AS server_id,
      i.display_name AS server_name,
      tr.test_id AS template_id,
      tr.test_id AS template_name,
      NULL AS runner_type
    FROM test_results tr
    JOIN runs r ON r.id = tr.run_id
    LEFT JOIN test_result_documents trd ON trd.test_result_id = tr.id
    LEFT JOIN inference_servers i ON i.server_id = r.inference_server_id
    WHERE r.status = 'completed'
    ORDER BY COALESCE(tr.ended_at, tr.started_at) DESC
    LIMIT 500
  `).all() as QueueSourceRow[];
}

function rowStatus(testResultId: string): QueueStatus {
  const db = getDb();
  const evaluated = db
    .prepare('SELECT id FROM evaluations WHERE source_test_result_id = ?')
    .get(testResultId);
  if (evaluated) {
    return 'done';
  }
  const skipped = db
    .prepare('SELECT test_result_id FROM evaluation_queue_skips WHERE test_result_id = ?')
    .get(testResultId);
  return skipped ? 'skipped' : 'pending';
}

function rowToDetail(row: QueueSourceRow, status = rowStatus(row.test_result_id)): EvaluationQueueDetail {
  const document = safeJson<Record<string, unknown>>(row.document) ?? {};
  const metrics = safeJson<Record<string, unknown>>(row.metrics) ?? {};
  const artefacts = safeJson<Record<string, unknown>>(row.artefacts) ?? {};
  const rawEvents = safeJson<unknown>(row.raw_events) ?? row.raw_events ?? null;
  const snapshot = safeJson<Record<string, unknown>>(row.environment_snapshot) ?? {};
  const evaluation = evaluationModel.getBySourceTestResultId(row.test_result_id);
  const skip = getDb()
    .prepare('SELECT skipped_at FROM evaluation_queue_skips WHERE test_result_id = ?')
    .get(row.test_result_id) as { skipped_at: string } | undefined;

  return {
    test_result_id: row.test_result_id,
    run_id: row.run_id,
    test_id: row.test_id,
    template_id: row.template_id ?? row.test_id,
    template_label: templateLabel(row),
    model_name: selectedModel(snapshot, document),
    server_id: row.server_id,
    server_name: row.server_name ?? row.server_id,
    verdict: row.verdict,
    status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    inference_config: inferenceConfig(snapshot),
    prompt_text: extractPrompt(document, artefacts),
    answer_text: extractAnswer(artefacts, rawEvents),
    metrics,
    artefacts,
    raw_events: rawEvents,
    document,
    evaluation_id: evaluation?.id ?? null,
    skipped_at: skip?.skipped_at ?? null
  };
}

export function listEvaluationQueue(status: QueueStatus = 'pending') {
  const details = sourceRows().map((row) => rowToDetail(row));
  const counts = details.reduce<Record<QueueStatus, number>>((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { pending: 0, done: 0, skipped: 0 });
  return {
    counts,
    items: details
      .filter((item) => item.status === status)
      .map(({ inference_config: _inferenceConfig, prompt_text: _prompt, answer_text: _answer, metrics: _metrics, artefacts: _artefacts, raw_events: _raw, document: _document, evaluation_id: _evaluationId, skipped_at: _skippedAt, ...item }) => item)
  };
}

export function getEvaluationQueueDetail(testResultId: string): EvaluationQueueDetail | null {
  const row = sourceRows().find((entry) => entry.test_result_id === testResultId);
  return row ? rowToDetail(row) : null;
}

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
    throw new EvaluationValidationError([{ message: `${field} must be an integer from 1 to 5`, path: field }]);
  }
  return value as number;
}

export async function scoreEvaluationQueueItem(testResultId: string, body: Record<string, unknown>) {
  if (evaluationModel.getBySourceTestResultId(testResultId)) {
    throw new EvaluationQueueConflictError('test result has already been scored');
  }
  const detail = getEvaluationQueueDetail(testResultId);
  if (!detail) {
    return null;
  }
  const metrics = detail.metrics;
  return createEvaluation({
    prompt_text: detail.prompt_text,
    tags: [],
    server_id: detail.server_id,
    model_name: detail.model_name,
    inference_config: {
      temperature: detail.inference_config.temperature,
      top_p: detail.inference_config.top_p,
      max_tokens: detail.inference_config.max_tokens,
      quantization_level: detail.inference_config.quantization_level
    },
    answer_text: detail.answer_text,
    input_tokens: numberOrNull(metrics.prompt_tokens),
    output_tokens: numberOrNull(metrics.completion_tokens),
    total_tokens: numberOrNull(metrics.total_tokens),
    latency_ms: numberOrNull(metrics.latency_ms) ?? numberOrNull(metrics.total_ms),
    word_count: detail.answer_text.trim() ? detail.answer_text.trim().split(/\s+/).length : 0,
    estimated_cost: numberOrNull(metrics.estimated_cost),
    accuracy_score: score(body.accuracy_score, 'accuracy_score'),
    relevance_score: score(body.relevance_score, 'relevance_score'),
    coherence_score: score(body.coherence_score, 'coherence_score'),
    completeness_score: score(body.completeness_score, 'completeness_score'),
    helpfulness_score: score(body.helpfulness_score, 'helpfulness_score'),
    note: typeof body.note === 'string' ? body.note : null,
    source_test_result_id: testResultId
  });
}

export function skipEvaluationQueueItem(testResultId: string, reason: unknown): boolean {
  const detail = getEvaluationQueueDetail(testResultId);
  if (!detail) {
    return false;
  }
  const skippedAt = nowIso();
  getDb().prepare(`
    INSERT INTO evaluation_queue_skips (test_result_id, reason, skipped_at)
    VALUES (?, ?, ?)
    ON CONFLICT(test_result_id) DO UPDATE SET
      reason = excluded.reason,
      skipped_at = excluded.skipped_at
  `).run(testResultId, typeof reason === 'string' && reason.trim() ? reason.trim() : null, skippedAt);
  return true;
}
