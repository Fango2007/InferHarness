import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { validateWithSchema } from '../../src/services/schema-validator.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const IC_SCHEMA = path.resolve(moduleDir, '../../src/schemas/inference-config.schema.json');
const EVAL_SCHEMA = path.resolve(moduleDir, '../../src/schemas/evaluation.schema.json');

describe('inference-config.schema.json', () => {
  it('accepts an all-null inference_config', () => {
    const result = validateWithSchema(IC_SCHEMA, {
      temperature: null,
      top_p: null,
      max_tokens: null,
      quantization_level: null
    });
    expect(result.ok).toBe(true);
  });

  it('accepts valid numeric values', () => {
    const result = validateWithSchema(IC_SCHEMA, {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 2048,
      quantization_level: 'int4'
    });
    expect(result.ok).toBe(true);
  });

  it('accepts benchmark runtime parameters', () => {
    const result = validateWithSchema(IC_SCHEMA, {
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 512,
      stream: false,
      seed: 42,
      stop: ['END'],
      presence_penalty: 0,
      frequency_penalty: 0,
      timeout_ms: 300000,
      unsupported_parameter_policy: 'strict'
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty object (no required fields)', () => {
    const result = validateWithSchema(IC_SCHEMA, {});
    expect(result.ok).toBe(true);
  });

  it('rejects temperature > 2', () => {
    const result = validateWithSchema(IC_SCHEMA, { temperature: 2.1 });
    expect(result.ok).toBe(false);
  });

  it('rejects top_p > 1', () => {
    const result = validateWithSchema(IC_SCHEMA, { top_p: 1.1 });
    expect(result.ok).toBe(false);
  });

  it('rejects max_tokens < 1', () => {
    const result = validateWithSchema(IC_SCHEMA, { max_tokens: 0 });
    expect(result.ok).toBe(false);
  });

  it('rejects unsupported parameter policy outside the canonical vocabulary', () => {
    const result = validateWithSchema(IC_SCHEMA, { unsupported_parameter_policy: 'drop' });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown property (additionalProperties: false)', () => {
    const result = validateWithSchema(IC_SCHEMA, { unknown_field: 'value' });
    expect(result.ok).toBe(false);
  });
});

const VALID_EVAL = {
  prompt_text: 'What is 2+2?',
  tags: [],
  server_id: 'srv-1',
  model_name: 'llama3',
  inference_config: { temperature: null, top_p: null, max_tokens: null, quantization_level: null },
  answer_text: '4',
  accuracy_score: 5,
  relevance_score: 5,
  coherence_score: 5,
  completeness_score: 5,
  helpfulness_score: 5
};

describe('evaluation.schema.json', () => {
  it('accepts a valid evaluation payload', () => {
    const result = validateWithSchema(EVAL_SCHEMA, VALID_EVAL);
    expect(result.ok).toBe(true);
  });

  it('accepts optional nullable fields', () => {
    const result = validateWithSchema(EVAL_SCHEMA, {
      ...VALID_EVAL,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      latency_ms: 320.5,
      word_count: 1,
      estimated_cost: 0.0001,
      inference_config: {
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 512,
        stream: false,
        seed: 42,
        stop: 'END',
        presence_penalty: 0,
        frequency_penalty: 0,
        timeout_ms: 300000,
        unsupported_parameter_policy: 'permissive',
        quantization_level: null
      },
      note: 'Good answer'
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a score out of range (0)', () => {
    const result = validateWithSchema(EVAL_SCHEMA, { ...VALID_EVAL, accuracy_score: 0 });
    expect(result.ok).toBe(false);
  });

  it('rejects a score out of range (6)', () => {
    const result = validateWithSchema(EVAL_SCHEMA, { ...VALID_EVAL, helpfulness_score: 6 });
    expect(result.ok).toBe(false);
  });

  it('rejects missing required qualitative score', () => {
    const { accuracy_score: _, ...withoutScore } = VALID_EVAL;
    const result = validateWithSchema(EVAL_SCHEMA, withoutScore);
    expect(result.ok).toBe(false);
  });

  it('rejects note exceeding 2,000 chars', () => {
    const result = validateWithSchema(EVAL_SCHEMA, { ...VALID_EVAL, note: 'x'.repeat(2001) });
    expect(result.ok).toBe(false);
  });

  it('rejects missing prompt_text', () => {
    const { prompt_text: _, ...withoutPrompt } = VALID_EVAL;
    const result = validateWithSchema(EVAL_SCHEMA, withoutPrompt);
    expect(result.ok).toBe(false);
  });
});
