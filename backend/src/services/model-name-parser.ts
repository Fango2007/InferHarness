import { ModelPrecision, ModelProvider, ModelQuantisationMethod } from '../models/model.js';

export interface ModelNameGuess {
  provider: ModelProvider | null;
  parameter_count: number | null;
  parameter_count_label: string | null;
  active_parameter_label: string | null;
  quantized_provider: string | null;
  format: 'MLX' | 'GGUF' | 'GPTQ' | 'AWQ' | 'SafeTensors' | null;
  quantisation: {
    method: ModelQuantisationMethod | null;
    bits: number | null;
  };
  precision: ModelPrecision | null;
  use_case: {
    thinking: boolean;
    coding: boolean;
    instruct: boolean;
    mixture_of_experts: boolean;
  };
}

const providerHints: Array<{ provider: ModelProvider; patterns: RegExp[] }> = [
  { provider: 'openai', patterns: [/openai/i, /\bgpt[-_ ]?\d/i] },
  { provider: 'meta', patterns: [/meta/i, /llama/i] },
  { provider: 'mistral', patterns: [/mistral/i, /devstral/i] },
  { provider: 'qwen', patterns: [/qwen/i] },
  { provider: 'google', patterns: [/google/i, /gemini/i] },
  { provider: 'moonshot', patterns: [/moonshot/i, /\bkimi\b/i] },
  { provider: 'cohere', patterns: [/cohere/i, /command/i] },
  { provider: 'deepseek', patterns: [/deepseek/i] },
  { provider: 'anthropic', patterns: [/anthropic/i, /claude/i] },
  { provider: 'nvidia', patterns: [/nvidia/i, /nemotron/i] },
  { provider: 'zai', patterns: [/zai/i, /01\.ai/i, /01ai/i, /\byi\b/i] },
  { provider: 'custom', patterns: [/custom/i] }
];

const quantisationHints: Array<{ method: ModelQuantisationMethod; patterns: RegExp[] }> = [
  { method: 'gguf', patterns: [/gguf/i, /gcuf/i] },
  { method: 'gptq', patterns: [/gptq/i] },
  { method: 'awq', patterns: [/awq/i] },
  { method: 'mlx', patterns: [/mlx/i] }
];

const precisionHints: Array<{ precision: ModelPrecision; patterns: RegExp[] }> = [
  { precision: 'fp32', patterns: [/fp32/i] },
  { precision: 'fp16', patterns: [/fp16/i] },
  { precision: 'bf16', patterns: [/bf16/i] },
  { precision: 'int8', patterns: [/int8/i] },
  { precision: 'int4', patterns: [/int4/i] }
];

function matchFirst<T>(text: string, entries: Array<{ value: T; patterns: RegExp[] }>): T | null {
  for (const entry of entries) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.value;
    }
  }
  return null;
}

function parseParameterCount(text: string): { count: number; label: string } | null {
  const pattern = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)(b|bn|billion|m|million)(?:[^a-z0-9]|$)/gi;
  let match: RegExpExecArray | null;
  let best: { count: number; label: string } | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const rawValue = parseFloat(match[1]);
    if (!Number.isFinite(rawValue)) {
      continue;
    }
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith('b') ? 1_000_000_000 : 1_000_000;
    const count = rawValue * multiplier;
    if (!best || count > best.count) {
      const label = `${rawValue}${unit.startsWith('b') ? 'B' : 'M'}`;
      best = { count, label };
    }
  }
  return best;
}

function parseQuantisationBits(text: string): number | null {
  const tokens = text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.endsWith('bit')) {
      const bits = Number.parseFloat(token.slice(0, -3));
      if (Number.isFinite(bits)) {
        return bits;
      }
    }
    if (tokens[index + 1] === 'bit') {
      const bits = Number.parseFloat(token);
      if (Number.isFinite(bits)) {
        return bits;
      }
    }
    if (token.startsWith('q') && token.length > 1) {
      const bits = Number.parseFloat(token.slice(1));
      if (Number.isFinite(bits)) {
        return bits;
      }
    }
  }
  return null;
}

