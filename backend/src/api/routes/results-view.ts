import { FastifyInstance } from 'fastify';

import { deleteResultsRun, getResultsRunDetail, queryResultsView } from '../../services/results-view-service.js';

export function registerResultsViewRoutes(app: FastifyInstance): void {
  app.post('/results-view/query', async (request, reply) => {
    const response = queryResultsView((request.body as Record<string, unknown> | undefined) ?? {});
    if (!response.ok) {
      reply.code(400).send({ error: response.error, code: response.code });
      return;
    }
    reply.send(response.value);
  });

  app.get('/results-view/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const detail = getResultsRunDetail(runId);
    if (!detail) {
      reply.code(404).send({ error: 'Run not found' });
      return;
    }
    reply.send(detail);
  });

  app.delete('/results-view/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const deleted = deleteResultsRun(runId);
    if (!deleted.ok) {
      reply.code(404).send({ error: deleted.error });
      return;
    }
    reply.code(204).send();
  });
}
