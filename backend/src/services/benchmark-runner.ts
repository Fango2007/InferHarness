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
import { aggregateMetrics as computeAggregations, computeItemMetrics, estimateRequestTriggeredLoad } from './benchmark-metrics.js';

const ENGINE_VERSION = 'benchmark-runner-v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const BUILT_IN_METRICS = [
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
];

interface BenchmarkStage {
  id: string;
  type: 'dataset_loop' | 'single_request' | 'paired_request_loop';
  iterations_per_item?: number;
  record_metrics?: boolean;
  cooldown_ms?: number;
  pre_iteration_delay_ms?: number;
  intra_pair_delay_ms?: number;
  pair?: PairMember[];
  derived_metrics?: DerivedMetric[];
  stop_on_error?: boolean;
}

interface PairMember {
  id: string;
  role?: string;
  request?: { reuse?: 'default' };
}

interface DerivedMetric {
  id: string;
  type: 'difference';
  left: string;
  right: string;
  unit?: string;
}

interface ExecutableItem {
  item: Record<string, unknown>;
  itemIndex: number;
  iteration: number;
  pairMemberId?: string;
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
  load_duration_ms: number | null;
  server_total_time_ms: number | null;
  server_prompt_eval_ms: number | null;
  server_eval_ms: number | null;
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

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : undefined;
}

function pairMembersFromStage(record: Record<string, unknown>, index: number): PairMember[] | undefined {
  if (record.type !== 'paired_request_loop') {
    return undefined;
  }
  if (!Array.isArray(record.pair) || record.pair.length < 2) {
    throw new BenchmarkValidationError(`Benchmark paired_request_loop stage ${index} requires at least two pair members.`);
  }
  return record.pair.map((member, memberIndex) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      throw new BenchmarkValidationError(`Benchmark paired_request_loop stage ${index} pair member ${memberIndex} must be an object.`);
    }
    const memberRecord = member as Record<string, unknown>;
    const id = textFromValue(memberRecord.id);
    if (!id) {
      throw new BenchmarkValidationError(`Benchmark paired_request_loop stage ${index} pair member ${memberIndex} requires an id.`);
    }
    const request = objectAt(memberRecord, 'request');
    if (request && request.reuse !== undefined && request.reuse !== 'default') {
      throw new BenchmarkValidationError(`Benchmark paired_request_loop stage ${index} pair member ${id} only supports request.reuse="default".`);
    }
    return {
      id,
      role: textFromValue(memberRecord.role) ?? undefined,
      request: request ? { reuse: 'default' } : undefined
    };
  });
}

