import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const undiciMock = vi.hoisted(() => ({
  Agent: vi.fn(function (this: { options?: unknown }, options?: unknown) {
    this.options = options;
  }),
  EnvHttpProxyAgent: vi.fn(function (this: { options?: unknown }, options?: unknown) {
    this.options = options;
  }),
  fetch: vi.fn(),
  setGlobalDispatcher: vi.fn()
}));

vi.mock('undici', () => undiciMock);

import {
  backendFetch,
  configureInferenceProxyFromEnv,
  resolveInferenceProxyConfig,
  shouldDisableInferenceTlsVerification
} from '../../src/services/inference-proxy.js';

describe('inference proxy configuration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    undiciMock.Agent.mockClear();
    undiciMock.EnvHttpProxyAgent.mockClear();
    undiciMock.fetch.mockClear();
    undiciMock.setGlobalDispatcher.mockClear();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not configure a dispatcher when the backend-specific proxy env var is absent', () => {
    expect(resolveInferenceProxyConfig({ HTTP_PROXY: 'http://proxy.example:8080' })).toBeNull();

    const configured = configureInferenceProxyFromEnv({ HTTP_PROXY: 'http://proxy.example:8080' });

    expect(configured).toBe(false);
    expect(undiciMock.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciMock.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it('trims and resolves backend-specific proxy settings', () => {
    expect(
      resolveInferenceProxyConfig({
        INFERHARNESS_INFERENCE_PROXY: ' http://proxy.example:8080 ',
        INFERHARNESS_INFERENCE_NO_PROXY: ' localhost,127.0.0.1 '
      })
    ).toEqual({
      proxy: 'http://proxy.example:8080',
      noProxy: 'localhost,127.0.0.1'
    });
  });

  it('parses the backend-specific insecure TLS opt-in', () => {
    expect(shouldDisableInferenceTlsVerification({})).toBe(false);
    expect(shouldDisableInferenceTlsVerification({ INFERHARNESS_INFERENCE_TLS_INSECURE: 'false' })).toBe(false);
    expect(shouldDisableInferenceTlsVerification({ INFERHARNESS_INFERENCE_TLS_INSECURE: '1' })).toBe(true);
    expect(shouldDisableInferenceTlsVerification({ INFERHARNESS_INFERENCE_TLS_INSECURE: ' true ' })).toBe(true);
  });

  it('configures a global Undici dispatcher for backend fetch calls', () => {
    const configured = configureInferenceProxyFromEnv({
      INFERHARNESS_INFERENCE_PROXY: 'http://proxy.example:8080',
      INFERHARNESS_INFERENCE_NO_PROXY: 'localhost,127.0.0.1'
    });

    expect(configured).toBe(true);
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: 'localhost,127.0.0.1',
      proxyTunnel: false
    });
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledWith(
      undiciMock.EnvHttpProxyAgent.mock.instances[0]
    );
    expect(globalThis.fetch).toBe(backendFetch);
  });

  it('can disable TLS verification for proxied inference requests', () => {
    const configured = configureInferenceProxyFromEnv({
      INFERHARNESS_INFERENCE_PROXY: 'http://proxy.example:8080',
      INFERHARNESS_INFERENCE_TLS_INSECURE: 'true'
    });

    expect(configured).toBe(true);
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: '',
      proxyTunnel: false,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false }
    });
  });

  it('can disable TLS verification for direct inference requests', () => {
    const configured = configureInferenceProxyFromEnv({
      INFERHARNESS_INFERENCE_TLS_INSECURE: 'true'
    });

    expect(configured).toBe(true);
    expect(undiciMock.Agent).toHaveBeenCalledWith({
      connect: { rejectUnauthorized: false }
    });
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledWith(
      undiciMock.Agent.mock.instances[0]
    );
    expect(globalThis.fetch).toBe(backendFetch);
  });

  it('does not inherit process-level NO_PROXY when the backend-specific no-proxy env var is absent', () => {
    const configured = configureInferenceProxyFromEnv({
      INFERHARNESS_INFERENCE_PROXY: 'http://proxy.example:8080',
      NO_PROXY: '.local,localhost,127.0.0.1'
    });

    expect(configured).toBe(true);
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
      noProxy: '',
      proxyTunnel: false
    });
  });

  it('backendFetch passes the configured dispatcher directly to Undici fetch', async () => {
    const fetchResponse = new Response('ok');
    undiciMock.fetch.mockResolvedValue(fetchResponse);

    configureInferenceProxyFromEnv({
      INFERHARNESS_INFERENCE_PROXY: 'http://proxy.example:8080'
    });

    const response = await backendFetch('http://ai-mac-studio.local:8081/v1/models', {
      method: 'GET'
    });

    expect(response).toBe(fetchResponse);
    expect(undiciMock.fetch).toHaveBeenCalledWith(
      'http://ai-mac-studio.local:8081/v1/models',
      {
        method: 'GET',
        dispatcher: undiciMock.EnvHttpProxyAgent.mock.instances[0]
      }
    );
  });
});
