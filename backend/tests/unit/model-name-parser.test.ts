import { describe, expect, it } from 'vitest';

import { guessModelCharacteristics, extractBaseModelName } from '../../src/services/model-name-parser.js';

describe('guessModelCharacteristics', () => {
  it('extracts params, quantisation, and provider from an MLX name', () => {
    const result = guessModelCharacteristics('/inferencerlabs/Devstral-Small-2-24B-Instruct-2512-MLX-6.5bit');
    expect(result.provider).toBe('mistral');
    expect(result.quantized_provider).toBe('inferencerlabs');
    expect(result.parameter_count).toBe(24_000_000_000);
    expect(result.parameter_count_label).toBe('24B');
    expect(result.active_parameter_label).toBeNull();
    expect(result.format).toBe('MLX');
    expect(result.quantisation.method).toBe('mlx');
    expect(result.quantisation.bits).toBe(6.5);
    expect(result.use_case.instruct).toBe(true);
    expect(result.use_case.coding).toBe(true);
    expect(result.precision).toBeNull();
  });

  it('extracts Qwen3 Coder MoE metadata from provider-prefixed MLX names', () => {
    const result = guessModelCharacteristics('inferencerlabs/Qwen3-Coder-30B-A3B-Instruct-MLX-6.5bit');
    expect(result.quantized_provider).toBe('inferencerlabs');
    expect(result.parameter_count).toBe(30_000_000_000);
    expect(result.parameter_count_label).toBe('30B');
    expect(result.active_parameter_label).toBe('A3B');
    expect(result.format).toBe('MLX');
    expect(result.quantisation.method).toBe('mlx');
    expect(result.quantisation.bits).toBe(6.5);
    expect(result.use_case.instruct).toBe(true);
    expect(result.use_case.coding).toBe(true);
    expect(result.use_case.mixture_of_experts).toBe(true);
  });

  it('extracts meta and precision hints', () => {
    const result = guessModelCharacteristics('meta-llama/Llama-3.1-8B-Instruct-fp16');
    expect(result.provider).toBe('meta');
    expect(result.parameter_count).toBe(8_000_000_000);
    expect(result.precision).toBe('fp16');
  });

  it('extracts AWQ quantisation', () => {
    const result = guessModelCharacteristics('Qwen2.5-72B-AWQ');
    expect(result.provider).toBe('qwen');
    expect(result.parameter_count).toBe(72_000_000_000);
    expect(result.quantisation.method).toBe('awq');
  });

  it('parses quantisation bits from long provider-controlled model labels', () => {
    const result = guessModelCharacteristics(`vendor/model-${'segment-'.repeat(200)}Q4_K_M`);
    expect(result.quantisation.bits).toBe(4);
  });

  it('extracts Moonshot provider from Kimi model names', () => {
    expect(guessModelCharacteristics('moonshotai/Kimi-K2-Instruct').provider).toBe('moonshot');
    expect(guessModelCharacteristics('Kimi-Linear-48B-AWQ').provider).toBe('moonshot');
  });
});

describe('extractBaseModelName', () => {
  it('strips leading /prefix/ and trailing format+bit tokens', () => {
    expect(extractBaseModelName('/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-6bit')).toBe(
      'Qwen3-Coder'
    );
  });

  it('strips leading /prefix/ and trailing MLX, decimal-bit, and revision tokens', () => {
    expect(extractBaseModelName('/inferencerlabs/Devstral-Small-2-24B-Instruct-2512-MLX-6.5bit')).toBe(
      'Devstral-Small-2'
    );
  });

  it('strips org/ prefix without leading slash and trailing precision label', () => {
    expect(extractBaseModelName('meta-llama/Llama-3.1-8B-Instruct-fp16')).toBe('Llama-3.1');
  });

  it('strips trailing AWQ token with no prefix', () => {
    expect(extractBaseModelName('Qwen2.5-72B-AWQ')).toBe('Qwen2.5');
  });

  it('strips compound GGUF quantization suffixes', () => {
    expect(extractBaseModelName('/inferencerlabs/Devstral-Small-24B-Instruct-GGUF-Q4_K_M')).toBe(
      'Devstral-Small'
    );
  });

  it('returns the model name unchanged when there are no strippable tokens', () => {
    expect(extractBaseModelName('unknown-model')).toBe('unknown-model');
  });

  it('returns null for empty string', () => {
    expect(extractBaseModelName('')).toBeNull();
  });
});
