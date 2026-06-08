import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(moduleDir, '../..');
const SCRIPT = path.resolve(backendRoot, 'src/scripts/inspect_architecture.py');

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
}

function inspect(dir: string, format = 'gptq') {
  const stdout = execFileSync('python3', [SCRIPT, '--model_id', 'local/model', '--format', format, '--model_path', dir], {
    cwd: path.resolve(backendRoot, '..'),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Record<string, any>;
}

function lastJsonLine(stderr: string): any {
  const line = stderr.trim().split(/\r?\n/).reverse().find((entry) => entry.trim().startsWith('{'));
  if (!line) {
    throw new Error(`No JSON line in stderr: ${stderr}`);
  }
  return JSON.parse(line);
}

describe('inspect_architecture.py config fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-python-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds an estimated Mistral3-style tree from nested text_config dimensions', () => {
    writeConfig(tmpDir, {
      model_type: 'ministral3',
      architectures: ['Mistral3ForConditionalGeneration'],
      tie_word_embeddings: false,
      text_config: {
        model_type: 'mistral',
        vocab_size: 32_000,
        hidden_size: 128,
        intermediate_size: 256,
        num_hidden_layers: 40,
        num_attention_heads: 8,
        num_key_value_heads: 2,
      },
    });

    const tree = inspect(tmpDir, 'mlx');

    expect(tree.inspection_method).toBe('config_fallback');
    expect(tree.accuracy).toBe('estimated');
    expect(tree.root.type).toBe('Mistral3ForConditionalGeneration');
    expect(tree.summary.total_parameters).toBeGreaterThan(0);
    expect(tree.root.children.some((child: any) => child.name === 'embed_tokens')).toBe(true);
    expect(tree.root.children.find((child: any) => child.name === 'layers').children).toHaveLength(40);
    expect(tree.root.children.some((child: any) => child.name === 'norm')).toBe(true);
    expect(tree.root.children.some((child: any) => child.name === 'lm_head')).toBe(true);
  });

  it('uses config fallback for generic MLX models without requiring PyTorch', () => {
    writeConfig(tmpDir, {
      model_type: 'qwen3',
      architectures: ['Qwen3ForCausalLM'],
      vocab_size: 100,
      hidden_size: 16,
      intermediate_size: 32,
      num_hidden_layers: 2,
      num_attention_heads: 4,
      tie_word_embeddings: true,
    });

    const tree = inspect(tmpDir, 'mlx');

    expect(tree.format).toBe('mlx');
    expect(tree.inspection_method).toBe('config_fallback');
    expect(tree.root.type).toBe('Qwen3ForCausalLM');
    expect(tree.root.children.find((child: any) => child.name === 'layers').children).toHaveLength(2);
    expect(tree.warnings.join(' ')).toContain('Tied embeddings');
  });

  it('preserves composite root architecture while estimating nested decoder and vision blocks', () => {
    writeConfig(tmpDir, {
      model_type: 'vision_text',
      architectures: ['VisionTextForConditionalGeneration'],
      text_config: {
        vocab_size: 100,
        hidden_size: 16,
        intermediate_size: 32,
        num_hidden_layers: 1,
        num_attention_heads: 4,
      },
      vision_config: {
        image_size: 32,
        patch_size: 16,
        hidden_size: 8,
        intermediate_size: 16,
        num_hidden_layers: 1,
      },
      projector_config: { input_hidden_size: 8, hidden_size: 12 },
    });

    const tree = inspect(tmpDir);

    expect(tree.root.type).toBe('VisionTextForConditionalGeneration');
    expect(tree.root.children.some((child: any) => child.name === 'vision_tower')).toBe(true);
    expect(tree.root.children.some((child: any) => child.name === 'multi_modal_projector')).toBe(true);
    expect(tree.warnings.join(' ')).toContain('nested text config');
  });

  it('returns a structured not_inspectable error instead of a zero-parameter tree for missing dimensions', () => {
    writeConfig(tmpDir, {
      model_type: 'unknown_decoder',
      architectures: ['UnknownModel'],
      hidden_size: 128,
    });

    const result = spawnSync('python3', [SCRIPT, '--model_id', 'local/model', '--format', 'gptq', '--model_path', tmpDir], {
      cwd: path.resolve(backendRoot, '..'),
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(lastJsonLine(result.stderr).error).toBe('not_inspectable');
  });

  it('excludes duplicate lm_head parameters for tied embeddings', () => {
    writeConfig(tmpDir, {
      model_type: 'unknown_decoder',
      vocab_size: 10,
      hidden_size: 8,
      intermediate_size: 16,
      num_hidden_layers: 1,
      num_attention_heads: 2,
      tie_word_embeddings: true,
    });

    const tree = inspect(tmpDir);

    expect(tree.root.children.some((child: any) => child.name === 'lm_head')).toBe(false);
    expect(tree.warnings.join(' ')).toContain('Tied embeddings');
  });

  it('creates MoE router and expert nodes from common MoE config keys', () => {
    writeConfig(tmpDir, {
      model_type: 'unknown_moe',
      vocab_size: 10,
      hidden_size: 8,
      intermediate_size: 16,
      moe_intermediate_size: 12,
      num_hidden_layers: 1,
      num_attention_heads: 2,
      num_experts: 3,
    });

    const tree = inspect(tmpDir);
    const layer = tree.root.children.find((child: any) => child.name === 'layers').children[0];
    const moe = layer.children.find((child: any) => child.type === 'ConfigMoE');

    expect(moe.children.some((child: any) => child.type === 'Router')).toBe(true);
    expect(moe.children.find((child: any) => child.name === 'experts').children).toHaveLength(3);
    expect(tree.summary.total_parameters).toBeGreaterThan(0);
  });
});

describe('inspect_architecture.py SafeTensors header inspection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-safetensors-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads local SafeTensors shapes from the header without tensor payloads', () => {
    const header = Buffer.from(JSON.stringify({
      '__metadata__': { format: 'pt' },
      'model.embed_tokens.weight': { dtype: 'F16', shape: [10, 8], data_offsets: [0, 160] },
      'model.layers.0.self_attn.q_proj.weight': { dtype: 'F16', shape: [8, 8], data_offsets: [160, 288] },
    }));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(header.length));
    fs.writeFileSync(path.join(tmpDir, 'model.safetensors'), Buffer.concat([prefix, header]));

    const tree = inspect(tmpDir, 'safetensors');

    expect(tree.inspection_method).toBe('safetensors_header');
    expect(tree.accuracy).toBe('exact');
    expect(tree.summary.total_parameters).toBe(144);
    expect(tree.root.children.length).toBeGreaterThan(0);
  });
});
