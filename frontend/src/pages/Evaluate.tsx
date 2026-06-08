import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState.js';
import { MergedPageHeader } from '../components/MergedPageHeader.js';
import { RunDetailDisplay } from '../components/RunDetailDisplay.js';
import {
  EvaluationQueueDetail,
  EvaluationQueueItem,
  EvaluationQueueResponse,
  EvaluationQueueScoreInput,
  EvaluationQueueStatus,
  getEvaluationQueueDetail,
  listEvaluationQueue,
  scoreEvaluationQueueItem,
  skipEvaluationQueueItem,
  validateQueueScores
} from '../services/evaluation-queue-api.js';

const SCORE_FIELDS: Array<{ key: keyof EvaluationQueueScoreInput; label: string }> = [
  { key: 'accuracy_score', label: 'Accuracy' },
  { key: 'relevance_score', label: 'Relevance' },
  { key: 'coherence_score', label: 'Coherence' },
  { key: 'completeness_score', label: 'Completeness' },
  { key: 'helpfulness_score', label: 'Helpfulness' }
];

const DEFAULT_SCORES: EvaluationQueueScoreInput = {
  accuracy_score: 3,
  relevance_score: 3,
  coherence_score: 3,
  completeness_score: 3,
  helpfulness_score: 3,
  note: null
};

