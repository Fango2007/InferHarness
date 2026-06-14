import { getDb } from '../models/db.js';
import { parseJson } from '../models/repositories.js';
import { logEvent } from './observability.js';

export interface RunRecord {
  id: string;
  inference_server_id: string;
  suite_id: string | null;
  test_id: string | null;
  profile_id: string | null;
  profile_version: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  environment_snapshot: Record<string, unknown> | null;
  retention_days: number | null;
}

export type DeleteRunResult =
  | { ok: true }
  | { ok: false; code: 'RUN_NOT_FOUND' | 'RUN_ACTIVE'; error: string };

export function getRun(id: string): RunRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  if (!row) {
    return null;
  }
  return {
    ...row,
    environment_snapshot: parseJson(row.environment_snapshot as unknown as string)
  };
}

export function deleteRun(id: string): DeleteRunResult {
  const db = getDb();
  const row = db.prepare('SELECT id, status FROM runs WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  if (!row) {
    return { ok: false, code: 'RUN_NOT_FOUND', error: 'Run not found' };
  }
  if (row.status === 'queued' || row.status === 'running') {
    return { ok: false, code: 'RUN_ACTIVE', error: 'Active runs cannot be deleted' };
  }

  const transaction = db.transaction((runId: string) => {
    const resultRows = db.prepare('SELECT id FROM test_results WHERE run_id = ?').all(runId) as Array<{ id: string }>;
    const resultIds = resultRows.map((result) => result.id);

    if (resultIds.length > 0) {
      const placeholders = resultIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM metric_samples WHERE test_result_id IN (${placeholders})`).run(...resultIds);
      db.prepare(`DELETE FROM evaluation_queue_skips WHERE test_result_id IN (${placeholders})`).run(...resultIds);
      db.prepare(`DELETE FROM test_result_documents WHERE test_result_id IN (${placeholders})`).run(...resultIds);
    }

    db.prepare('DELETE FROM test_results WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  });

  transaction(id);
  logEvent({
    level: 'info',
    message: 'run deleted',
    meta: { run_id: id }
  });
  return { ok: true };
}
