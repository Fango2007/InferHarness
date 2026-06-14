import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureLocalApiTokenEnv } from '../../src/services/env-bootstrap.js';

const tempDirs: string[] = [];

function tempEnvPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inferharness-env-'));
  tempDirs.push(dir);
  return path.join(dir, '.env');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('env bootstrap', () => {
  it('generates matching backend and frontend tokens when both are missing', () => {
    const envPath = tempEnvPath();
    const env: NodeJS.ProcessEnv = {};
    const result = ensureLocalApiTokenEnv({ envPath, env });

    expect(result.generated).toBe(true);
    expect(result.changed).toBe(true);
    expect(env.INFERHARNESS_API_TOKEN).toMatch(/^ih_/);
    expect(env.VITE_INFERHARNESS_API_TOKEN).toBe(env.INFERHARNESS_API_TOKEN);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`INFERHARNESS_API_TOKEN=${env.INFERHARNESS_API_TOKEN}`);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`VITE_INFERHARNESS_API_TOKEN=${env.INFERHARNESS_API_TOKEN}`);
  });

  it('adds the frontend token when a backend token already exists', () => {
    const envPath = tempEnvPath();
    fs.writeFileSync(envPath, 'INFERHARNESS_API_TOKEN=local-token\n', 'utf8');
    const env: NodeJS.ProcessEnv = {};
    const result = ensureLocalApiTokenEnv({ envPath, env });

    expect(result.generated).toBe(false);
    expect(result.changed).toBe(true);
    expect(env.INFERHARNESS_API_TOKEN).toBe('local-token');
    expect(env.VITE_INFERHARNESS_API_TOKEN).toBe('local-token');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('VITE_INFERHARNESS_API_TOKEN=local-token');
  });

  it('does not overwrite mismatched explicit tokens', () => {
    const envPath = tempEnvPath();
    fs.writeFileSync(envPath, 'INFERHARNESS_API_TOKEN=backend\nVITE_INFERHARNESS_API_TOKEN=frontend\n', 'utf8');
    const env: NodeJS.ProcessEnv = {};
    const result = ensureLocalApiTokenEnv({ envPath, env });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(env.INFERHARNESS_API_TOKEN).toBe('backend');
    expect(env.VITE_INFERHARNESS_API_TOKEN).toBe('frontend');
  });
});
