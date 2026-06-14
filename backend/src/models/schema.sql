PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inference_servers (
  server_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  runtime TEXT NOT NULL,
  endpoints TEXT NOT NULL,
  auth TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  discovery TEXT NOT NULL,
  raw TEXT NOT NULL,
  CHECK (NOT (active = 1 AND archived = 1))
);

CREATE TABLE IF NOT EXISTS models (
  server_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  base_model_name TEXT,
  model_schema_version TEXT NOT NULL,
  identity TEXT NOT NULL,
  architecture TEXT NOT NULL,
  modalities TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  limits TEXT NOT NULL,
  performance TEXT NOT NULL,
  configuration TEXT NOT NULL,
  discovery TEXT NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (server_id, model_id),
  FOREIGN KEY (server_id) REFERENCES inference_servers(server_id),
  CHECK (NOT (active = 1 AND archived = 1))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  inference_server_id TEXT NOT NULL,
  suite_id TEXT,
  test_id TEXT,
  profile_id TEXT,
  profile_version TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  environment_snapshot TEXT,
  retention_days INTEGER,
  CHECK (
    (suite_id IS NOT NULL AND test_id IS NULL)
    OR (suite_id IS NULL AND test_id IS NOT NULL)
  ),
  FOREIGN KEY (inference_server_id) REFERENCES inference_servers(server_id)
);

CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  failure_reason TEXT,
  metrics TEXT,
  artefacts TEXT,
  raw_events TEXT,
  repetition_stats TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS test_result_documents (
  test_result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_result_id) REFERENCES test_results(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS metric_samples (
  id TEXT PRIMARY KEY,
  test_result_id TEXT NOT NULL,
  repetition_index INTEGER NOT NULL,
  ttfb_ms REAL,
  total_ms REAL,
  prefill_ms REAL,
  decode_ms REAL,
  tokens_per_sec REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_result_id) REFERENCES test_results(id)
);

CREATE INDEX IF NOT EXISTS idx_runs_inference_server ON runs(inference_server_id);
CREATE INDEX IF NOT EXISTS idx_results_run ON test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_result_documents_run ON test_result_documents(run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_result ON metric_samples(test_result_id);

CREATE TABLE IF NOT EXISTS inference_param_presets (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  parameters          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inference_param_presets_name
  ON inference_param_presets(name);

CREATE TABLE IF NOT EXISTS eval_prompts (
  id          TEXT NOT NULL PRIMARY KEY,
  text        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_prompts_created_at ON eval_prompts(created_at);

CREATE TABLE IF NOT EXISTS evaluations (
  id                  TEXT NOT NULL PRIMARY KEY,
  prompt_id           TEXT NOT NULL,
  model_name          TEXT NOT NULL,
  server_id           TEXT NOT NULL,
  inference_config    TEXT NOT NULL,
  answer_text         TEXT NOT NULL,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  total_tokens        INTEGER,
  latency_ms          REAL,
  word_count          INTEGER,
  estimated_cost      REAL,
  accuracy_score      INTEGER NOT NULL CHECK (accuracy_score BETWEEN 1 AND 5),
  relevance_score     INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
  coherence_score     INTEGER NOT NULL CHECK (coherence_score BETWEEN 1 AND 5),
  completeness_score  INTEGER NOT NULL CHECK (completeness_score BETWEEN 1 AND 5),
  helpfulness_score   INTEGER NOT NULL CHECK (helpfulness_score BETWEEN 1 AND 5),
  note                TEXT,
  source_test_result_id TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (prompt_id)  REFERENCES eval_prompts(id),
  FOREIGN KEY (server_id)  REFERENCES inference_servers(server_id),
  FOREIGN KEY (source_test_result_id) REFERENCES test_results(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_evaluations_model_name  ON evaluations(model_name);
CREATE INDEX IF NOT EXISTS idx_evaluations_prompt_id   ON evaluations(prompt_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_created_at  ON evaluations(created_at);
CREATE INDEX IF NOT EXISTS idx_evaluations_server_id   ON evaluations(server_id);
CREATE TABLE IF NOT EXISTS evaluation_queue_skips (
  test_result_id TEXT PRIMARY KEY,
  reason         TEXT,
  skipped_at     TEXT NOT NULL,
  FOREIGN KEY (test_result_id) REFERENCES test_results(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_architecture_settings (
  server_id         TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  trust_remote_code INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (server_id, model_id),
  FOREIGN KEY (server_id, model_id) REFERENCES models(server_id, model_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS benchmark_test_instantiations (
  id                  TEXT PRIMARY KEY,
  schema_version      TEXT NOT NULL,
  document_hash       TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  template_version    TEXT NOT NULL,
  server_id           TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  dataset_hash        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'created',
  document            TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (server_id, model_id) REFERENCES models(server_id, model_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_instantiations_hash
  ON benchmark_test_instantiations(document_hash);
CREATE INDEX IF NOT EXISTS idx_benchmark_instantiations_template
  ON benchmark_test_instantiations(template_id, template_version);
CREATE INDEX IF NOT EXISTS idx_benchmark_instantiations_model
  ON benchmark_test_instantiations(server_id, model_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_instantiations_dataset
  ON benchmark_test_instantiations(dataset_hash);

CREATE TABLE IF NOT EXISTS benchmark_test_run_results (
  id                  TEXT PRIMARY KEY,
  schema_version      TEXT NOT NULL,
  document_hash       TEXT NOT NULL,
  instantiation_id    TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  status              TEXT NOT NULL,
  document            TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (instantiation_id) REFERENCES benchmark_test_instantiations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_results_hash
  ON benchmark_test_run_results(document_hash);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_instantiation
  ON benchmark_test_run_results(instantiation_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_run
  ON benchmark_test_run_results(run_id);

CREATE TABLE IF NOT EXISTS benchmark_documents (
  id             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  document       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
