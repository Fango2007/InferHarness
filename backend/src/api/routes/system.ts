import { FastifyInstance } from 'fastify';

import { createRateLimitPreHandler } from '../middleware/rate-limit.js';
import { getAppSettings, setTemplateAgentModel } from '../../services/app-settings.js';
import { getSystemMetrics } from '../../services/system-metrics.js';
import { clearDatabase, listEnvEntries, setEnvEntry } from '../../services/system-settings.js';

export function registerSystemRoutes(app: FastifyInstance): void {
  const systemSettingsRateLimit = createRateLimitPreHandler({
    keyPrefix: 'system-settings',
    maxRequests: 60,
    windowMs: 60_000
  });

  const systemActionRateLimit = createRateLimitPreHandler({
    keyPrefix: 'system-actions',
    maxRequests: 30,
    windowMs: 60_000
  });

  // Runtime limiting is enforced by systemActionRateLimit; CodeQL does not model local Fastify preHandlers.
  // codeql[js/missing-rate-limiting]
  app.get('/system/metrics', { preHandler: systemActionRateLimit }, async () => getSystemMetrics());

  app.get('/system/settings', {
    preHandler: systemSettingsRateLimit,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: 60_000
      }
    }
  }, async () => getAppSettings());

  app.patch('/system/settings/template-agent-model', { preHandler: systemSettingsRateLimit }, async (request, reply) => {
    const body = request.body as { server_id?: string; model_id?: string };
    try {
      reply.send(setTemplateAgentModel({
        server_id: body.server_id ?? '',
        model_id: body.model_id ?? ''
      }));
    } catch (error) {
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 400;
      reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Unable to update app settings' });
    }
  });

  app.get('/system/connectivity-config', { preHandler: systemActionRateLimit }, async () => {
    const pollIntervalMs = Number(process.env.INFERHARNESS_HEALTH_POLL_INTERVAL || 30) * 1000;
    const discoveryTtlMs = Number(process.env.INFERHARNESS_CONTEXT_PROBE_TIMEOUT_MS || 300000);
    return { poll_interval_ms: pollIntervalMs, discovery_ttl_ms: discoveryTtlMs };
  });

  app.post('/system/clear-db', { preHandler: systemActionRateLimit }, async (_request, reply) => {
    clearDatabase();
    reply.send({ status: 'ok' });
  });

  // Runtime limiting is enforced by systemActionRateLimit; CodeQL does not model local Fastify preHandlers.
  // codeql[js/missing-rate-limiting]
  app.get('/system/env', { preHandler: systemActionRateLimit }, async () => ({ entries: listEnvEntries() }));

  app.post('/system/env', { preHandler: systemActionRateLimit }, async (request, reply) => {
    const body = request.body as { key?: string; value?: string | null };
    const key = body?.key?.trim();
    if (!key) {
      reply.code(400).send({ error: 'key is required' });
      return;
    }
    try {
      const value = body.value === undefined ? '' : body.value;
      const entries = setEnvEntry(key, value);
      reply.send({ entries });
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'Unable to update env' });
    }
  });
}
