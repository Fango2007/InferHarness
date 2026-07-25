# InferHarness Database Schema

Status: Current database-schema specification

Last updated: 2026-07-25

## 1. Purpose

This document describes the current InferHarness SQLite database schema: table
ownership, relationships, persisted JSON fields, indexes, and startup
migrations.

The runtime database definition remains in `backend/src/models/schema.sql`.
Backend code must not load this document at runtime. When the SQLite schema or
startup migrations change, update both the backend source definition and this
document.

## 2. Runtime Storage

InferHarness uses local SQLite through `better-sqlite3`.

| Concern | Current behavior |
|---|---|
| Default database path | `backend/data/db/inferharness.sqlite` |
| Override | `INFERHARNESS_DB_PATH` |
| Backend test default | `backend/data/db/backend-test.sqlite` |
| Journal mode | `WAL` |
| Foreign keys | Enabled through `PRAGMA foreign_keys = ON` |
| Runtime source | `backend/src/models/schema.sql` |

Backend tests cannot use the production database path when running in backend
test mode.

## 3. Startup Application

`backend/src/api/server.ts` applies the SQL definition from
`backend/src/models/schema.sql` during server creation. It also applies
lightweight compatibility migrations for older local databases:

- `models.base_model_name` is added when missing.
- `evaluations.source_test_result_id` is added when missing.
- `idx_evaluations_source_test_result` is created when missing.
- `idx_evaluations_source_test_result_unique` is created when missing and
  enforces one evaluation per linked `test_result_id` when the link is present.

The schema is idempotent: tables and indexes use `CREATE ... IF NOT EXISTS`.

## 4. Table Groups

### 4.1 Catalog

`inference_servers` stores registered inference endpoints and discovery
snapshots.

| Column group | Fields |
|---|---|
| Identity/state | `server_id`, `display_name`, `active`, `archived`, `created_at`, `updated_at`, `archived_at` |
| JSON snapshots | `runtime`, `endpoints`, `auth`, `capabilities`, `discovery`, `raw` |
| Constraints | `server_id` primary key; active and archived cannot both be true |

`models` stores normalized model records per inference server.

| Column group | Fields |
|---|---|
| Identity/state | `server_id`, `model_id`, `display_name`, `active`, `archived`, `created_at`, `updated_at`, `archived_at`, `base_model_name`, `model_schema_version` |
| JSON snapshots | `identity`, `architecture`, `modalities`, `capabilities`, `limits`, `performance`, `configuration`, `discovery`, `raw` |
| Constraints | composite primary key `(server_id, model_id)`; foreign key to `inference_servers(server_id)`; active and archived cannot both be true |

Catalog JSON field shapes are specified in `docs/schemas/` and implemented by
the backend schema files under `backend/src/schemas/`.

### 4.2 Runs and Results

`runs` stores execution envelopes tied to an inference server.

| Field | Purpose |
|---|---|
| `id` | Run identifier |
| `inference_server_id` | Server used for the run |
| `suite_id` / `test_id` | Exactly one is present |
| `profile_id`, `profile_version` | Optional execution profile identity |
| `status`, `started_at`, `ended_at` | Lifecycle state |
| `environment_snapshot` | JSON environment capture |
| `retention_days` | Optional retention policy |

Indexes:

- `idx_runs_inference_server` on `runs(inference_server_id)`.

`test_results` stores result rows under a run.

| Field | Purpose |
|---|---|
| `id`, `run_id`, `test_id` | Result identity and parent run |
| `verdict`, `failure_reason` | Outcome summary |
| `metrics`, `artefacts`, `raw_events`, `repetition_stats` | JSON result payloads |
| `started_at`, `ended_at` | Result timing |

Indexes:

- `idx_results_run` on `test_results(run_id)`.

`test_result_documents` stores canonical result documents linked one-to-one to
`test_results`.

| Field | Purpose |
|---|---|
| `test_result_id` | Primary key and linked result |
| `run_id`, `test_id` | Query denormalization |
| `schema_version`, `document`, `created_at` | Document payload and version |

Indexes:

- `idx_result_documents_run` on `test_result_documents(run_id)`.

`metric_samples` stores repeated metric samples for a test result.

| Field | Purpose |
|---|---|
| `id`, `test_result_id`, `repetition_index` | Sample identity |
| `ttfb_ms`, `total_ms`, `prefill_ms`, `decode_ms` | Timing metrics |
| `tokens_per_sec`, `prompt_tokens`, `completion_tokens` | Token and throughput metrics |
| `created_at` | Sample timestamp |

Indexes:

- `idx_metrics_result` on `metric_samples(test_result_id)`.

### 4.3 Benchmark Documents and Executions

`benchmark_documents` stores reusable benchmark library documents indexed by
kind and id.

| Field | Purpose |
|---|---|
| `id`, `kind` | Composite primary key |
| `schema_version`, `document` | Versioned JSON document |
| `created_at`, `updated_at` | Persistence timestamps |

`benchmark_test_instantiations` stores immutable run-ready benchmark snapshots.

| Field | Purpose |
|---|---|
| `id` | Instantiation identifier |
| `schema_version`, `document_hash`, `document` | Versioned immutable JSON snapshot |
| `template_id`, `template_version` | Template lineage |
| `server_id`, `model_id` | Target model identity |
| `dataset_hash` | Dataset proof |
| `status`, `created_at`, `updated_at` | Lifecycle metadata |

