import { useState } from 'react';

import {
  ApiSchemaFamily,
  AuthType,
  InferenceServerInput,
  InferenceServerRecord
} from '../services/inference-servers-api.js';

interface InferenceServerEditFormProps {
  server: InferenceServerRecord;
  onSave: (updates: InferenceServerInput) => Promise<void>;
  onCancel: () => void;
}

export function InferenceServerEditForm({ server, onSave, onCancel }: InferenceServerEditFormProps) {
  const [displayName, setDisplayName] = useState(server.inference_server.display_name);
  const [baseUrl, setBaseUrl] = useState(server.endpoints.base_url);
  const [softwareVersion, setSoftwareVersion] = useState(server.runtime.server_software.version ?? '');
  const [schemaFamilies, setSchemaFamilies] = useState<ApiSchemaFamily[]>(
    Array.isArray(server.runtime.api.schema_family)
      ? server.runtime.api.schema_family
      : [server.runtime.api.schema_family]
  );
  const [authType, setAuthType] = useState<AuthType>(server.auth.type);
  const [authTokenEnv, setAuthTokenEnv] = useState(server.auth.token_env ?? '');
  const [authHeaderName, setAuthHeaderName] = useState(server.auth.header_name);
  const [active, setActive] = useState(server.inference_server.active);
  const [saving, setSaving] = useState(false);
  const schemaFamilyOptions: Array<{ value: ApiSchemaFamily; label: string }> = [
    { value: 'openai-compatible', label: 'OpenAI-compatible' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'custom', label: 'Custom' }
  ];

  function toggleSchemaFamily(value: ApiSchemaFamily) {
    setSchemaFamilies((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (schemaFamilies.length === 0) {
      return;
    }
    setSaving(true);
    try {
      await onSave({
        inference_server: {
          display_name: displayName,
          active
        },
        endpoints: {
          base_url: baseUrl
        },
        runtime: {
          server_software: {
            name: server.runtime.server_software.name,
            version: softwareVersion.trim() || null,
            build: server.runtime.server_software.build
          },
          api: {
            schema_family: schemaFamilies,
            api_version: server.runtime.api.api_version
          }
        },
        auth: {
          type: authType,
          header_name: authHeaderName || 'Authorization',
          token_env: authTokenEnv || null
        }
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h3>Edit inference server</h3>
      <label>
        Display name
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label>
        Base URL
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
        />
      </label>
      <label>
        Software version
        <input
          value={softwareVersion}
          onChange={(event) => setSoftwareVersion(event.target.value)}
          placeholder="e.g. 0.8.5"
        />
      </label>
      <div>
        <p className="muted">Schema families</p>
        {schemaFamilyOptions.map((option) => (
          <label key={option.value} className="checkbox-row">
            <input
              type="checkbox"
              checked={schemaFamilies.includes(option.value)}
              onChange={() => toggleSchemaFamily(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <label>
        Auth type
        <select
          value={authType}
          onChange={(event) => setAuthType(event.target.value as AuthType)}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer</option>
          <option value="basic">Basic</option>
          <option value="oauth">OAuth</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>
        Auth header name
        <input
          value={authHeaderName}
          onChange={(event) => setAuthHeaderName(event.target.value)}
        />
      </label>
      <label>
        Auth token env var
        <input value={authTokenEnv} onChange={(event) => setAuthTokenEnv(event.target.value)} />
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
        Active
      </label>
      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