export function extractBaseModelName(modelId: string): string | null {
  if (!modelId.trim()) {
    return null;
  }
  let name = modelId.replace(/^\/+/, '').split('/').filter(Boolean).pop() ?? '';
  let previous: string;
  do {
    previous = name;
    name = name.replace(
      /[-_](?:mlx|gguf|gcuf|gptq|awq|safetensors|\d+(?:\.\d+)?bit|q\d+(?:_k_[sml]|_[0-3])?|\d{4,}|a\d+(?:\.\d+)?[bm]|\d+(?:\.\d+)?(?:b|bn|billion|m|million)|instruct|chat|fp(?:16|32)|bf16|int[48])$/i,
      ''
    );
  } while (name !== previous);
  return name || null;
}

function parseActiveParameterLabel(text: string): string | null {
  const match = text.match(/(?:^|[-_\s])A(\d+(?:\.\d+)?[BM])(?:[-_\s]|$)/i);
  return match ? `A${match[1].toUpperCase()}` : null;
}

function parseModelFormat(text: string): ModelNameGuess['format'] {
  if (/\bmlx\b/i.test(text)) return 'MLX';
  if (/\b(?:gguf|gcuf)\b/i.test(text)) return 'GGUF';
  if (/\bgptq\b/i.test(text)) return 'GPTQ';
  if (/\bawq\b/i.test(text)) return 'AWQ';
  if (/\bsafetensors\b/i.test(text)) return 'SafeTensors';
  return null;
}

function quantMethodForFormat(format: ModelNameGuess['format']): ModelQuantisationMethod | null {
  if (format === 'MLX') return 'mlx';
  if (format === 'GGUF') return 'gguf';
  if (format === 'GPTQ') return 'gptq';
  if (format === 'AWQ') return 'awq';
  return null;
}

function parseQuantizedProvider(modelId: string, hasQuantizedMetadata: boolean): string | null {
  if (!hasQuantizedMetadata) {
    return null;
  }
  const parts = modelId.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return parts[0].includes('.') && parts.length > 2 ? parts[1] : parts[0];
}

function inferUseCase(text: string, activeParameterLabel: string | null): ModelNameGuess['use_case'] {
  return {
    thinking: /\b(thinking|reasoning|reasoner|qwq|r1)\b/i.test(text),
    coding: /\b(code|coder|coding|devstral)\b/i.test(text),
    instruct: /\b(instruct|chat)\b/i.test(text),
    mixture_of_experts: Boolean(activeParameterLabel) || /\b(moe|mixture[-_ ]?of[-_ ]?experts|mixtral)\b/i.test(text)
  };
}

export function guessModelCharacteristics(modelName: string): ModelNameGuess {
  const normalized = modelName.trim();
  const provider =
    matchFirst(normalized, providerHints.map((entry) => ({ value: entry.provider, patterns: entry.patterns }))) ??
    null;
  const quantMethod =
    matchFirst(normalized, quantisationHints.map((entry) => ({ value: entry.method, patterns: entry.patterns }))) ??
    null;
  const precision =
    matchFirst(normalized, precisionHints.map((entry) => ({ value: entry.precision, patterns: entry.patterns }))) ??
    null;
  const parameter = parseParameterCount(normalized);
  const activeParameterLabel = parseActiveParameterLabel(normalized);
  const format = parseModelFormat(normalized);
  const quantBits = parseQuantisationBits(normalized);
  const effectiveQuantMethod = quantMethod ?? quantMethodForFormat(format);

  return {
    provider,
    parameter_count: parameter?.count ?? null,
    parameter_count_label: parameter?.label ?? null,
    active_parameter_label: activeParameterLabel,
    quantized_provider: parseQuantizedProvider(normalized, Boolean(format || quantBits != null || effectiveQuantMethod)),
    format,
    quantisation: {
      method: effectiveQuantMethod,
      bits: quantBits
    },
    precision,
    use_case: inferUseCase(normalized, activeParameterLabel)
  };
}