function derivedMetricsFromStage(record: Record<string, unknown>, index: number): DerivedMetric[] | undefined {
  if (!Array.isArray(record.derived_metrics)) {
    return undefined;
  }
  return record.derived_metrics.map((metric, metricIndex) => {
    if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
      throw new BenchmarkValidationError(`Benchmark stage ${index} derived metric ${metricIndex} must be an object.`);
    }
    const metricRecord = metric as Record<string, unknown>;
    const id = textFromValue(metricRecord.id);
    const left = textFromValue(metricRecord.left);
    const right = textFromValue(metricRecord.right);
    if (!id || !left || !right) {
      throw new BenchmarkValidationError(`Benchmark stage ${index} derived metric ${metricIndex} requires id, left, and right.`);
    }
    if (metricRecord.type !== 'difference') {
      throw new BenchmarkValidationError(`Benchmark stage ${index} derived metric ${id} only supports type="difference" in this checkpoint.`);
    }
    return { id, type: 'difference', left, right, unit: textFromValue(metricRecord.unit) ?? undefined };
  });
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
    if (record.type !== 'dataset_loop' && record.type !== 'single_request' && record.type !== 'paired_request_loop') {
      throw new BenchmarkValidationError(`Unsupported benchmark stage type in this checkpoint: ${String(record.type)}`);
    }
    return {
      id: String(record.id ?? `stage-${index}`),
      type: record.type,
      iterations_per_item: numberField(record, 'iterations_per_item'),
      record_metrics: typeof record.record_metrics === 'boolean' ? record.record_metrics : true,
      cooldown_ms: numberField(record, 'cooldown_ms'),
      pre_iteration_delay_ms: numberField(record, 'pre_iteration_delay_ms'),
      intra_pair_delay_ms: numberField(record, 'intra_pair_delay_ms'),
      pair: pairMembersFromStage(record, index),
      derived_metrics: derivedMetricsFromStage(record, index),
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

function arrayFromItem(item: Record<string, unknown>, key: string): unknown[] {
  const value = item[key];
  return Array.isArray(value) ? value : [];
}

function functionName(tool: unknown): string | null {
  const record = objectValue(tool);
  const fn = objectValue(record?.function);
  return textFromValue(fn?.name) ?? textFromValue(record?.name);
}

function functionDescription(tool: unknown): string | undefined {
  const record = objectValue(tool);
  const fn = objectValue(record?.function);
  return textFromValue(fn?.description) ?? textFromValue(record?.description) ?? undefined;
}

function functionParameters(tool: unknown): Record<string, unknown> {
  const record = objectValue(tool);
  const fn = objectValue(record?.function);
  const parameters = objectValue(fn?.parameters) ?? objectValue(record?.parameters) ?? objectValue(record?.input_schema);
  return parameters ?? { type: 'object', properties: {} };
}

function openAiToolsFromItem(item: Record<string, unknown>): unknown[] | undefined {
  const tools = arrayFromItem(item, 'tools');
  return tools.length > 0 ? tools : undefined;
}

function anthropicToolsFromItem(item: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const tools = arrayFromItem(item, 'tools')
    .map((tool) => {
      const name = functionName(tool);
      if (!name) return null;
      const declaration: Record<string, unknown> = {
        name,
        ...(functionDescription(tool) ? { description: functionDescription(tool) } : {}),
        input_schema: functionParameters(tool)
      };
      return declaration;
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null);
  return tools.length > 0 ? tools : undefined;
}

function geminiToolsFromItem(item: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const functionDeclarations = arrayFromItem(item, 'tools')
    .map((tool) => {
      const name = functionName(tool);
      if (!name) return null;
      const declaration: Record<string, unknown> = {
        name,
        ...(functionDescription(tool) ? { description: functionDescription(tool) } : {}),
        parameters: functionParameters(tool)
      };
      return declaration;
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null);
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

function toolChoiceFromSource(item: Record<string, unknown>, params: Record<string, unknown>): unknown {
  return item.tool_choice ?? params.tool_choice;
}

function openAiToolChoice(choice: unknown): unknown {
  return choice;
}

function anthropicToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === undefined || choice === null) return undefined;
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'string') return { type: 'tool', name: choice };
  const record = objectValue(choice);
  const fn = objectValue(record?.function);
  const name = textFromValue(fn?.name) ?? textFromValue(record?.name);
  return name ? { type: 'tool', name } : choice;
}

function geminiToolConfig(choice: unknown): unknown {
  if (choice === undefined || choice === null || choice === 'auto') return undefined;
  if (choice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (choice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (typeof choice === 'string') {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice] } };
  }
  const record = objectValue(choice);
  const fn = objectValue(record?.function);
  const name = textFromValue(fn?.name) ?? textFromValue(record?.name);
  return name ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } } : choice;
}

function anthropicMessages(messages: Array<Record<string, string>>): Array<Record<string, string>> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    }));
}

function systemPromptFromMessages(messages: Array<Record<string, string>>): string | undefined {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  return system.trim().length > 0 ? system : undefined;
}