const EMPTY_QUEUE_RESPONSE: EvaluationQueueResponse = {
  counts: { pending: 0, done: 0, skipped: 0 },
  items: []
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function Evaluate() {
  const [status, setStatus] = useState<EvaluationQueueStatus>('pending');
  const [items, setItems] = useState<EvaluationQueueItem[]>([]);
  const [counts, setCounts] = useState<Record<EvaluationQueueStatus, number>>({ pending: 0, done: 0, skipped: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvaluationQueueDetail | null>(null);
  const [scores, setScores] = useState<EvaluationQueueScoreInput>(DEFAULT_SCORES);
  const [activeScoreIndex, setActiveScoreIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIndex = useMemo(() => items.findIndex((item) => item.test_result_id === selectedId), [items, selectedId]);

  const loadQueue = useCallback(async (nextStatus = status) => {
    setLoading(true);
    setError(null);
    try {
      const response = await listEvaluationQueue(nextStatus);
      setCounts(response.counts);
      setItems(response.items);
      setSelectedId((current) => current && response.items.some((item) => item.test_result_id === current)
        ? current
        : response.items[0]?.test_result_id ?? null);
      if (response.items.length === 0) {
        setDetail(null);
      }
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load evaluation queue');
      setItems([]);
      setSelectedId(null);
      setDetail(null);
      return EMPTY_QUEUE_RESPONSE;
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    getEvaluationQueueDetail(selectedId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load queue item'));
  }, [selectedId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (/^[1-5]$/.test(event.key)) {
        const field = SCORE_FIELDS[activeScoreIndex].key;
        setScores((current) => ({ ...current, [field]: Number(event.key) }));
      }
      if (event.key === 'Enter' && status === 'pending') {
        event.preventDefault();
        handleSaveNext();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  async function handleSaveNext() {
    if (!detail || !validateQueueScores(scores)) {
      return;
    }
    const scoredId = detail.test_result_id;
    setBusy(true);
    setError(null);
    try {
      await scoreEvaluationQueueItem(scoredId, scores);
      window.dispatchEvent(new CustomEvent('evaluations:saved'));
      setScores(DEFAULT_SCORES);
      setCounts((current) => ({
        ...current,
        pending: Math.max(0, current.pending - 1),
        done: current.done + 1
      }));
      const remaining = items.filter((item) => item.test_result_id !== scoredId);
      setItems(remaining);
      const nextItem = remaining[Math.max(0, Math.min(selectedIndex, remaining.length - 1))] ?? null;
      setSelectedId(nextItem?.test_result_id ?? null);
      if (!nextItem) {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save score');
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!detail) return;
    const skippedId = detail.test_result_id;
    setBusy(true);
    setError(null);
    try {
      await skipEvaluationQueueItem(skippedId);
      setCounts((current) => ({
        ...current,
        pending: Math.max(0, current.pending - 1),
        skipped: current.skipped + 1
      }));
      const remaining = items.filter((item) => item.test_result_id !== skippedId);
      setItems(remaining);
      const nextItem = remaining[Math.max(0, Math.min(selectedIndex, remaining.length - 1))] ?? null;
      setSelectedId(nextItem?.test_result_id ?? null);
      if (!nextItem) {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to skip item');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MergedPageHeader
        title="Evaluate"
        subtitle="Score completed run outputs against the five-field leaderboard rubric."
        action={<button type="button" className="btn btn--ghost" onClick={() => loadQueue(status)} disabled={loading || busy}>Refresh</button>}
      />
      <section className="page evaluate-queue-page">
        {error ? <div className="error">{error}</div> : null}
        {loading ? <p className="muted">Loading evaluation queue...</p> : null}
        {!loading && items.length === 0 && status === 'pending' ? (
          <EmptyState
            className="evaluate-empty"
            title="All caught up"
            body="New evaluations appear here when completed runs are ready for scoring."
          />
        ) : (
          <div className="evaluate-queue-layout">
            <aside className="evaluate-queue-rail">
              <div className="evaluate-tabs">
                {(['pending', 'done', 'skipped'] as EvaluationQueueStatus[]).map((entry) => (
                  <button
                    type="button"
                    key={entry}
                    className={status === entry ? 'is-active' : ''}
                    onClick={() => {
                      setStatus(entry);
                      loadQueue(entry);
                    }}
                  >
                    {entry} · {counts[entry]}
                  </button>
                ))}
              </div>
              <div className="evaluate-queue-list">
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.test_result_id}
                    className={selectedId === item.test_result_id ? 'evaluate-queue-row is-selected' : 'evaluate-queue-row'}
                    onClick={() => setSelectedId(item.test_result_id)}
                  >
                    <span>
                      <strong>{item.test_result_id.slice(0, 8)}</strong>
                      <small>{formatTime(item.started_at)}</small>
                    </span>
                    <span>{item.model_name}</span>
                    <small>{item.template_label}</small>
                  </button>
                ))}
              </div>
            </aside>
            <main className="evaluate-run-panel">
              <RunDetailDisplay detail={detail} />
            </main>
            <aside className="evaluate-rubric">
              <div>
                <span className="label--uppercase">Rubric</span>
                <h3>Manual score</h3>
              </div>
              {SCORE_FIELDS.map((field, index) => (
                <label key={field.key} className={activeScoreIndex === index ? 'score-row is-active' : 'score-row'}>
                  <span>{field.label}</span>
                  <strong>{scores[field.key]}/5</strong>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    value={Number(scores[field.key])}
                    onFocus={() => setActiveScoreIndex(index)}
                    onChange={(event) => setScores((current) => ({ ...current, [field.key]: Number(event.target.value) }))}
                  />
                </label>
              ))}
              <label className="evaluate-notes">
                Notes
                <textarea value={scores.note ?? ''} onChange={(event) => setScores((current) => ({ ...current, note: event.target.value }))} rows={5} />
              </label>
              <div className="evaluate-rubric-footer">
                <span>Total <strong>{SCORE_FIELDS.reduce((sum, field) => sum + Number(scores[field.key]), 0)}/25</strong></span>
                <div className="actions">
                  <button type="button" className="btn btn--ghost" onClick={handleSkip} disabled={!detail || busy || status !== 'pending'}>Skip</button>
                  <button type="button" onClick={handleSaveNext} disabled={!detail || busy || status !== 'pending' || !validateQueueScores(scores)}>Save & Next</button>
                </div>
              </div>
            </aside>
          </div>
        )}
      </section>
    </>
  );
}
