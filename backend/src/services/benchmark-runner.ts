import crypto from 'crypto';
import { performance } from 'perf_hooks';

import {
  BenchmarkNotFoundError,
  BenchmarkValidationError,
  getBenchmarkInstantiation,
  persistBenchmarkResult
} from './benchmark-foundation.js';
import { resolveBenchmarkDatasetItems } from './benchmark-datasets.js';
import { getInferenceServerById } from '../models/inference-server.js';
import { buildInferenceServerAuthHeaders } from './inference-server-auth.js';
import { backendFetch } from './inference-proxy.js';
import { sha256Document, validateBenchmarkDocument } from './benchmark-schemas.js';
import { parseSseEvents } from './sse-parser.js';
import { aggregateMetrics as computeAggregations, computeItemMetrics } from './benchmark-metrics.js';

const ENGINE_VERSION = 'benchmark-runner-v1';
const DEFAULT_TIMEOUT_MS = 30_000;

interface BenchmarkStage {
  id: string;
  type: 'dataset_loop' | 'single_request' | 'paired_request_loop';
  iterations_per_item?: number;
  record_metrics?: boolean;
  stop_on_error?: boolean;
}

interface ExecutableItem {
  item: Record<string, unknown>;
  itemIndex: number;
  iteration: number;
}

interface RetryPolicy {
  max_retries: number;
  retry_on: string[];
  backoff: 'none' | 'fixed' | 'linear' | 'exponential';
  base_delay_ms: number;
  max_delay_ms: number;
}

interface CancellationPolicy {
  cancel_on_first_fatal_error: boolean;
  max_error_rate: number | null;
  max_consecutive_errors: number | null;
  graceful_shutdown: boolean;
  persist_partial_results: boolean;
}

interface ExecutionPolicy {
  retry: RetryPolicy;
  cancellation: CancellationPolicy;
}

interface NormalizedResponse {
  answer_text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  tool_calls: unknown[] | null;
  body: unknown;
  text: string | null;
  stream?: Record<string, unknown> | null;
}

interface StreamEventSnapshot {
  raw: string;
  json: Record<string, unknown> | unknown[] | null;
  done: boolean;
  seq: number;
}

interface StreamNormalization {
  format: 'sse' | 'jsonl';
  events: StreamEventSnapshot[];
  done: boolean;
  answer_text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  final_metadata: Record<string, unknown> | null;
}

export class BenchmarkStreamParseError extends Error {
  readonly code = 'malformed_stream';
  readonly format: 'sse' | 'jsonl';
  readonly events: StreamEventSnapshot[];

  constructor(message: string, format: 'sse' | 'jsonl', events: StreamEventSnapshot[]) {
    super(message);
    this.name = 'BenchmarkStreamParseError';
    this.format = format;
    this.events = events;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function textFromValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = (value as Record<string, unknown>)[key];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
}

function stagesFromInstantiation(instantiation: Record<string, unknown>): BenchmarkStage[] {
  const template = objectAt(instantiation, 'template');
  const snapshot = objectAt(template, 'snapshot');
  const stages = snapshot?.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new BenchmarkValidationError('Benchmark instantiation template snapshot requires at least one stage.');
  }
  return stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new BenchmarkValidationError(`Benchmark stage ${index} must be an object.`);
    }
    const record = stage as Record<string, unknown>;
    if (record.type !== 'dataset_loop' && record.type !== 'single_request') {
      throw new BenchmarkValidationError(`Unsupported benchmark stage type in this checkpoint: ${String(record.type)}`);
    }
    return {
      id: String(record.id ?? `stage-${index}`),
      type: record.type,
      iterations_per_item: typeof record.iterations_per_item === 'number' ? record.iterations_per_item : undefined,
      record_metrics: typeof record.record_metrics === 'boolean' ? record.record_metrics : true,
      stop_on_error: typeof record.stop_on_error === 'boolean' ? record.stop_on_error : false
    };
  });
}

