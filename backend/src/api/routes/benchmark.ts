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
import { runBenchmarkTemplateAgent } from '../../services/benchmark-template-agent.js';
import {
  BenchmarkDocumentKind,
  getBenchmarkDocument,
  listBenchmarkDocuments
} from '../../services/benchmark-document-store.js';
import { resolveBenchmarkPlan } from '../../services/benchmark-plan-registry.js';
import {
  benchmarkLibraryStatus,
  deleteBenchmarkDocumentWithLibrary,
  installBenchmarkLibraryDocuments,
  putBenchmarkDocumentWithLibrary
} from '../../services/benchmark-library.js';

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

function parseDocumentKind(kind: string): BenchmarkDocumentKind {
  if (
    kind === 'test_template'
    || kind === 'runtime_profile'
    || kind === 'dataset_manifest'
    || kind === 'benchmark_plan'
  ) {
    return kind;
  }
  throw new BenchmarkValidationError(`Unsupported benchmark document kind: ${kind}`);
}

export function registerBenchmarkRoutes(app: FastifyInstance): void {
  app.post('/benchmark/documents', async (request, reply) => {
    try {
      const record = putBenchmarkDocumentWithLibrary(request.body as Record<string, unknown>);
      reply.code(201).send(record);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/documents/:kind', async (request, reply) => {
    const { kind } = request.params as { kind: string };
    try {
      reply.send(listBenchmarkDocuments(parseDocumentKind(kind)));
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/documents/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    try {
      reply.send(getBenchmarkDocument(parseDocumentKind(kind), id));
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.delete('/benchmark/documents/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    try {
      const removed = deleteBenchmarkDocumentWithLibrary(parseDocumentKind(kind), id);
      reply.code(removed ? 204 : 404).send();
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/library', async (_request, reply) => {
    try {
      reply.send(benchmarkLibraryStatus());
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.post('/benchmark/library/reload', async (_request, reply) => {
    try {
      reply.send(installBenchmarkLibraryDocuments());
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

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

  app.post('/benchmark/template-agent', async (request, reply) => {
    try {
      reply.send(await runBenchmarkTemplateAgent(request.body as Parameters<typeof runBenchmarkTemplateAgent>[0]));
    } catch (error) {
      if (sendBenchmarkError(reply, error)) {
        return;
      }
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
      reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Template agent failed' });
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

  app.post('/benchmark/plans', async (request, reply) => {
    try {
      const document = request.body as Record<string, unknown>;
      if (document.kind !== 'benchmark_plan') {
        throw new BenchmarkValidationError('Expected benchmark_plan document.');
      }
      const record = putBenchmarkDocumentWithLibrary(document);
      reply.code(201).send(record);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.get('/benchmark/plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      reply.send(getBenchmarkDocument('benchmark_plan', id));
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
  });

  app.post('/benchmark/plans/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const planRecord = getBenchmarkDocument('benchmark_plan', id);
      const result = await runBenchmarkPlan(resolveBenchmarkPlan(planRecord.document));
      reply.code(201).send(result);
    } catch (error) {
      if (!sendBenchmarkError(reply, error)) {
        throw error;
      }
    }
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
