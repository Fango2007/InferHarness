import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/api/server.js';
import { getDb } from '../../src/models/db.js';
import { isDiscoveryCacheValid } from '../../src/services/inference-servers-repository.js';

const AUTH_HEADERS = { 'x-api-token': 'test-token' };

function resetDb() {
  const db = getDb();
  try {
    db.prepare('DELETE FROM runs').run();
  } catch {
    // Table may not exist before schema bootstrap in first test.
  }
  try {
    db.prepare('DELETE FROM models').run();
  } catch {
    // Table may not exist before schema bootstrap in first test.
  }
  try {
    db.prepare('DELETE FROM inference_servers').run();
  } catch {
    // Table may not exist before schema bootstrap in first test.
  }
}

function buildCreatePayload(overrides?: Record<string, unknown>) {
  return {
    inference_server: { display_name: 'Local Inference', active: true, archived: false },
    endpoints: { base_url: 'http://localhost:11434' },
    runtime: { api: { schema_family: ['openai-compatible'], api_version: null } },
    ...(overrides ?? {})
  };
}

describe('inference servers contract', () => {
  process.env.INFERHARNESS_API_TOKEN = 'test-token';
  process.env.INFERHARNESS_DB_PATH = ':memory:';

  createServer();

  afterEach(() => {
    resetDb();
    vi.restoreAllMocks();
  });

  it('creates and lists inference servers', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload()
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.inference_server.server_id).toBeTruthy();
    expect(created.inference_server.created_at).toBeTruthy();
    expect(created.inference_server.updated_at).toBeTruthy();

    const listResponse = await app.inject({
      method: 'GET',
      url: '/inference-servers',
      headers: AUTH_HEADERS
    });
    expect(listResponse.statusCode).toBe(200);
    const servers = listResponse.json();
    expect(servers).toHaveLength(1);
  });

  it('stores raw auth tokens without returning them in API payloads', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        auth: {
          type: 'bearer',
          header_name: 'Authorization',
          token: 'secret-token-value',
          token_env: null
        }
      })
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.auth.token).toBeNull();
    expect(created.auth.token_present).toBe(true);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/inference-servers',
      headers: AUTH_HEADERS
    });
    expect(listResponse.statusCode).toBe(200);
    const [listed] = listResponse.json();
    expect(listed.auth.token).toBeNull();
    expect(listed.auth.token_present).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('secret-token-value');
  });

  it('uses stored bearer auth when probing an existing server with a masked token', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        auth: {
          type: 'bearer',
          header_name: 'Authorization',
          token: 'secret-token-value',
          token_env: null
        }
      })
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: [{ id: 'mistral-test' }] })
        }) as any
    );
    vi.stubGlobal('fetch', fetchMock);

    const probeResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers/probe',
      headers: AUTH_HEADERS,
      payload: {
        server_id: created.inference_server.server_id,
        base_url: 'https://api.mistral.ai',
        schema_family: ['openai-compatible'],
        auth: {
          type: 'bearer',
          header_name: 'Authorization',
          token: null,
          token_env: null
        }
      }
    });

    expect(probeResponse.statusCode).toBe(200);
    expect(probeResponse.json().ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mistral.ai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-token-value' }
      })
    );
  });

  it('falls back to stored bearer auth for a probe payload that only matches a saved base URL', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        endpoints: { base_url: 'https://api.mistral.ai/' },
        auth: {
          type: 'bearer',
          header_name: 'Authorization',
          token: 'secret-token-value',
          token_env: null
        }
      })
    });
    expect(createResponse.statusCode).toBe(201);
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: [{ id: 'mistral-test' }] })
        }) as any
    );
    vi.stubGlobal('fetch', fetchMock);

    const probeResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers/probe',
      headers: AUTH_HEADERS,
      payload: {
        base_url: 'https://api.mistral.ai',
        schema_family: ['openai-compatible'],
        auth: {
          type: 'bearer',
          header_name: 'Authorization',
          token: null,
          token_env: null
        }
      }
    });

    expect(probeResponse.statusCode).toBe(200);
    expect(probeResponse.json().ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mistral.ai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-token-value' }
      })
    );
  });

  it('validates enums and rejects invalid values', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        runtime: { api: { schema_family: ['invalid'], api_version: null } }
      })
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects active and archived both true', async () => {
    const app = createServer();
    const response = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        inference_server: { display_name: 'Bad', active: true, archived: true }
      })
    });
    expect(response.statusCode).toBe(400);
  });

  it('updates updated_at on changes', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload()
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const created = createResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updatedResponse = await app.inject({
      method: 'PATCH',
      url: `/inference-servers/${created.inference_server.server_id}`,
      headers: AUTH_HEADERS,
      payload: { inference_server: { display_name: 'Updated Name' } }
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = updatedResponse.json();
    expect(updated.inference_server.updated_at).not.toBe(created.inference_server.updated_at);
  });

  it('evaluates discovery TTL', () => {
    const now = new Date('2025-01-01T00:00:00.000Z').getTime();
    const valid = isDiscoveryCacheValid(
      {
        retrieved_at: '2025-01-01T00:00:00.000Z',
        ttl_seconds: 300,
        model_list: { raw: {}, normalised: [] }
      },
      now + 200 * 1000
    );
    const expired = isDiscoveryCacheValid(
      {
        retrieved_at: '2025-01-01T00:00:00.000Z',
        ttl_seconds: 300,
        model_list: { raw: {}, normalised: [] }
      },
      now + 400 * 1000
    );
    expect(valid).toBe(true);
    expect(expired).toBe(false);
  });

  it('refreshes discovery and stores raw + normalised payload', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload()
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const created = createResponse.json();
    const payload = { data: [{ id: 'gpt-test' }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => payload
          }) as any
      )
    );

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/inference-servers/${created.inference_server.server_id}/refresh-discovery`,
      headers: AUTH_HEADERS
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshed = refreshResponse.json();
    expect(refreshed.discovery.model_list.raw).toEqual(payload);
    expect(refreshed.discovery.model_list.normalised[0].model_id).toBe('gpt-test');

    const modelsResponse = await app.inject({
      method: 'GET',
      url: '/models',
      headers: AUTH_HEADERS
    });
    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json().map((model: { model: { model_id: string } }) => model.model.model_id)).toEqual([
      'gpt-test'
    ]);
  });

  it('refresh-discovery persists parsed model metadata and preserves manual edits', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload()
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const created = createResponse.json();
    const modelId = 'codestral-2508';
    const payload = {
      data: [
        {
          id: 'codestral-latest',
          object: 'model',
          owned_by: 'mistralai',
          name: modelId,
          description: 'Our cutting-edge language model for coding released August 2025.',
          max_context_length: 256000,
          aliases: [modelId, 'mistral-code-latest'],
          deprecation: null,
          deprecation_replacement_model: null,
          default_model_temperature: 0.3,
          type: 'base',
          capabilities: {
            completion_chat: true,
            function_calling: true,
            reasoning: false,
            completion_fim: true,
            fine_tuning: false,
            vision: false,
            audio: false,
            audio_transcription: false,
            audio_transcription_realtime: false,
            audio_speech: false
          }
        },
        {
          id: modelId,
          object: 'model',
          owned_by: 'mistralai',
          name: modelId,
          description: 'Our cutting-edge language model for coding released August 2025.',
          max_context_length: 256000,
          aliases: ['codestral-latest', 'mistral-code-latest'],
          deprecation: null,
          deprecation_replacement_model: null,
          default_model_temperature: 0.3,
          type: 'base',
          capabilities: {
            completion_chat: true,
            function_calling: true,
            reasoning: false,
            completion_fim: true,
            fine_tuning: false,
            vision: false,
            audio: false,
            audio_transcription: false,
            audio_transcription_realtime: false,
            audio_speech: false
          }
        },
        {
          id: 'mistral-embed',
          object: 'model',
          owned_by: 'mistralai',
          name: 'mistral-embed-2312',
          max_context_length: 8192,
          aliases: ['mistral-embed-2312'],
          default_model_temperature: null,
          capabilities: {
            completion_chat: false,
            function_calling: false,
            reasoning: false,
            completion_fim: false,
            vision: false,
            audio: false
          }
        },
        {
          id: 'mistral-embed-2312',
          object: 'model',
          owned_by: 'mistralai',
          name: 'mistral-embed-2312',
          max_context_length: 8192,
          aliases: ['mistral-embed'],
          default_model_temperature: null,
          capabilities: {
            completion_chat: false,
            function_calling: false,
            reasoning: false,
            completion_fim: false,
            vision: false,
            audio: false
          }
        }
      ]
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => payload
          }) as any
      )
    );

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/inference-servers/${created.inference_server.server_id}/refresh-discovery`,
      headers: AUTH_HEADERS
    });
    expect(refreshResponse.statusCode).toBe(200);

    const modelsResponse = await app.inject({
      method: 'GET',
      url: '/models',
      headers: AUTH_HEADERS
    });
    const models = modelsResponse.json();
    const model = models.find((entry: { model: { model_id: string } }) => entry.model.model_id === modelId);
    const alias = models.find((entry: { model: { model_id: string } }) => entry.model.model_id === 'codestral-latest');
    const embedAlias = models.find((entry: { model: { model_id: string } }) => entry.model.model_id === 'mistral-embed');
    const embed = models.find((entry: { model: { model_id: string } }) => entry.model.model_id === 'mistral-embed-2312');
    expect(alias).toBeUndefined();
    expect(embedAlias).toBeUndefined();
    expect(model.model.base_model_name).toBe('codestral-2508');
    expect(model.identity.provider).toBe('mistral');
    expect(model.limits.context_window_tokens).toBe(256000);
    expect(model.configuration.default_parameters.temperature).toBe(0.3);
    expect(model.capabilities.generation.text).toBe(true);
    expect(model.capabilities.generation.tools).toBe(true);
    expect(model.capabilities.reasoning.supported).toBe(false);
    expect(model.capabilities.use_case.coding).toBe(true);
    expect(model.raw.discovery_model.aliases).toEqual(['codestral-latest', 'mistral-code-latest']);
    expect(model.raw.discovery_model.description).toContain('coding');
    expect(embed.identity.provider).toBe('mistral');
    expect(embed.capabilities.generation.embeddings).toBe(true);
    expect(embed.modalities.output).toContain('embedding');

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/models/${created.inference_server.server_id}/${encodeURIComponent(modelId)}`,
      headers: AUTH_HEADERS,
      payload: {
        model: { base_model_name: 'Manual Name' },
        identity: { provider: 'custom', quantized_provider: 'manual-provider' },
        architecture: { format: 'GGUF', parameter_count_label: 'Manual Params' }
      }
    });
    expect(patchResponse.statusCode).toBe(200);

    const refreshAgain = await app.inject({
      method: 'POST',
      url: `/inference-servers/${created.inference_server.server_id}/refresh-discovery`,
      headers: AUTH_HEADERS
    });
    expect(refreshAgain.statusCode).toBe(200);
    const preservedResponse = await app.inject({
      method: 'GET',
      url: `/models/${created.inference_server.server_id}/${encodeURIComponent(modelId)}`,
      headers: AUTH_HEADERS
    });
    const preserved = preservedResponse.json();
    expect(preserved.model.base_model_name).toBe('Manual Name');
    expect(preserved.identity.provider).toBe('custom');
    expect(preserved.identity.quantized_provider).toBe('manual-provider');
    expect(preserved.architecture.format).toBe('GGUF');
    expect(preserved.architecture.parameter_count_label).toBe('Manual Params');
  });

  it('filters malformed remote-prefixed OpenAI discovery model IDs', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload()
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const created = createResponse.json();
    const payload = {
      object: 'list',
      data: [
        { id: '/inferencerlabs/Devstral-Small-2-24B-Instruct-2512-MLX-6.5bit', object: 'model' },
        { id: '<remote>/inferencerlabs/Devstral-Small-2-24B-Instruct-2512-MLX-6.5bit', object: 'model' }
      ]
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => payload
          }) as any
      )
    );

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/inference-servers/${created.inference_server.server_id}/refresh-discovery`,
      headers: AUTH_HEADERS
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshed = refreshResponse.json();
    expect(refreshed.discovery.model_list.raw).toEqual(payload);
    expect(refreshed.discovery.model_list.normalised.map((model: { model_id: string }) => model.model_id)).toEqual([
      '/inferencerlabs/Devstral-Small-2-24B-Instruct-2512-MLX-6.5bit'
    ]);
  });

  it('does not wipe discovery on refresh failure', async () => {
    const app = createServer();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/inference-servers',
      headers: AUTH_HEADERS,
      payload: buildCreatePayload({
        discovery: {
          retrieved_at: new Date().toISOString(),
          ttl_seconds: 300,
          model_list: { raw: { cached: true }, normalised: [{ model_id: 'cached', display_name: null, context_window_tokens: null, quantisation: null }] }
        }
      })
    });
    if (createResponse.statusCode !== 201) {
      throw new Error(`create inference server failed: ${createResponse.statusCode} ${createResponse.body}`);
    }
    const created = createResponse.json();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })) as any);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/inference-servers/${created.inference_server.server_id}/refresh-discovery`,
      headers: AUTH_HEADERS
    });
    expect(refreshResponse.statusCode).toBe(502);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/inference-servers/${created.inference_server.server_id}`,
      headers: AUTH_HEADERS
    });
    const fetched = getResponse.json();
    expect(fetched.discovery.model_list.raw).toEqual({ cached: true });
  });
});