function templateMetricsFromInstantiation(instantiation: Record<string, unknown>): string[] {
  const snapshot = objectAt(objectAt(instantiation, 'template'), 'snapshot');
  const metrics = snapshot?.metrics;
  return Array.isArray(metrics) ? (metrics as string[]) : ['elapsed_ms', 'input_tokens', 'output_tokens', 'total_tokens'];
}

function templateAggregationsFromInstantiation(instantiation: Record<string, unknown>): string[] {
  const snapshot = objectAt(objectAt(instantiation, 'template'), 'snapshot');
  const aggs = snapshot?.aggregations;
  return Array.isArray(aggs) ? (aggs as string[]) : ['mean', 'count'];
}

function expectedSampleCount(stages: BenchmarkStage[], itemCount: number): number {
  return stages
    .filter((s) => s.record_metrics !== false)
    .reduce((sum, s) => {
      const itemsForStage = s.type === 'single_request' ? 1 : itemCount;
      return sum + itemsForStage * (s.iterations_per_item ?? 1);
    }, 0);
}

function modelIdFromInstantiation(instantiation: Record<string, unknown>): string {
  const snapshotModel = objectAt(objectAt(instantiation, 'model_snapshot'), 'model');
  const profileModel = objectAt(objectAt(instantiation, 'model_profile'), 'model');
  const modelId = textFromValue(snapshotModel?.model_id) ?? textFromValue(profileModel?.model_id);
  if (!modelId) {
    throw new BenchmarkValidationError('Benchmark instantiation requires a model_id in the model snapshot or profile.');
  }
  return modelId;
}

function messagesFromItem(item: Record<string, unknown>): Array<Record<string, string>> {
  if (Array.isArray(item.messages)) {
    return item.messages.map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new BenchmarkValidationError('Dataset item messages must contain objects.');
      }
      const record = message as Record<string, unknown>;
      const role = textFromValue(record.role) ?? 'user';
      const content = textFromValue(record.content);
      if (!content) {
        throw new BenchmarkValidationError('Dataset item messages require string content.');
      }
      return { role, content };
    });
  }

  const prompt = textFromValue(item.prompt);
  if (!prompt) {
    throw new BenchmarkValidationError('Dataset item requires prompt or messages for chat_completion execution.');
  }
  const messages: Array<Record<string, string>> = [];
  const systemPrompt = textFromValue(item.system_prompt);
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function runtimeParameters(instantiation: Record<string, unknown>): Record<string, unknown> {
  return objectAt(instantiation, 'runtime_parameters') ?? {};
}

function executionPolicySource(instantiation: Record<string, unknown>): Record<string, unknown> {
  return objectAt(instantiation, 'execution_policy') ?? {};
}