Constraints and indexes:

- foreign key `(server_id, model_id)` to `models(server_id, model_id)`;
- unique `idx_benchmark_instantiations_hash` on `document_hash`;
- `idx_benchmark_instantiations_template` on `(template_id, template_version)`;
- `idx_benchmark_instantiations_model` on `(server_id, model_id)`;
- `idx_benchmark_instantiations_dataset` on `dataset_hash`.

`benchmark_test_run_results` stores immutable benchmark execution results.

| Field | Purpose |
|---|---|
| `id` | Result document id |
| `schema_version`, `document_hash`, `document` | Versioned result document |
| `instantiation_id` | Parent benchmark instantiation |
| `run_id` | Linked run envelope |
| `status`, `created_at` | Result lifecycle metadata |

Constraints and indexes:

- foreign key to `benchmark_test_instantiations(id)` with cascade delete;
- unique `idx_benchmark_results_hash` on `document_hash`;
- `idx_benchmark_results_instantiation` on `instantiation_id`;
- `idx_benchmark_results_run` on `run_id`.

### 4.4 Manual Evaluation and Leaderboard

`eval_prompts` stores reusable manual-evaluation prompts.

| Field | Purpose |
|---|---|
| `id` | Prompt id |
| `text` | Prompt text |
| `tags` | JSON tag list |
| `created_at` | Creation timestamp |

Indexes:

- `idx_eval_prompts_created_at` on `created_at`.

`evaluations` stores qualitative model scores.

| Field group | Fields |
|---|---|
| Identity | `id`, `prompt_id`, `model_name`, `server_id`, `created_at` |
| Request/response | `inference_config`, `answer_text`, `source_test_result_id` |
| Metrics | `input_tokens`, `output_tokens`, `total_tokens`, `latency_ms`, `word_count`, `estimated_cost` |
| Scores | `accuracy_score`, `relevance_score`, `coherence_score`, `completeness_score`, `helpfulness_score` |
| Notes | `note` |

Constraints and indexes:

- foreign key to `eval_prompts(id)`;
- foreign key to `inference_servers(server_id)`;
- optional foreign key to `test_results(id)` with `ON DELETE SET NULL`;
- score fields must be integers from 1 through 5;
- indexes on `model_name`, `prompt_id`, `created_at`, and `server_id`;
- source-result index and partial unique source-result index are applied by
  startup migration.

`evaluation_queue_skips` stores explicit skips for benchmark results that should
not appear in the evaluation queue.

| Field | Purpose |
|---|---|
| `test_result_id` | Primary key and linked test result |
| `reason` | Optional skip reason |
| `skipped_at` | Skip timestamp |

### 4.5 Settings and Presets

`inference_param_presets` stores reusable inference-parameter presets.

| Field | Purpose |
|---|---|
| `id`, `name` | Preset identity |
| `parameters` | JSON parameter payload |
| `created_at`, `updated_at` | Persistence timestamps |

Indexes:

- unique `idx_inference_param_presets_name` on `name`.

`model_architecture_settings` stores per-model architecture-inspection settings.

| Field | Purpose |
|---|---|
| `server_id`, `model_id` | Composite primary key and linked model |
| `trust_remote_code` | Explicit remote-code trust flag |
| `updated_at` | Update timestamp |

The table references `models(server_id, model_id)` with cascade delete.

`app_settings` stores named application settings.

| Field | Purpose |
|---|---|
| `key` | Setting key |
| `value` | String value, often JSON encoded by service code |
| `updated_at` | Update timestamp |

## 5. Delete and Retention Behavior

Foreign keys express some cascade behavior, but service code also performs
explicit cleanup for several workflows:

- deleting an inference server removes related benchmark run results,
  instantiations, metric samples, result documents, test results, runs,
  evaluations, models, and then the server;
- retention cleanup removes expired `runs`, related `test_results`, and related
  `metric_samples`;
- benchmark result deletion removes rows from `benchmark_test_run_results`.

Do not infer complete business retention behavior from foreign keys alone.
Check the owning service before changing table relationships.

## 6. JSON Columns

Several tables persist JSON as `TEXT`. The database stores the payloads, while
shape validation and interpretation live in backend services and JSON Schema
contracts.

Important JSON columns include:

- `inference_servers.runtime`, `endpoints`, `auth`, `capabilities`,
  `discovery`, `raw`;
- `models.identity`, `architecture`, `modalities`, `capabilities`, `limits`,
  `performance`, `configuration`, `discovery`, `raw`;
- `runs.environment_snapshot`;
- `test_results.metrics`, `artefacts`, `raw_events`, `repetition_stats`;
- `test_result_documents.document`;
- `benchmark_documents.document`;
- `benchmark_test_instantiations.document`;
- `benchmark_test_run_results.document`;
- `eval_prompts.tags`;
- `evaluations.inference_config`;
- `inference_param_presets.parameters`.

When a JSON payload shape changes, update the relevant JSON Schema
specification, backend implementation copy, and this database document if table
meaning or relationships change.

## 7. Change Control

Update this document when:

- `backend/src/models/schema.sql` changes;
- startup migrations in `backend/src/api/server.ts` change;
- table ownership or cleanup semantics change;
- JSON column meaning changes materially;
- indexes, foreign keys, uniqueness, or check constraints change.

Database schema changes should remain backward-compatible for existing local
databases unless a release explicitly documents a destructive migration.
