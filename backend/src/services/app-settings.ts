import { getDb } from '../models/db.js';
import { getModelById } from '../models/model.js';
import { nowIso, parseJson } from '../models/repositories.js';

const TEMPLATE_AGENT_MODEL_KEY = 'template_agent_model';

export interface TemplateAgentModelSetting {
  server_id: string;
  model_id: string;
}

export interface AppSettings {
  template_agent_model: TemplateAgentModelSetting | null;
}

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

function readSetting<T>(key: string): T | null {
  const row = getDb()
    .prepare('SELECT * FROM app_settings WHERE key = ?')
    .get(key) as AppSettingRow | undefined;
  return row ? parseJson<T>(row.value) : null;
}

function writeSetting(key: string, value: unknown): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), now);
}

function normalizeTemplateAgentModel(input: unknown): TemplateAgentModelSetting | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const serverId = typeof record.server_id === 'string' ? record.server_id.trim() : '';
  const modelId = typeof record.model_id === 'string' ? record.model_id.trim() : '';
  return serverId && modelId ? { server_id: serverId, model_id: modelId } : null;
}

export function getAppSettings(): AppSettings {
  return {
    template_agent_model: normalizeTemplateAgentModel(readSetting(TEMPLATE_AGENT_MODEL_KEY))
  };
}

export function setTemplateAgentModel(input: TemplateAgentModelSetting): AppSettings {
  const serverId = input.server_id.trim();
  const modelId = input.model_id.trim();
  if (!serverId || !modelId) {
    throw Object.assign(new Error('Template agent model requires server_id and model_id.'), { statusCode: 400 });
  }
  const model = getModelById(serverId, modelId);
  if (!model || model.model.archived || !model.model.active) {
    throw Object.assign(new Error('Template agent model must reference an active, non-archived model.'), { statusCode: 400 });
  }
  writeSetting(TEMPLATE_AGENT_MODEL_KEY, { server_id: serverId, model_id: modelId });
  return getAppSettings();
}