export function parseExecutionPolicy(instantiation: Record<string, unknown>): ExecutionPolicy {
  const source = executionPolicySource(instantiation);
  const retry = objectAt(source, 'retry_policy') ?? {};
  const cancellation = objectAt(source, 'cancellation_policy') ?? {};
  const backoff = ['none', 'fixed', 'linear', 'exponential'].includes(String(retry.backoff))
    ? retry.backoff as RetryPolicy['backoff']
    : 'none';
  const baseDelay = typeof retry.base_delay_ms === 'number' ? retry.base_delay_ms : 0;
  return {
    retry: {
      max_retries: typeof retry.max_retries === 'number' ? retry.max_retries : 0,
      retry_on: Array.isArray(retry.retry_on) ? retry.retry_on.filter((entry): entry is string => typeof entry === 'string') : [],
      backoff,
      base_delay_ms: baseDelay,
      max_delay_ms: typeof retry.max_delay_ms === 'number' ? retry.max_delay_ms : baseDelay
    },
    cancellation: {
      cancel_on_first_fatal_error: cancellation.cancel_on_first_fatal_error === true,
      max_error_rate: typeof cancellation.max_error_rate === 'number' ? cancellation.max_error_rate : null,
      max_consecutive_errors: typeof cancellation.max_consecutive_errors === 'number' ? cancellation.max_consecutive_errors : null,
      graceful_shutdown: cancellation.graceful_shutdown !== false,
      persist_partial_results: cancellation.persist_partial_results !== false
    }
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryDelayMs(policy: RetryPolicy, retryAttempt: number): number {
  if (policy.backoff === 'none') {
    return 0;
  }
  if (policy.backoff === 'fixed') {
    return Math.min(policy.base_delay_ms, policy.max_delay_ms);
  }
  if (policy.backoff === 'linear') {
    return Math.min(policy.base_delay_ms * retryAttempt, policy.max_delay_ms);
  }
  return Math.min(policy.base_delay_ms * (2 ** (retryAttempt - 1)), policy.max_delay_ms);
}

export function isRetryableError(code: string, policy: RetryPolicy): boolean {
  return policy.retry_on.includes(code);
}

function isFatalError(code: string): boolean {
  return ['invalid_payload', 'unsupported_operation', 'unsupported_parameter', 'invalid_dataset_item', 'schema_validation_error'].includes(code)
    || ['http_400', 'http_401', 'http_403', 'http_404'].includes(code);
}

export function buildBenchmarkRequestPayload(
  instantiation: Record<string, unknown>,
  item: Record<string, unknown>
): Record<string, unknown> {
  const operationSpec = objectAt(instantiation, 'operation_spec');
  const protocol = operationSpec?.protocol;
  const params = runtimeParameters(instantiation);
  const model = modelIdFromInstantiation(instantiation);
  const messages = messagesFromItem(item);

  const stream = params.stream === true;
  if (stream && operationSpec?.supports_streaming !== true) {
    throw new BenchmarkValidationError('Streaming benchmark execution requires operation_spec.supports_streaming support.');
  }

  if (protocol === 'openai_chat') {
    const payload: Record<string, unknown> = { model, messages, stream };
    for (const key of ['temperature', 'top_p', 'max_tokens', 'seed', 'stop', 'presence_penalty', 'frequency_penalty']) {
      if (params[key] !== undefined && params[key] !== null) {
        payload[key] = params[key];
      }
    }
    return payload;
  }

  if (protocol === 'ollama_chat') {
    const options: Record<string, unknown> = {};
    if (params.temperature !== undefined && params.temperature !== null) options.temperature = params.temperature;
    if (params.top_p !== undefined && params.top_p !== null) options.top_p = params.top_p;
    if (params.seed !== undefined && params.seed !== null) options.seed = params.seed;
    if (params.max_tokens !== undefined && params.max_tokens !== null) options.num_predict = params.max_tokens;
    return {
      model,
      messages,
      stream,
      ...(Object.keys(options).length > 0 ? { options } : {})
    };
  }

  throw new BenchmarkValidationError(`Unsupported benchmark operation protocol in this checkpoint: ${String(protocol ?? 'unknown')}`);
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  return typeof record?.[key] === 'number' ? record[key] as number : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function usageTokens(metadata: Record<string, unknown> | null): Pick<NormalizedResponse, 'input_tokens' | 'output_tokens' | 'total_tokens'> {
  const usage = objectValue(metadata?.usage);
  const inputTokens = numberAt(usage, 'prompt_tokens') ?? numberAt(metadata, 'prompt_eval_count');
  const outputTokens = numberAt(usage, 'completion_tokens') ?? numberAt(metadata, 'eval_count');
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberAt(usage, 'total_tokens') ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  };
}

function openAiDeltaContent(json: unknown): string {
  const record = objectValue(json);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = objectValue(choices[0]);
  const delta = objectValue(firstChoice?.delta);
  const message = objectValue(firstChoice?.message);
  if (typeof delta?.content === 'string') return delta.content;
  if (typeof message?.content === 'string') return message.content;
  return '';
}

export function parseOpenAiSseStream(raw: string): StreamNormalization {
  const parsed = parseSseEvents(raw);
  const events: StreamEventSnapshot[] = [];
  const content: string[] = [];
  let done = false;
  let finalMetadata: Record<string, unknown> | null = null;

  parsed.forEach((event, index) => {
    if (event.type === 'done') {
      done = true;
      events.push({ raw: '[DONE]', json: null, done: true, seq: index });
      return;
    }
    const eventRaw = event.payload ?? '';
    try {
      const json = JSON.parse(eventRaw) as Record<string, unknown> | unknown[];
      events.push({ raw: eventRaw, json, done: false, seq: index });
      const delta = openAiDeltaContent(json);
      if (delta) {
        content.push(delta);
      }
      const jsonRecord = objectValue(json);
      if (jsonRecord?.usage || jsonRecord?.choices) {
        finalMetadata = jsonRecord;
      }
    } catch (error) {
      throw new BenchmarkStreamParseError(`Malformed OpenAI SSE stream event ${index}: ${(error as Error).message}`, 'sse', events);
    }
  });

  return {
    format: 'sse',
    events,
    done,
    answer_text: content.join(''),
    ...usageTokens(finalMetadata),
    final_metadata: finalMetadata
  };
}

export function parseOllamaJsonlStream(raw: string): StreamNormalization {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: StreamEventSnapshot[] = [];
  const content: string[] = [];
  let done = false;
  let finalMetadata: Record<string, unknown> | null = null;

  lines.forEach((line, index) => {
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      const record = objectValue(json);
      events.push({ raw: line, json, done: record?.done === true, seq: index });
      const message = objectValue(record?.message);
      const part = typeof message?.content === 'string'
        ? message.content
        : typeof record?.response === 'string' ? record.response : null;
      if (part !== null) {
        content.push(part);
      }
      if (record?.done === true) {
        done = true;
        finalMetadata = record;
      }
    } catch (error) {
      throw new BenchmarkStreamParseError(`Malformed Ollama JSONL stream line ${index + 1}: ${(error as Error).message}`, 'jsonl', events);
    }
  });

  return {
    format: 'jsonl',
    events,
    done,
    answer_text: content.join(''),
    ...usageTokens(finalMetadata),
    final_metadata: finalMetadata
  };
}

function normalizeStreamResponse(protocol: unknown, contentType: string, responseText: string): NormalizedResponse {
  const stream = protocol === 'ollama_chat' && !contentType.includes('text/event-stream')
    ? parseOllamaJsonlStream(responseText)
    : parseOpenAiSseStream(responseText);
  return {
    answer_text: stream.answer_text,
    input_tokens: stream.input_tokens,
    output_tokens: stream.output_tokens,
    total_tokens: stream.total_tokens,
    tool_calls: null,
    body: stream.final_metadata,
    text: null,
    stream: {
      format: stream.format,
      events: stream.events,
      done: stream.done,
      final_metadata: stream.final_metadata
    }
  };
}

function normalizeResponse(body: unknown, text: string | null): NormalizedResponse {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const message = firstChoice && typeof firstChoice.message === 'object' && !Array.isArray(firstChoice.message)
      ? firstChoice.message as Record<string, unknown>
      : null;
    const ollamaMessage = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : null;
    const usage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
      ? record.usage as Record<string, unknown>
      : null;
    const promptEvalCount = typeof record.prompt_eval_count === 'number' ? record.prompt_eval_count : null;
    const evalCount = typeof record.eval_count === 'number' ? record.eval_count : null;
    const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : promptEvalCount;
    const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : evalCount;
    const toolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as unknown[]) : null;
    return {
      answer_text: textFromValue(message?.content) ?? textFromValue(ollamaMessage?.content) ?? textFromValue(record.response) ?? '',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: typeof usage?.total_tokens === 'number'
        ? usage.total_tokens
        : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
      tool_calls: toolCalls,
      body,
      text: null
    };
  }
  return {
    answer_text: text ?? '',
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    tool_calls: null,
    body,
    text
  };
}

