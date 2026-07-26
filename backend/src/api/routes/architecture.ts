import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { FastifyInstance } from 'fastify';

import { createRateLimitPreHandler } from '../middleware/rate-limit.js';
import { getModelById } from '../../models/model.js';
import type { ModelRecord } from '../../models/model.js';
import { getInferenceServerById } from '../../models/inference-server.js';
import { getDb } from '../../models/db.js';
import {
  sanitizeModelId,
  readCachedTree,
  runInspection,
  deleteCacheFiles,
  ArchitectureTree,
  InspectorError,
} from '../../adapters/architecture-inspector.js';
import { validateWithSchema } from '../../services/schema-validator.js';
import { InvalidModelError, upsertDiscoveredModelRecord } from '../../services/models-repository.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_SCHEMA = path.resolve(moduleDir, '../../schemas/architecture-settings.schema.json');

const HF_MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]+$/;
const LOCAL_PATH_KEYS = ['model_path', 'modelPath', 'local_path', 'localPath', 'file_path', 'filePath', 'path'];

type DiscoveryModel = {
  model_id: string;
  display_name: string | null;
  context_window_tokens: number | null;
  quantisation:
    | {
        method: string;
        bits: number | null;
        group_size: number | null;
        scheme?: string | null;
        variant?: string | null;
        weight_format?: string | null;
      }
    | string
    | null;
};

function isInspectorError(v: ArchitectureTree | InspectorError): v is InspectorError {
  return 'code' in v && !('schema_version' in v);
}

