import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb, resolvedDbPath, runSchema } from '../models/db.js';
import { registerAuth } from './middleware/auth.js';
import { registerResultsViewRoutes } from './routes/results-view.js';
import { registerInferenceServersRoutes } from './routes/inference-servers.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerEvaluationsRoutes } from './routes/evaluations.js';
import { registerLeaderboardRoutes } from './routes/leaderboard.js';
import { registerArchitectureRoutes } from './routes/architecture.js';
import { registerBenchmarkRoutes } from './routes/benchmark.js';
import { registerInferenceParamPresetRoutes } from './routes/inference-param-presets.js';
import { registerEvaluationQueueRoutes } from './routes/evaluation-queue.js';
import { installBenchmarkLibraryDocuments, shouldAutoSeedBenchmarkLibrary } from '../services/benchmark-library.js';

function applyColumnMigrations(): void {
  const db = getDb();
  const modelColumns = (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!modelColumns.includes('base_model_name')) {
    db.exec('ALTER TABLE models ADD COLUMN base_model_name TEXT');
  }
  const evaluationColumns = (db.prepare('PRAGMA table_info(evaluations)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!evaluationColumns.includes('source_test_result_id')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN source_test_result_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_evaluations_source_test_result
      ON evaluations(source_test_result_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_source_test_result_unique
      ON evaluations(source_test_result_id)
      WHERE source_test_result_id IS NOT NULL;
  `);
}

export function createServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(moduleDir, '../models/schema.sql');
  if (fs.existsSync(schemaPath)) {
    runSchema(fs.readFileSync(schemaPath, 'utf8'));
  }
  applyColumnMigrations();
  if (shouldAutoSeedBenchmarkLibrary()) {
    const report = installBenchmarkLibraryDocuments();
    const invalidCount = report.invalid.length;
    if (invalidCount > 0) {
      app.log.warn({ invalidCount }, 'Benchmark library loaded with invalid documents');
    }
  }
  if (process.env.INFERHARNESS_E2E === '1' && process.env.INFERHARNESS_E2E_MARKER_PATH) {
    fs.mkdirSync(path.dirname(process.env.INFERHARNESS_E2E_MARKER_PATH), { recursive: true });
    fs.writeFileSync(
      process.env.INFERHARNESS_E2E_MARKER_PATH,
      JSON.stringify({ db_path: resolvedDbPath(), pid: process.pid, created_at: new Date().toISOString() }, null, 2),
      'utf8'
    );
  }

  registerAuth(app);

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin ?? '*';
    const reqHeaders = request.headers['access-control-request-headers'];
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      typeof reqHeaders === 'string' && reqHeaders.length > 0
        ? reqHeaders
        : 'content-type,x-api-token'
    );
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    return payload;
  });

  app.get('/health', async () => {
    const payload: { status: 'ok'; db_path?: string } = { status: 'ok' };
    if (process.env.INFERHARNESS_E2E === '1') {
      payload.db_path = resolvedDbPath();
    }
    return payload;
  });

  registerSystemRoutes(app);
  registerInferenceServersRoutes(app);
  registerModelsRoutes(app);
  registerResultsViewRoutes(app);
  registerEvaluationsRoutes(app);
  registerEvaluationQueueRoutes(app);
  registerInferenceParamPresetRoutes(app);
  registerLeaderboardRoutes(app);
  registerArchitectureRoutes(app);
  registerBenchmarkRoutes(app);

  return app;
}