async function executeItem(
  instantiation: Record<string, unknown>,
  stage: BenchmarkStage,
  executable: ExecutableItem,
  policy: ExecutionPolicy,
  authHeaders: Record<string, string>,
  requestedMetrics: string[]
): Promise<{
  result: Record<string, unknown>;
  rawResponse: Record<string, unknown> | null;
  normalizedResponse: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}> {
  const operationSpec = objectAt(instantiation, 'operation_spec');
  const url = textFromValue(operationSpec?.url);
  if (!url) {
    throw new BenchmarkValidationError('Benchmark operation_spec requires a URL.');
  }
  const timeoutMs = Number(runtimeParameters(instantiation).timeout_ms ?? objectAt(instantiation, 'execution_policy')?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const payload = buildBenchmarkRequestPayload(instantiation, executable.item);
  const streaming = payload.stream === true;
  const startedAt = nowIso();
  const start = performance.now();
  let firstTokenMs: number | null = null;
  const attemptErrors: Record<string, unknown>[] = [];
  const maxAttempts = policy.retry.max_retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await backendFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      let responseText = '';
      const effectiveStreaming = streaming && response.ok;
      firstTokenMs = null;
      if (effectiveStreaming && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const { value, done: chunkDone } = await reader.read();
          done = chunkDone;
          if (done) {
            break;
          }
          if (firstTokenMs === null) {
            firstTokenMs = Math.round((performance.now() - start) * 1000) / 1000;
          }
          responseText += decoder.decode(value, { stream: true });
        }
        responseText += decoder.decode();
      } else {
        responseText = await response.text();
      }
      const completedAt = nowIso();
      const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      let responseBody: unknown = null;
      const contentType = response.headers.get('content-type') ?? '';
      if (!effectiveStreaming && contentType.includes('application/json')) {
        try {
          responseBody = JSON.parse(responseText) as unknown;
        } catch {
          responseBody = null;
        }
      }
      let normalized: NormalizedResponse;
      try {
        normalized = effectiveStreaming
          ? normalizeStreamResponse(operationSpec?.protocol, contentType, responseText)
          : normalizeResponse(responseBody, responseBody === null ? responseText : null);
      } catch (error) {
        if (!(error instanceof BenchmarkStreamParseError)) {
          throw error;
        }
        const issue = {
          code: error.code,
          message: error.message,
          retryable: false,
          stage_id: stage.id,
          item_index: executable.itemIndex,
          iteration: executable.iteration,
          attempt,
          stream_format: error.format
        };
        attemptErrors.push(issue);
        return {
          result: {
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            status: 'failed',
            started_at: startedAt,
            completed_at: completedAt,
            elapsed_ms: elapsedMs,
            attempts: attempt,
            attempt_errors: attemptErrors,
            request: { method: 'POST', url, body_hash: sha256Document(payload) },
            response_status: response.status
          },
          rawResponse: {
            stage_id: stage.id,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            attempt,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: null,
            text: responseText,
            stream: { format: error.format, events: error.events, done: false, parse_error: error.message }
          },
          normalizedResponse: {
            stage_id: stage.id,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            attempt,
            answer_text: '',
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
            body: null,
            text: null,
            stream: { format: error.format, events: error.events, done: false, parse_error: error.message }
          },
          metrics: {
            stage_id: stage.id,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            elapsed_ms: elapsedMs,
            first_token_ms: firstTokenMs,
            input_tokens: null,
            output_tokens: null,
            total_tokens: null
          },
          error: issue
        };
      }
      const rawResponse = {
        stage_id: stage.id,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        attempt,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        text: responseBody === null ? responseText : null,
        stream: normalized.stream ?? null
      };
      const baseMetrics = {
        stage_id: stage.id,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        elapsed_ms: elapsedMs,
        first_token_ms: firstTokenMs,
        input_tokens: normalized.input_tokens,
        output_tokens: normalized.output_tokens,
        total_tokens: normalized.total_tokens
      };
      const computedMetrics = computeItemMetrics({
        requestedMetrics,
        timing: baseMetrics,
        answerText: normalized.answer_text,
        toolCalls: normalized.tool_calls,
        item: executable.item
      });
      const metrics = { ...baseMetrics, ...computedMetrics };
      const errorCode = response.ok ? null : `http_${response.status}`;
      if (!errorCode) {
        return {
          result: {
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            status: 'completed',
            started_at: startedAt,
            completed_at: completedAt,
            elapsed_ms: elapsedMs,
            attempts: attempt,
            attempt_errors: attemptErrors,
            request: {
              method: 'POST',
              url,
              body_hash: sha256Document(payload)
            },
            response_status: response.status
          },
          rawResponse,
          normalizedResponse: {
            stage_id: stage.id,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            attempt,
            ...normalized
          },
          metrics,
          error: null
        };
      }

      const issue = {
        code: errorCode,
        message: `Benchmark request failed with HTTP ${response.status}`,
        retryable: isRetryableError(errorCode, policy.retry),
        stage_id: stage.id,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        attempt
      };
      attemptErrors.push(issue);
      if (!issue.retryable || attempt >= maxAttempts) {
        return {
          result: {
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            status: 'failed',
            started_at: startedAt,
            completed_at: completedAt,
            elapsed_ms: elapsedMs,
            attempts: attempt,
            attempt_errors: attemptErrors,
            request: { method: 'POST', url, body_hash: sha256Document(payload) },
            response_status: response.status
          },
          rawResponse,
          normalizedResponse: {
            stage_id: stage.id,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            attempt,
            ...normalized
          },
          metrics,
          error: issue
        };
      }
    } catch (error) {
      const err = error as Error;
      const issue = {
        code: err.name === 'AbortError' ? 'timeout' : 'connection_error',
        message: err.name === 'AbortError' ? `Benchmark request timed out after ${timeoutMs}ms` : err.message,
        retryable: isRetryableError(err.name === 'AbortError' ? 'timeout' : 'connection_error', policy.retry),
        stage_id: stage.id,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        attempt
      };
      attemptErrors.push(issue);
      if (!issue.retryable || attempt >= maxAttempts) {
        const completedAt = nowIso();
        const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
        return {
          result: {
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            status: 'failed',
            started_at: startedAt,
            completed_at: completedAt,
            elapsed_ms: elapsedMs,
            attempts: attempt,
            attempt_errors: attemptErrors,
            request: { method: 'POST', url, body_hash: sha256Document(payload) },
            response_status: null
          },
          rawResponse: null,
          normalizedResponse: null,
          metrics: null,
          error: issue
        };
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelayMs(policy.retry, attempt));
  }

  throw new BenchmarkValidationError('Benchmark retry loop exited unexpectedly.');
}

