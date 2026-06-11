import { FastifyInstance, FastifyReply } from 'fastify';

import {
  BenchmarkNotFoundError,
  BenchmarkValidationError,
  getBenchmarkInstantiation,
  getBenchmarkResult,
  persistBenchmarkInstantiation,
  persistBenchmarkResult,
  validateAnyBenchmarkDocument
} from '../../services/benchmark-foundation.js';
import { prepareBenchmarkDatasetManifest } from '../../services/benchmark-datasets.js';
import { BenchmarkKind } from '../../services/benchmark-schemas.js';
import { runBenchmarkInstantiation } from '../../services/benchmark-runner.js';
import { runBenchmarkPlan } from '../../services/benchmark-plan-runner.js';

function sendBenchmarkError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof BenchmarkValidationError) {
    reply.code(400).send({ error: error.message, issues: error.issues });
    return true;
  }
  if (error instanceof BenchmarkNotFoundError) {
    reply.code(404).send({ error: error.message });
    return true;
  }
  return false;
}

export function registerBenchmarkRoutes(app: FastifyInstance): void {
  app.post('/benchmark/validate', async (request, reply) => {
    const payload = request.body as { kind?: BenchmarkKind; document?: unknown };
    try {
      const result = validateAnyBenchmarkDocument(payload.document ?? request.body, payload.kind);
      reply.send(result);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.post('/benchmark/instantiations', async (request, reply) => {
    try {
      const record = persistBenchmarkInstantiation(request.body as Parameters<typeof persistBenchmarkInstantiation>[0]);
      reply.code(201).send(record);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.post('/benchmark/datasets/manifest', async (request, reply) => {
    try {
      const manifest = prepareBenchmarkDatasetManifest(request.body as Parameters<typeof prepareBenchmarkDatasetManifest>[0]);
      reply.send({ manifest });
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.post('/benchmark/instantiations/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const record = await runBenchmarkInstantiation(id);
      reply.code(201).send(record);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/instantiations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = getBenchmarkInstantiation(id);
    if (!record) {
      reply.code(404).send({ error: `Benchmark instantiation not found: ${id}` });
      return;
    }
    reply.send(record);
  });

  app.post('/benchmark/results', async (request, reply) => {
    try {
      const record = persistBenchmarkResult(request.body as Record<string, unknown>);
      reply.code(201).send(record);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/results/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = getBenchmarkResult(id);
    if (!record) {
      reply.code(404).send({ error: `Benchmark result not found: ${id}` });
      return;
    }
    reply.send(record);
  });

  app.post('/benchmark/plans/run', async (request, reply) => {
    const body = request.body as {
      plan_id?: string;
      template?: unknown;
      dataset?: unknown;
      runtime_profile?: unknown;
      targets?: unknown;
      continue_on_model_error?: unknown;
    };
    if (!body.template || typeof body.template !== 'object' || Array.isArray(body.template)) {
      reply.code(400).send({ error: 'benchmark plan requires template' });
      return;
    }
    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      reply.code(400).send({ error: 'benchmark plan requires at least one target' });
      return;
    }
    try {
      const result = await runBenchmarkPlan({
        plan_id: typeof body.plan_id === 'string' ? body.plan_id : undefined,
        template: body.template as Record<string, unknown>,
        dataset: (body.dataset ?? {}) as Record<string, unknown>,
        runtime_profile: (body.runtime_profile ?? {}) as Record<string, unknown>,
        targets: body.targets as { server_id: string; model_id: string }[],
        continue_on_model_error: body.continue_on_model_error !== false
      });
      reply.code(201).send(result);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });
}
