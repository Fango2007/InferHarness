import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBackendFetch = vi.fn();

vi.mock('../../src/services/inference-proxy.js', () => ({
  backendFetch: mockBackendFetch
}));

const { probeServer } = await import('../../src/services/inference-server-probe.js');

describe('inference server probe security controls', () => {
  beforeEach(() => {
    mockBackendFetch.mockReset();
  });

  it('rejects oversized JSON model-list responses before parsing', async () => {
    mockBackendFetch.mockResolvedValueOnce(new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '1000001'
      }
    }));

    const result = await probeServer({
      base_url: 'http://127.0.0.1:11434',
      schema_families: ['openai-compatible'],
      auth_headers: {}
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON response exceeded');
  });
});