function executableItemsForStage(stage: BenchmarkStage, items: Record<string, unknown>[]): ExecutableItem[] {
  const iterations = stage.iterations_per_item ?? 1;
  const selectedItems = stage.type === 'single_request' ? items.slice(0, 1) : items;
  const executable: ExecutableItem[] = [];
  selectedItems.forEach((item, itemIndex) => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      executable.push({ item, itemIndex, iteration });
    }
  });
  return executable;
}

function skippedResult(executable: ExecutableItem, reason: string): Record<string, unknown> {
  return {
    item_index: executable.itemIndex,
    iteration: executable.iteration,
    status: 'skipped',
    attempts: 0,
    attempt_errors: [],
    skipped_reason: reason,
    started_at: null,
    completed_at: null,
    elapsed_ms: null,
    request: null,
    response_status: null
  };
}

function cancellationReason(input: {
  policy: CancellationPolicy;
  stage: BenchmarkStage;
  latestError: Record<string, unknown>;
  errors: number;
  completed: number;
  consecutiveErrors: number;
}): string | null {
  const code = String(input.latestError.code ?? 'unknown');
  if (input.stage.stop_on_error) {
    return 'stage_stop_on_error';
  }
  if (input.policy.cancel_on_first_fatal_error && isFatalError(code)) {
    return 'cancel_on_first_fatal_error';
  }
  if (input.policy.max_consecutive_errors !== null && input.consecutiveErrors >= input.policy.max_consecutive_errors) {
    return 'max_consecutive_errors';
  }
  const total = input.completed + input.errors;
  if (input.policy.max_error_rate !== null && total > 0 && input.errors / total > input.policy.max_error_rate) {
    return 'max_error_rate';
  }
  return null;
}

