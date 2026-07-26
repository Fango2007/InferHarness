import { FastifyInstance } from 'fastify';

import { createRateLimitPreHandler } from '../middleware/rate-limit.js';
import { EvaluationValidationError, createEvaluation, listEvaluations } from '../../services/evaluation-service.js';
import * as evalPromptModel from '../../models/eval-prompt.js';
import * as evaluationModel from '../../models/evaluation.js';
import { getDb } from '../../models/db.js';

export function registerEvaluationsRoutes(app: FastifyInstance): void {
  const evaluationsRateLimit = createRateLimitPreHandler({
    keyPrefix: 'evaluations',
    maxRequests: 60,
    windowMs: 60_000
  });

  app.post('/evaluations', async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    try {
      const evaluation = await createEvaluation({
        prompt_text: body.prompt_text as string,
        tags: (body.tags as string[]) ?? [],
        server_id: body.server_id as string,
        model_name: body.model_name as string,
        inference_config: body.inference_config as {
          temperature: number | null;
          top_p: number | null;
          max_tokens: number | null;
          quantization_level: string | null;
        },
        answer_text: body.answer_text as string,
        input_tokens: (body.input_tokens as number | null) ?? null,
        output_tokens: (body.output_tokens as number | null) ?? null,
        total_tokens: (body.total_tokens as number | null) ?? null,
        latency_ms: (body.latency_ms as number | null) ?? null,
        word_count: (body.word_count as number | null) ?? null,
        estimated_cost: (body.estimated_cost as number | null) ?? null,
        accuracy_score: body.accuracy_score as number,
        relevance_score: body.relevance_score as number,
        coherence_score: body.coherence_score as number,
        completeness_score: body.completeness_score as number,
        helpfulness_score: body.helpfulness_score as number,
        note: (body.note as string | null) ?? null
      });
      reply.code(201).send(evaluation);
    } catch (err) {
      if (err instanceof EvaluationValidationError) {
        reply.code(400).send({ error: 'Validation failed', issues: err.issues });
        return;
      }
      throw err;
    }
  });

  app.get('/evaluations', { preHandler: evaluationsRateLimit }, async (request, reply) => {
    const query = request.query as {
      model_name?: string;
      date_from?: string;
      date_to?: string;
      limit?: string;
      offset?: string;
    };

    const limit = query.limit ? Math.min(parseInt(query.limit, 10), 500) : 100;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    const result = listEvaluations({
      model_name: query.model_name,
      date_from: query.date_from,
      date_to: query.date_to,
      limit,
      offset
    });

    reply.code(200).send(result);
  });

  app.get('/evaluations/:evaluationId', { preHandler: evaluationsRateLimit }, async (request, reply) => {
    const { evaluationId } = request.params as { evaluationId: string };
    const evaluation = evaluationModel.getById(evaluationId);
    if (!evaluation) {
      reply.code(404).send({ error: 'Evaluation not found' });
      return;
    }
    const prompt = evalPromptModel.getById(evaluation.prompt_id);
    const server = getDb()
      .prepare('SELECT server_id, display_name FROM inference_servers WHERE server_id = ?')
      .get(evaluation.server_id) as { server_id: string; display_name: string } | undefined;
    reply.code(200).send({
      evaluation,
      prompt,
      server: server ?? null,
      composite_score:
        (evaluation.accuracy_score +
          evaluation.relevance_score +
          evaluation.coherence_score +
          evaluation.completeness_score +
          evaluation.helpfulness_score) /
        5
    });
  });
}
