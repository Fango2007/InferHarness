import { apiGet, apiPatch, apiPost } from './api.js';

export interface EnvEntry {
  key: string;
  value: string;
}

export interface TemplateAgentModelSetting {
  server_id: string;
  model_id: string;
}

export interface AppSettings {
  template_agent_model: TemplateAgentModelSetting | null;
}

export async function listEnvEntries(): Promise<EnvEntry[]> {
  const response = await apiGet<{ entries: EnvEntry[] }>('/system/env');
  return response.entries;
}

export async function setEnvEntry(key: string, value: string | null): Promise<EnvEntry[]> {
  const response = await apiPost<{ entries: EnvEntry[] }>('/system/env', { key, value });
  return response.entries;
}

export async function clearDatabase(): Promise<void> {
  await apiPost('/system/clear-db', {});
}

export async function getAppSettings(): Promise<AppSettings> {
  return apiGet<AppSettings>('/system/settings');
}

export async function setTemplateAgentModel(input: TemplateAgentModelSetting): Promise<AppSettings> {
  return apiPatch<AppSettings>('/system/settings/template-agent-model', input);
}