export async function runBenchmarkInstantiation(instantiationId: string) {
  const record = getBenchmarkInstantiation(instantiationId);
  if (!record) {
    throw new BenchmarkNotFoundError(`Benchmark instantiation not found: ${instantiationId}`);
  }
  const validation = validateBenchmarkDocument('test_instantiation', record.document);
  if (!validation.ok) {
    throw new BenchmarkValidationError('Stored benchmark instantiation is invalid.', validation.issues);
  }

  const startedAt = nowIso();
  const items = resolveBenchmarkDatasetItems(record.document);
  const stages = stagesFromInstantiation(record.document);
  const policy = parseExecutionPolicy(record.document);
  const requestedMetrics = templateMetricsFromInstantiation(record.document);
  const requestedAggregations = templateAggregationsFromInstantiation(record.document);
  const server = getInferenceServerById(record.server_id);
  if (!server) {
    throw new BenchmarkNotFoundError(`Inference server not found: ${record.server_id}`);
  }
  const authHeaders = buildInferenceServerAuthHeaders(server);
  const stageResults: Record<string, unknown>[] = [];
  const rawResponses: Record<string, unknown>[] = [];
  const normalizedResponses: Record<string, unknown>[] = [];
  const metricResults: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  let runCancelled = false;
  let cancellation = '';

  for (const stage of stages) {
    const stageErrors: Record<string, unknown>[] = [];
    const stageWarnings: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    const executable = executableItemsForStage(stage, items);
    let consecutiveErrors = 0;
    let completedItems = 0;
    for (let itemIndex = 0; itemIndex < executable.length; itemIndex += 1) {
      const item = executable[itemIndex];
      if (runCancelled) {
        results.push(skippedResult(item, cancellation));
        continue;
      }
      const execution = await executeItem(record.document, stage, item, policy, authHeaders, requestedMetrics);
      results.push(execution.result);
      if (execution.rawResponse) rawResponses.push(execution.rawResponse);
      if (execution.normalizedResponse) normalizedResponses.push(execution.normalizedResponse);
      if (execution.metrics && (stage.record_metrics !== false)) metricResults.push(execution.metrics);
      if (execution.error) {
        stageErrors.push(execution.error);
        errors.push(execution.error);
        consecutiveErrors += 1;
        const reason = cancellationReason({
          policy: policy.cancellation,
          stage,
          latestError: execution.error,
          errors: stageErrors.length,
          completed: completedItems,
          consecutiveErrors
        });
        if (reason) {
          runCancelled = true;
          cancellation = reason;
          for (const remaining of executable.slice(itemIndex + 1)) {
            results.push(skippedResult(remaining, reason));
          }
          break;
        }
      } else {
        consecutiveErrors = 0;
        completedItems += 1;
      }
    }
    stageResults.push({
      stage_id: stage.id,
      stage_type: stage.type,
      status: runCancelled ? 'cancelled' : stageErrors.length > 0 ? 'failed' : 'completed',
      record_metrics: stage.record_metrics ?? true,
      run_count: results.length,
      results,
      errors: stageErrors,
      warnings: stageWarnings
    });
    warnings.push(...stageWarnings);
    if (runCancelled) {
      break;
    }
  }

  const resultDocument = {
    kind: 'test_run_result',
    schema_version: 'benchmark_test_run_result_v1',
    engine_version: ENGINE_VERSION,
    run_id: `btr_${cryptoRandomId()}`,
    instantiation_id: instantiationId,
    status: runCancelled ? 'cancelled' : errors.length > 0 ? 'completed_with_errors' : 'completed',
    started_at: startedAt,
    completed_at: nowIso(),
    instantiation_snapshot: record.document,
    stage_results: stageResults,
    raw_responses: rawResponses,
    normalized_responses: normalizedResponses,
    metric_results: metricResults,
    aggregated_metrics: computeAggregations(metricResults, requestedAggregations, expectedSampleCount(stages, items.length)),
    errors,
    warnings,
    metric_version: 'metrics-v1',
    normalizer_version: 'chat-v1',
    metadata: runCancelled ? { cancellation_reason: cancellation } : {}
  };

  return persistBenchmarkResult(resultDocument);
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}
