import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getInferenceServerById } from '../models/inference-server.js';
import { getAppSettings } from './app-settings.js';
import { buildInferenceServerAuthHeaders } from './inference-server-auth.js';
import { backendFetch } from './inference-proxy.js';
import { BenchmarkValidationError, validateAnyBenchmarkDocument } from './benchmark-foundation.js';

export type TemplateAgentMode = 'create' | 'modify';

export interface TemplateAgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TemplateAgentRequest {
  mode?: TemplateAgentMode;
  message?: string;
  conversation?: TemplateAgentMessage[];
  existing_template?: Record<string, unknown>;
}

export type TemplateAgentResponse =
  | { status: 'needs_input'; reply: string; questions?: string[] }
  | { status: 'draft_ready'; reply: string; template: Record<string, unknown>; validation: { ok: true; issues: [] } };

const AGENT_TIMEOUT_MS = 60_000;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const testTemplateSchema = JSON.parse(
  fs.readFileSync(path.resolve(moduleDir, '../schemas/benchmark/test_template.schema.json'), 'utf8')
) as Record<string, unknown>;
const agentPromptTemplate = fs.readFileSync(
  path.resolve(moduleDir, '../prompts/benchmark-template-agent.md'),
  'utf8'
);

const validTemplateExample = {
  kind: 'test_template',
  schema_version: 'benchmark_test_template_v1',
  template_id: 'concise_answer_quality_v1',
  template_version: '1.0.0',
  name: 'Concise answer quality',
  description: 'Measures whether chat responses stay concise while preserving required facts.',
  operation: 'chat_completion',
  required_capabilities: {
    chat_completion: true,
    streaming: false,
    tool_calling: false,
    structured_output: false
  },
  input_contract: {
    required_fields: ['prompt'],
    optional_fields: ['system_prompt', 'expected_format', 'expected_answer', 'required_terms', 'tags', 'metadata'],
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
  metrics: ['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms', 'tokens_per_second', 'contains_required_terms'],
  aggregations: ['mean', 'p95', 'count'],
  metadata: {
    source: 'template-agent',
    evaluation_intent: 'concise factual answer quality'
  }
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function parseAgentJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw Object.assign(new Error('Template agent did not return JSON.'), { statusCode: 502 });
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function agentSystemPrompt(): string {
  return agentPromptTemplate
    .replace('{{TEST_TEMPLATE_SCHEMA_JSON}}', JSON.stringify(testTemplateSchema, null, 2))
    .replace('{{VALID_TEMPLATE_EXAMPLE_JSON}}', JSON.stringify(validTemplateExample, null, 2));
}

function userContext(input: Required<Pick<TemplateAgentRequest, 'mode' | 'message'>> & Pick<TemplateAgentRequest, 'existing_template'>): string {
  return JSON.stringify({
    mode: input.mode,
    user_request: input.message,
    existing_template: input.existing_template ?? null,
    runnable_constraints: {
      operation: 'chat_completion',
      schema_version: 'benchmark_test_template_v1',
      must_validate_against_schema_id: testTemplateSchema.$id,
      must_not_auto_save: true,
      supported_stage_types: ['dataset_loop', 'single_request', 'paired_request_loop'],
      supported_metrics: [
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'elapsed_ms',
        'first_token_ms',
        'tokens_per_second',
        'decode_tokens_per_second',
        'prefill_tokens_per_second',
        'output_input_token_ratio',
        'json_valid',
        'schema_valid',
        'regex_match',
        'exact_match',
        'contains_required_terms'
      ],
      supported_aggregations: ['mean', 'median', 'min', 'max', 'sum', 'count', 'p50', 'p90', 'p95', 'p99', 'stddev', 'variance']
    },
    expected_agent_output: {
      needs_input: { status: 'needs_input', reply: 'Brief explanation of what is missing.', questions: ['Specific question for the user.'] },
      draft_ready: { status: 'draft_ready', reply: 'Brief summary of the draft.', template: validTemplateExample }
    }
  });
}

function responseText(protocol: string, body: unknown): string {
  const record = objectValue(body);
  if (!record) return '';
  if (protocol === 'ollama') {
    const message = objectValue(record.message);
    return typeof message?.content === 'string' ? message.content : '';
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = objectValue(choices[0]);
  const message = objectValue(first?.message);
  return typeof message?.content === 'string' ? message.content : '';
}

function normalizeAgentResponse(payload: Record<string, unknown>): TemplateAgentResponse {
  if (payload.status === 'needs_input') {
    const reply = typeof payload.reply === 'string' && payload.reply.trim()
      ? payload.reply
      : 'I need more detail before I can define a viable benchmark template.';
    return { status: 'needs_input', reply, questions: stringArray(payload.questions) };
  }

  if (payload.status !== 'draft_ready') {
    throw Object.assign(new Error('Template agent returned an unsupported status.'), { statusCode: 502 });
  }

  const template = objectValue(payload.template);
  if (!template) {
    throw Object.assign(new Error('Template agent did not return a template draft.'), { statusCode: 502 });
  }
  if (template.operation !== 'chat_completion') {
    throw Object.assign(new Error('Template agent produced a template that is not runnable in this checkpoint.'), { statusCode: 502 });
  }
  const validation = validateAnyBenchmarkDocument(template, 'test_template');
  if (!validation.ok) {
    throw new BenchmarkValidationError('Template agent produced an invalid benchmark template.', validation.issues);
  }
  return {
    status: 'draft_ready',
    reply: typeof payload.reply === 'string' ? payload.reply : 'Template draft is ready for review.',
    template,
    validation: { ok: true, issues: [] }
  };
}

export async function runBenchmarkTemplateAgent(input: TemplateAgentRequest): Promise<TemplateAgentResponse> {
  const mode = input.mode === 'modify' ? 'modify' : 'create';
  const message = input.message?.trim();
  if (!message) {
    throw Object.assign(new Error('Template agent message is required.'), { statusCode: 400 });
  }

  const selected = getAppSettings().template_agent_model;
  if (!selected) {
    throw Object.assign(new Error('Configure a template agent model in Settings first.'), { statusCode: 400 });
  }
  const server = getInferenceServerById(selected.server_id);
  if (!server || server.inference_server.archived || !server.inference_server.active) {
    throw Object.assign(new Error('Configured template agent server is not active.'), { statusCode: 400 });
  }

  const schemaFamily = server.runtime.api.schema_family;
  const protocol = schemaFamily.includes('ollama') ? 'ollama' : schemaFamily.includes('openai-compatible') ? 'openai' : null;
  if (!protocol) {
    throw Object.assign(new Error('Template agent supports OpenAI-compatible and Ollama chat servers only.'), { statusCode: 400 });
  }

  const messages = [
    { role: 'system', content: agentSystemPrompt() },
    ...(input.conversation ?? []).filter((entry) => entry.role === 'user' || entry.role === 'assistant'),
    { role: 'user', content: userContext({ mode, message, existing_template: input.existing_template }) }
  ];
  const body = protocol === 'ollama'
    ? {
        model: selected.model_id,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 5000 }
      }
    : {
        model: selected.model_id,
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: 5000,
        response_format: { type: 'json_object' }
      };

  const endpoint = protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions';
  const url = new URL(endpoint, server.endpoints.base_url).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const response = await backendFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildInferenceServerAuthHeaders(server) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`Template agent model call failed with HTTP ${response.status}.`), { statusCode: 502 });
    }
    const parsedBody = rawText ? JSON.parse(rawText) as unknown : null;
    const content = responseText(protocol, parsedBody);
    return normalizeAgentResponse(parseAgentJson(content));
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw Object.assign(new Error('Template agent model call timed out.'), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