function inspectionFailureMessage(err: InspectorError): string {
  if ('message' in err && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  return 'Inspection failed.';
}

function errorToHttp(err: InspectorError): { status: number; body: { error: string; code: string } } {
  switch (err.code) {
    case 'inspection_in_progress':
      return { status: 409, body: { error: 'Inspection already in progress for this model.', code: err.code } };
    case 'concurrency_limit':
      return { status: 503, body: { error: 'Too many concurrent inspections. Please retry later.', code: err.code } };
    case 'not_inspectable':
      return { status: 422, body: { error: 'This model is not inspectable.', code: err.code } };
    case 'hf_token_required':
      return {
        status: 401,
        body: {
          error: 'This model requires a Hugging Face API token. Add your token in Settings → Environment.',
          code: err.code,
        },
      };
    case 'unregistered_architecture':
      return {
        status: 400,
        body: {
          error: 'This model requires remote code execution. Enable it in Architecture Settings for this model.',
          code: err.code,
        },
      };
    case 'not_cached':
      return { status: 404, body: { error: 'No cached architecture found.', code: err.code } };
    default:
      return {
        status: 500,
        body: {
          error: inspectionFailureMessage(err),
          code: (err as { code: string }).code,
        },
      };
  }
}

function getArchitectureSettings(serverId: string, modelId: string): { trust_remote_code: boolean } {
  const db = getDb();
  const row = db
    .prepare('SELECT trust_remote_code FROM model_architecture_settings WHERE server_id = ? AND model_id = ?')
    .get(serverId, modelId) as { trust_remote_code: number } | undefined;
  return { trust_remote_code: row ? row.trust_remote_code === 1 : false };
}

function getOrCreateModelForInspection(serverId: string, modelId: string): ModelRecord | null {
  const existing = getModelById(serverId, modelId);
  if (existing) {
    return existing;
  }

  const server = getInferenceServerById(serverId);
  const discovered = server?.discovery.model_list.normalised.find((entry) => entry.model_id === modelId) as
    | DiscoveryModel
    | undefined;
  if (!server || !discovered) {
    return null;
  }

  try {
    return upsertDiscoveredModelRecord({
      server_id: serverId,
      model_id: modelId,
      display_name: discovered.display_name ?? modelId,
      context_window_tokens: discovered.context_window_tokens,
      quantisation: typeof discovered.quantisation === 'object' ? discovered.quantisation : null,
      raw: { discovery_model: discovered },
    });
  } catch (error) {
    if (error instanceof InvalidModelError) {
      return getModelById(serverId, modelId);
    }
    throw error;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findStringByKeys(source: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const found = stringValue(source[key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function localModelPath(model: ModelRecord): string | null {
  const raw = model.raw ?? {};
  const nestedModel = raw.model && typeof raw.model === 'object' ? (raw.model as Record<string, unknown>) : undefined;
  const candidates = [
    findStringByKeys(raw, LOCAL_PATH_KEYS),
    findStringByKeys(nestedModel, LOCAL_PATH_KEYS),
    stringValue(model.model.model_id)
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function hasMlxConfig(modelPath: string): boolean {
  try {
    const stat = fs.statSync(modelPath);
    if (stat.isDirectory()) {
      return fs.existsSync(path.join(modelPath, 'config.json'));
    }
    return path.basename(modelPath) === 'config.json';
  } catch {
    return false;
  }
}

function hasGgufFile(modelPath: string): boolean {
  try {
    const stat = fs.statSync(modelPath);
    return stat.isFile() && modelPath.toLowerCase().endsWith('.gguf');
  } catch {
    return false;
  }
}

function hasSafeTensorsFile(modelPath: string): boolean {
  try {
    const stat = fs.statSync(modelPath);
    if (stat.isFile()) {
      return modelPath.toLowerCase().endsWith('.safetensors');
    }
    if (stat.isDirectory()) {
      return fs.readdirSync(modelPath).some((entry) => entry.toLowerCase().endsWith('.safetensors'));
    }
    return false;
  } catch {
    return false;
  }
}

function hubModelId(modelId: string): string | null {
  const normalized = modelId.replace(/^\/+/, '');
  return HF_MODEL_ID_RE.test(normalized) ? normalized : null;
}

function inspectionTarget(
  model: ModelRecord
): {
  format: 'transformers' | 'gguf' | 'mlx' | 'gptq' | 'awq' | 'safetensors';
  modelPath?: string;
  sourceModelId?: string;
} | InspectorError {
  const format = model.architecture.format;
  const modelPath = localModelPath(model);
  const sourceModelId = hubModelId(model.model.model_id);

  if (format === 'GGUF') {
    if (modelPath && hasGgufFile(modelPath)) {
      return { format: 'gguf', modelPath };
    }
    return { code: 'not_inspectable' };
  }

  if (format === 'MLX') {
    if (modelPath && hasMlxConfig(modelPath)) {
      return { format: 'mlx', modelPath };
    }
    if (sourceModelId) {
      return { format: 'mlx', sourceModelId };
    }
    return { code: 'not_inspectable' };
  }

  if (format === 'SafeTensors') {
    if (modelPath && hasSafeTensorsFile(modelPath)) {
      return sourceModelId
        ? { format: 'safetensors', modelPath, sourceModelId }
        : { format: 'safetensors', modelPath };
    }
    if (sourceModelId) {
      return { format: 'safetensors', sourceModelId };
    }
    return { code: 'not_inspectable' };
  }

  if (format === 'GPTQ') {
    if (sourceModelId) {
      return { format: 'gptq', sourceModelId };
    }
    if (modelPath && hasMlxConfig(modelPath)) {
      return { format: 'gptq', modelPath };
    }
    return { code: 'not_inspectable' };
  }

  if (format === 'AWQ') {
    if (sourceModelId) {
      return { format: 'awq', sourceModelId };
    }
    if (modelPath && hasMlxConfig(modelPath)) {
      return { format: 'awq', modelPath };
    }
    return { code: 'not_inspectable' };
  }

  if (sourceModelId) {
    return { format: 'transformers', sourceModelId };
  }

  return { code: 'not_inspectable' };
}

export function registerArchitectureRoutes(app: FastifyInstance): void {
  const architectureSettingsRateLimit = createRateLimitPreHandler({
    keyPrefix: 'architecture-settings',
    maxRequests: 30,
    windowMs: 60_000
  });

  // POST — inspect or return cache
  app.post<{ Params: { serverId: string; modelId: string } }>(
    '/models/:serverId/:modelId/architecture',
    async (request, reply) => {
      const { serverId, modelId } = request.params;

      const model = getOrCreateModelForInspection(serverId, modelId);
      if (!model) {
        return reply.code(404).send({ error: 'Model not found.', code: 'model_not_found' });
      }

      const target = inspectionTarget(model);
      if ('code' in target) {
        const { status, body } = errorToHttp(target);
        return reply.code(status).send(body);
      }

      let sanitized: string;
      try {
        sanitized = sanitizeModelId(modelId);
      } catch {
        return reply.code(422).send({ error: 'This model is not inspectable.', code: 'not_inspectable' });
      }

      // Check cache first
      const cached = readCachedTree(sanitized);
      if (!isInspectorError(cached)) {
        return reply.send(cached);
      }

      // Cold inspection
      const settings = getArchitectureSettings(serverId, modelId);
      const result = await runInspection({
        modelId,
        sanitizedId: sanitized,
        sourceModelId: target.sourceModelId,
        format: target.format,
        modelPath: target.modelPath,
        trustRemoteCode: settings.trust_remote_code,
      });

      if (isInspectorError(result)) {
        const { status, body } = errorToHttp(result);
        return reply.code(status).send(body);
      }

      return reply.send(result);
    }
  );

  // GET — cache only
  app.get<{ Params: { serverId: string; modelId: string } }>(
    '/models/:serverId/:modelId/architecture',
    async (request, reply) => {
      const { serverId, modelId } = request.params;

      const model = getModelById(serverId, modelId);
      if (!model) {
        return reply.code(404).send({ error: 'Model not found.', code: 'model_not_found' });
      }

      let sanitized: string;
      try {
        sanitized = sanitizeModelId(modelId);
      } catch {
        return reply.code(422).send({ error: 'This model is not inspectable.', code: 'not_inspectable' });
      }

      const cached = readCachedTree(sanitized);
      if (isInspectorError(cached)) {
        const { status, body } = errorToHttp(cached);
        return reply.code(status).send(body);
      }

      return reply.send(cached);
    }
  );

  // DELETE — clear cache
  app.delete<{ Params: { serverId: string; modelId: string } }>(
    '/models/:serverId/:modelId/architecture',
    async (request, reply) => {
      const { serverId, modelId } = request.params;

      const model = getModelById(serverId, modelId);
      if (!model) {
        return reply.code(404).send({ error: 'Model not found.', code: 'model_not_found' });
      }

      let sanitized: string;
      try {
        sanitized = sanitizeModelId(modelId);
      } catch {
        return reply.code(204).send();
      }

      deleteCacheFiles(sanitized);
      return reply.code(204).send();
    }
  );

  // GET settings
  app.get<{ Params: { serverId: string; modelId: string } }>(
    '/models/:serverId/:modelId/architecture/settings',
    { preHandler: architectureSettingsRateLimit },
    async (request, reply) => {
      const { serverId, modelId } = request.params;
      return reply.send(getArchitectureSettings(serverId, modelId));
    }
  );

  // PATCH settings
  app.patch<{ Params: { serverId: string; modelId: string }; Body: { trust_remote_code: boolean } }>(
    '/models/:serverId/:modelId/architecture/settings',
    { preHandler: architectureSettingsRateLimit },
    async (request, reply) => {
      const { serverId, modelId } = request.params;

      const validation = validateWithSchema(SETTINGS_SCHEMA, request.body);
      if (!validation.ok) {
        return reply.code(400).send({ error: 'Invalid request body.', code: 'invalid_body' });
      }

      const { trust_remote_code } = request.body;
      const now = new Date().toISOString();
      const db = getDb();
      db.prepare(
        `INSERT INTO model_architecture_settings (server_id, model_id, trust_remote_code, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (server_id, model_id)
         DO UPDATE SET trust_remote_code = excluded.trust_remote_code, updated_at = excluded.updated_at`
      ).run(serverId, modelId, trust_remote_code ? 1 : 0, now);

      return reply.send(getArchitectureSettings(serverId, modelId));
    }
  );
}