function geminiContents(messages: Array<Record<string, string>>): Array<Record<string, unknown>> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
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
    const tools = openAiToolsFromItem(item);
    const toolChoice = openAiToolChoice(toolChoiceFromSource(item, params));
    if (tools) payload.tools = tools;
    if (toolChoice !== undefined && toolChoice !== null) payload.tool_choice = toolChoice;
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
      ...(openAiToolsFromItem(item) ? { tools: openAiToolsFromItem(item) } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {})
    };
  }

  if (protocol === 'anthropic_messages') {
    if (stream) {
      throw new BenchmarkValidationError('Streaming benchmark execution is not supported for anthropic_messages in this checkpoint.');
    }
    const payload: Record<string, unknown> = {
      model,
      messages: anthropicMessages(messages),
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens : 1024
    };
    const system = systemPromptFromMessages(messages);
    const tools = anthropicToolsFromItem(item);
    const toolChoice = anthropicToolChoice(toolChoiceFromSource(item, params));
    if (system) payload.system = system;
    if (params.temperature !== undefined && params.temperature !== null) payload.temperature = params.temperature;
    if (params.top_p !== undefined && params.top_p !== null) payload.top_p = params.top_p;
    if (params.stop !== undefined && params.stop !== null) payload.stop_sequences = params.stop;
    if (tools) payload.tools = tools;
    if (toolChoice !== undefined && toolChoice !== null) payload.tool_choice = toolChoice;
    return payload;
  }

  if (protocol === 'gemini_generate_content') {
    if (stream) {
      throw new BenchmarkValidationError('Streaming benchmark execution is not supported for gemini_generate_content in this checkpoint.');
    }
    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined && params.temperature !== null) generationConfig.temperature = params.temperature;
    if (params.top_p !== undefined && params.top_p !== null) generationConfig.topP = params.top_p;
    if (params.max_tokens !== undefined && params.max_tokens !== null) generationConfig.maxOutputTokens = params.max_tokens;
    if (params.stop !== undefined && params.stop !== null) generationConfig.stopSequences = params.stop;
    const system = systemPromptFromMessages(messages);
    const tools = geminiToolsFromItem(item);
    const toolConfig = geminiToolConfig(toolChoiceFromSource(item, params));
    return {
      contents: geminiContents(messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(tools ? { tools } : {}),
      ...(toolConfig ? { toolConfig } : {})
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

function extractLoadDurationMs(metadata: Record<string, unknown> | null): number | null {
  // Ollama: load_duration is nanoseconds
  if (typeof metadata?.load_duration === 'number') return metadata.load_duration / 1e6;
  // oMLX: usage.model_load_duration is seconds
  const usage = objectValue(metadata?.usage);
  if (typeof usage?.model_load_duration === 'number') return usage.model_load_duration * 1000;
  return null;
}

function extractServerTotalTimeMs(metadata: Record<string, unknown> | null): number | null {
  // Ollama/Inferencer: total_duration is nanoseconds
  if (typeof metadata?.total_duration === 'number') return metadata.total_duration / 1e6;
  // oMLX: usage.total_time is seconds
  const usage = objectValue(metadata?.usage);
  if (typeof usage?.total_time === 'number') return usage.total_time * 1000;
  return null;
}

function extractServerPromptEvalMs(metadata: Record<string, unknown> | null): number | null {
  if (typeof metadata?.prompt_eval_duration === 'number') return metadata.prompt_eval_duration / 1e6;
  return null;
}

function extractServerEvalMs(metadata: Record<string, unknown> | null): number | null {
  if (typeof metadata?.eval_duration === 'number') return metadata.eval_duration / 1e6;
  return null;
}

function usageTokens(metadata: Record<string, unknown> | null): Pick<NormalizedResponse, 'input_tokens' | 'output_tokens' | 'total_tokens'> {
  const usage = objectValue(metadata?.usage);
  const usageMetadata = objectValue(metadata?.usageMetadata);
  const inputTokens = numberAt(usage, 'prompt_tokens')
    ?? numberAt(usage, 'input_tokens')
    ?? numberAt(usageMetadata, 'promptTokenCount')
    ?? numberAt(metadata, 'prompt_eval_count');
  const outputTokens = numberAt(usage, 'completion_tokens')
    ?? numberAt(usage, 'output_tokens')
    ?? numberAt(usageMetadata, 'candidatesTokenCount')
    ?? numberAt(metadata, 'eval_count');
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberAt(usage, 'total_tokens')
      ?? numberAt(usageMetadata, 'totalTokenCount')
      ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
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
    load_duration_ms: extractLoadDurationMs(stream.final_metadata),
    server_total_time_ms: extractServerTotalTimeMs(stream.final_metadata),
    server_prompt_eval_ms: extractServerPromptEvalMs(stream.final_metadata),
    server_eval_ms: extractServerEvalMs(stream.final_metadata),
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

function normalizeAnthropicResponse(record: Record<string, unknown>): NormalizedResponse {
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];
  for (const block of content) {
    const entry = objectValue(block);
    if (!entry) continue;
    if (entry.type === 'text' && typeof entry.text === 'string') {
      textParts.push(entry.text);
    }
    if (entry.type === 'tool_use') {
      const name = textFromValue(entry.name);
      if (name) {
        toolCalls.push({
          id: textFromValue(entry.id) ?? undefined,
          type: 'function',
          function: {
            name,
            arguments: entry.input ?? {}
          }
        });
      }
    }
  }
  return {
    answer_text: textParts.join(''),
    ...usageTokens(record),
    load_duration_ms: extractLoadDurationMs(record),
    server_total_time_ms: extractServerTotalTimeMs(record),
    server_prompt_eval_ms: extractServerPromptEvalMs(record),
    server_eval_ms: extractServerEvalMs(record),
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
    body: record,
    text: null
  };
}

function normalizeGeminiResponse(record: Record<string, unknown>): NormalizedResponse {
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const firstCandidate = objectValue(candidates[0]);
  const content = objectValue(firstCandidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];
  for (const part of parts) {
    const entry = objectValue(part);
    if (!entry) continue;
    if (typeof entry.text === 'string') {
      textParts.push(entry.text);
    }
    const functionCall = objectValue(entry.functionCall);
    const name = textFromValue(functionCall?.name);
    if (name) {
      toolCalls.push({
        type: 'function',
        function: {
          name,
          arguments: objectValue(functionCall?.args) ?? {}
        }
      });
    }
  }
  return {
    answer_text: textParts.join(''),
    ...usageTokens(record),
    load_duration_ms: extractLoadDurationMs(record),
    server_total_time_ms: extractServerTotalTimeMs(record),
    server_prompt_eval_ms: extractServerPromptEvalMs(record),
    server_eval_ms: extractServerEvalMs(record),
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
    body: record,
    text: null
  };
}

function normalizeResponse(protocol: unknown, body: unknown, text: string | null): NormalizedResponse {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (protocol === 'anthropic_messages') {
      return normalizeAnthropicResponse(record);
    }
    if (protocol === 'gemini_generate_content') {
      return normalizeGeminiResponse(record);
    }
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
      load_duration_ms: extractLoadDurationMs(record),
      server_total_time_ms: extractServerTotalTimeMs(record),
      server_prompt_eval_ms: extractServerPromptEvalMs(record),
      server_eval_ms: extractServerEvalMs(record),
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
    load_duration_ms: null,
    server_total_time_ms: null,
    server_prompt_eval_ms: null,
    server_eval_ms: null,
    tool_calls: null,
    body,
    text
  };
}

function providerHeaders(protocol: unknown): Record<string, string> {
  if (protocol === 'anthropic_messages') {
    return { 'anthropic-version': '2023-06-01' };
  }
  return {};
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
  const pairMeta = executable.pairMemberId ? { pair_member_id: executable.pairMemberId } : {};

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await backendFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...providerHeaders(operationSpec?.protocol), ...authHeaders },
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
          : normalizeResponse(operationSpec?.protocol, responseBody, responseBody === null ? responseText : null);
      } catch (error) {
        if (!(error instanceof BenchmarkStreamParseError)) {
          throw error;
        }
        const issue = {
          code: error.code,
          message: error.message,
          retryable: false,
          stage_id: stage.id,
          ...pairMeta,
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
            ...pairMeta,
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
            ...pairMeta,
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
            ...pairMeta,
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
            ...pairMeta,
            item_index: executable.itemIndex,
            iteration: executable.iteration,
            elapsed_ms: elapsedMs,
            first_token_ms: firstTokenMs,
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
            load_duration_ms: null,
            server_total_time_ms: null,
            server_prompt_eval_ms: null,
            server_eval_ms: null
          },
          error: issue
        };
      }
      const rawResponse = {
        stage_id: stage.id,
        ...pairMeta,
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
        ...pairMeta,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        elapsed_ms: elapsedMs,
        first_token_ms: firstTokenMs,
        input_tokens: normalized.input_tokens,
        output_tokens: normalized.output_tokens,
        total_tokens: normalized.total_tokens,
        load_duration_ms: normalized.load_duration_ms,
        server_total_time_ms: normalized.server_total_time_ms,
        server_prompt_eval_ms: normalized.server_prompt_eval_ms,
        server_eval_ms: normalized.server_eval_ms
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
            ...pairMeta,
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
            ...pairMeta,
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
        ...pairMeta,
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
            ...pairMeta,
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
            ...pairMeta,
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
        ...pairMeta,
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
            ...pairMeta,
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

function skippedPairResult(executable: ExecutableItem, reason: string): Record<string, unknown> {
  return {
    item_index: executable.itemIndex,
    iteration: executable.iteration,
    status: 'skipped',
    skipped_reason: reason,
    members: {},
    derived_metrics: {}
  };
}

function memberMetricRequest(stage: BenchmarkStage, requestedMetrics: string[]): string[] {
  const metrics = new Set(BUILT_IN_METRICS);
  for (const metric of requestedMetrics) {
    if (BUILT_IN_METRICS.includes(metric)) {
      metrics.add(metric);
      continue;
    }
    const parts = metric.split('.');
    if (parts.length === 3 && parts[0] === 'pair') {
      metrics.add(parts[2]);
    }
  }
  for (const metric of stage.derived_metrics ?? []) {
    for (const ref of [metric.left, metric.right]) {
      const parts = ref.split('.');
      metrics.add(parts[0] === 'pair' ? parts[2] : parts[1]);
    }
  }
  return [...metrics].filter((metric) => BUILT_IN_METRICS.includes(metric));
}

function pairMetricValue(metricsByMember: Map<string, Record<string, unknown>>, ref: string): number | null {
  const parts = ref.split('.');
  const memberId = parts[0] === 'pair' ? parts[1] : parts[0];
  const metricName = parts[0] === 'pair' ? parts[2] : parts[1];
  const value = metricsByMember.get(memberId)?.[metricName];
  return typeof value === 'number' ? value : null;
}

function computePairMetrics(
  stage: BenchmarkStage,
  requestedMetrics: string[],
  metricsByMember: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  for (const metric of requestedMetrics) {
    const parts = metric.split('.');
    if (parts.length !== 3 || parts[0] !== 'pair') {
      continue;
    }
    metrics[metric] = pairMetricValue(metricsByMember, metric);
  }
  const derived: Record<string, unknown> = {};
  for (const metric of stage.derived_metrics ?? []) {
    const left = pairMetricValue(metricsByMember, metric.left);
    const right = pairMetricValue(metricsByMember, metric.right);
    derived[metric.id] = left !== null && right !== null ? left - right : null;
    metrics[metric.id] = derived[metric.id];
  }
  return metrics;
}

async function executePair(
  instantiation: Record<string, unknown>,
  stage: BenchmarkStage,
  executable: ExecutableItem,
  policy: ExecutionPolicy,
  authHeaders: Record<string, string>,
  requestedMetrics: string[]
): Promise<{
  result: Record<string, unknown>;
  rawResponses: Record<string, unknown>[];
  normalizedResponses: Record<string, unknown>[];
  metrics: Record<string, unknown> | null;
  errors: Record<string, unknown>[];
}> {
  const pair = stage.pair ?? [];
  const memberRequestedMetrics = memberMetricRequest(stage, requestedMetrics);
  const members: Record<string, unknown> = {};
  const metricsByMember = new Map<string, Record<string, unknown>>();
  const rawResponses: Record<string, unknown>[] = [];
  const normalizedResponses: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const startedAt = nowIso();

  await sleep(stage.pre_iteration_delay_ms ?? 0);

  for (let memberIndex = 0; memberIndex < pair.length; memberIndex += 1) {
    const member = pair[memberIndex];
    const execution = await executeItem(
      instantiation,
      stage,
      { ...executable, pairMemberId: member.id },
      policy,
      authHeaders,
      memberRequestedMetrics
    );
    if (execution.rawResponse) rawResponses.push(execution.rawResponse);
    if (execution.normalizedResponse) normalizedResponses.push(execution.normalizedResponse);
    if (execution.metrics) metricsByMember.set(member.id, execution.metrics);
    if (execution.error) errors.push(execution.error);
    members[member.id] = {
      role: member.role ?? null,
      result: execution.result,
      metrics: execution.metrics,
      error: execution.error
    };
    if (execution.error) {
      break;
    }
    if (memberIndex < pair.length - 1) {
      await sleep(stage.intra_pair_delay_ms ?? 0);
    }
  }

  const completedAt = nowIso();
  const pairMetrics = errors.length === 0 ? computePairMetrics(stage, requestedMetrics, metricsByMember) : {};
  const pairMetricRow = errors.length === 0
    ? {
        stage_id: stage.id,
        item_index: executable.itemIndex,
        iteration: executable.iteration,
        ...pairMetrics
      }
    : null;

  return {
    result: {
      item_index: executable.itemIndex,
      iteration: executable.iteration,
      status: errors.length > 0 ? 'failed' : 'completed',
      started_at: startedAt,
      completed_at: completedAt,
      members,
      derived_metrics: Object.fromEntries(
        Object.entries(pairMetrics).filter(([key]) => (stage.derived_metrics ?? []).some((metric) => metric.id === key))
      )
    },
    rawResponses,
    normalizedResponses,
    metrics: pairMetricRow,
    errors
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
        results.push(stage.type === 'paired_request_loop' ? skippedPairResult(item, cancellation) : skippedResult(item, cancellation));
        continue;
      }
      const execution = stage.type === 'paired_request_loop'
        ? await executePair(record.document, stage, item, policy, authHeaders, requestedMetrics)
        : await executeItem(record.document, stage, item, policy, authHeaders, requestedMetrics);
      results.push(execution.result);
      if ('rawResponses' in execution) {
        rawResponses.push(...execution.rawResponses);
      } else if (execution.rawResponse) {
        rawResponses.push(execution.rawResponse);
      }
      if ('normalizedResponses' in execution) {
        normalizedResponses.push(...execution.normalizedResponses);
      } else if (execution.normalizedResponse) {
        normalizedResponses.push(execution.normalizedResponse);
      }
      if (execution.metrics && (stage.record_metrics !== false)) metricResults.push(execution.metrics);
      const executionErrors = 'errors' in execution ? execution.errors : execution.error ? [execution.error] : [];
      if (executionErrors.length > 0) {
        stageErrors.push(...executionErrors);
        errors.push(...executionErrors);
        consecutiveErrors += 1;
        const reason = cancellationReason({
          policy: policy.cancellation,
          stage,
          latestError: executionErrors[executionErrors.length - 1],
          errors: stageErrors.length,
          completed: completedItems,
          consecutiveErrors
        });
        if (reason) {
          runCancelled = true;
          cancellation = reason;
          for (const remaining of executable.slice(itemIndex + 1)) {
            results.push(stage.type === 'paired_request_loop' ? skippedPairResult(remaining, reason) : skippedResult(remaining, reason));
          }
          break;
        }
      } else {
        consecutiveErrors = 0;
        completedItems += 1;
      }
      await sleep(stage.cooldown_ms ?? 0);
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
    load_estimate: estimateRequestTriggeredLoad(metricResults),
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
