import { FastifyInstance } from 'fastify';

import { getDb } from '../../models/db.js';
import { deleteRun } from '../../services/run-service.js';

export function registerRunsRoutes(app: FastifyInstance): void {
  app.get('/runs', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all();
  });

  app.delete('/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const deleted = deleteRun(runId);
    if (!deleted.ok) {
      reply.code(deleted.code === 'RUN_ACTIVE' ? 409 : 404).send({ error: deleted.error });
      return;
    }
    reply.code(204).send();
  });
}
