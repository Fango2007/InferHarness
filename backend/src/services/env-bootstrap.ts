import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..', '..');
const defaultEnvPath = path.join(repoRoot, '.env');
const BACKEND_TOKEN_KEY = 'INFERHARNESS_API_TOKEN';
const FRONTEND_TOKEN_KEY = 'VITE_INFERHARNESS_API_TOKEN';

export interface EnvBootstrapResult {
  changed: boolean;
  generated: boolean;
  tokenSource: 'existing' | 'generated';
  warnings: string[];
}

interface EnvBootstrapOptions {
  envPath?: string;
  env?: NodeJS.ProcessEnv;
}

function readEnvLines(envPath: string): string[] {
  if (!fs.existsSync(envPath)) {
    return [];
  }
  return fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
}

function envEntries(lines: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    if (!key || entries.has(key)) {
      continue;
    }
    entries.set(key, line.slice(eqIndex + 1).trim());
  }
  return entries;
}

function upsertEnvLine(lines: string[], key: string, value: string): boolean {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    if (line.slice(0, eqIndex).trim() === key) {
      if (line === `${key}=${value}`) {
        return false;
      }
      lines[index] = `${key}=${value}`;
      return true;
    }
  }

  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('');
  }
  lines.push(`${key}=${value}`);
  return true;
}

function writeEnvLines(envPath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const output = lines.filter((line, index, array) => index < array.length - 1 || line.trim() !== '');
  fs.writeFileSync(envPath, `${output.join('\n')}${output.length ? '\n' : ''}`, 'utf8');
}

function generateToken(): string {
  return `ih_${crypto.randomBytes(24).toString('base64url')}`;
}

export function ensureLocalApiTokenEnv(options: EnvBootstrapOptions = {}): EnvBootstrapResult {
  const envPath = options.envPath ?? defaultEnvPath;
  const env = options.env ?? process.env;
  const lines = readEnvLines(envPath);
  const entries = envEntries(lines);
  const backendToken = env[BACKEND_TOKEN_KEY] || entries.get(BACKEND_TOKEN_KEY);
  const frontendToken = env[FRONTEND_TOKEN_KEY] || entries.get(FRONTEND_TOKEN_KEY);
  const warnings: string[] = [];

  if (backendToken && frontendToken && backendToken !== frontendToken) {
    warnings.push(`${BACKEND_TOKEN_KEY} and ${FRONTEND_TOKEN_KEY} differ; leaving existing values unchanged.`);
    env[BACKEND_TOKEN_KEY] = backendToken;
    env[FRONTEND_TOKEN_KEY] = frontendToken;
    return { changed: false, generated: false, tokenSource: 'existing', warnings };
  }

  const generated = !backendToken && !frontendToken;
  const token = backendToken || frontendToken || generateToken();
  let changed = false;

  if (!entries.has(BACKEND_TOKEN_KEY) && !env[BACKEND_TOKEN_KEY]) {
    changed = upsertEnvLine(lines, BACKEND_TOKEN_KEY, token) || changed;
  }
  if (!entries.has(FRONTEND_TOKEN_KEY) && !env[FRONTEND_TOKEN_KEY]) {
    changed = upsertEnvLine(lines, FRONTEND_TOKEN_KEY, token) || changed;
  }

  env[BACKEND_TOKEN_KEY] = token;
  env[FRONTEND_TOKEN_KEY] = token;

  if (changed) {
    writeEnvLines(envPath, lines);
  }

  return {
    changed,
    generated,
    tokenSource: generated ? 'generated' : 'existing',
    warnings
  };
}
