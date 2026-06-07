# Backend Schemas

The active application schemas live in this directory. These files are the canonical shapes for persisted records, runtime snapshots, evaluation payloads, and architecture inspection output. New benchmark pipeline contracts should reuse these object names and nested structures directly, or extend the canonical schema when a benchmark need is missing.

Legacy test-template and test-result schemas are intentionally excluded from this active catalog: `json-test-template-schema.json`, `python-test-template-schema.json`, and `test-run-result.schema.json` are scenario-era contracts that the new benchmark pipeline is expected to replace.

**`model-schema.json`**
Role: canonical model catalog record.
Producer/consumer: produced by model registration, discovery, update flows, and model repository normalization; consumed by the Models UI, run setup, evaluation, benchmark target selection, and architecture inspection.
Key objects: `model`, `identity`, `architecture`, `modalities`, `capabilities`, `limits`, `performance`, `configuration`, `discovery`, `raw`.
Persistence/runtime usage: persisted as normalized model metadata in SQLite and returned by `/models`. Benchmark `model_profile` and `model_snapshot` should keep model identity, quantization, precision, and model capability data in this shape.
Compatibility notes: `identity.provider` is the LLM/base-model provider, not the inference-server runtime. Quantization belongs under `architecture.quantisation`; precision belongs under `architecture.precision`.

**`inferencer-server-schema.json`**
Role: canonical inference-server registry and discovery snapshot.
Producer/consumer: produced by inference-server registration, connectivity checks, and discovery refreshes; consumed by server management, model discovery, run execution, evaluation, and benchmark instantiation.
Key objects: `inference_server`, `runtime`, `endpoints`, `auth`, `capabilities`, `discovery`, `raw`.
Persistence/runtime usage: persisted as the server record in SQLite and returned by `/inference-servers`. Benchmark snapshots should use this shape instead of a separate `serving` block.
Compatibility notes: persisted snapshots must redact secrets in `auth.token` while preserving `token_present` and `token_env`.

**`inference-config.schema.json`**
Role: canonical inference-parameter snapshot for reproducible evaluation and benchmark execution.
Producer/consumer: produced by evaluation forms, compare-mode execution, and future benchmark runtime profiles; consumed by evaluation persistence and request builders.
Key fields: `temperature`, `top_p`, `max_tokens`, `stream`, `seed`, `stop`, `presence_penalty`, `frequency_penalty`, `timeout_ms`, `unsupported_parameter_policy`, and legacy `quantization_level`.
Persistence/runtime usage: embedded in evaluation records and reusable by benchmark `runtime_parameters`.
Compatibility notes: `quantization_level` is retained only for older evaluation payload compatibility. New benchmark records should use `model.architecture.quantisation` and `model.architecture.precision`.

**`evaluation.schema.json`**
Role: scored answer record for qualitative model evaluation.
Producer/consumer: produced by manual evaluation and compare-mode submissions; consumed by evaluation history, leaderboard ranking, and metrics views.
Key objects: prompt/model identity fields, `inference_config`, answer text, token/latency metrics, five qualitative scores, notes, and optional `source_test_result_id`.
Persistence/runtime usage: validates records before evaluation persistence and leaderboard aggregation.
Compatibility notes: its embedded `inference_config` accepts the same parameter names as `inference-config.schema.json` plus the legacy `quantization_level` field.

**`eval-prompt.schema.json`**
Role: reusable prompt record for manual LLM evaluation sessions.
Producer/consumer: produced by evaluation prompt authoring and prompt submission flows; consumed by evaluation execution and leaderboard filtering.
Key objects: prompt `text` and optional `tags`.
Persistence/runtime usage: validates prompt records before evaluation sessions and supports tagged result comparison.
Compatibility notes: tags are unique, short labels intended for filtering, not benchmark capability requirements.

**`architecture-tree.schema.json`**
Role: canonical model architecture inspection result.
Producer/consumer: produced by the Python architecture inspector; consumed by the architecture API and frontend tree viewer.
Key objects: `schema_version`, `model_id`, `format`, `inspection_method`, `accuracy`, `warnings`, `summary`, `root`, and recursive layer nodes.
Persistence/runtime usage: returned by architecture inspection routes and used to render expandable layer trees with parameter counts.
Compatibility notes: inspection may be exact or estimated depending on source metadata; warnings carry uncertainty without changing the model catalog schema.

**`architecture-settings.schema.json`**
Role: user-controlled architecture inspection settings.
Producer/consumer: produced by architecture settings UI/API calls; consumed by inspection routes before launching the Python subprocess.
Key objects: `trust_remote_code`.
Persistence/runtime usage: stored as per-model inspection settings and used to guard Hugging Face model loading behavior.
Compatibility notes: `trust_remote_code` must remain explicit because it changes the execution risk of model inspection.

**`benchmark/*.schema.json`**
Role: runtime-promoted contract pack for the new benchmark pipeline foundations.
Producer/consumer: produced by benchmark validation, offline instantiation, and synthetic result persistence; consumed by benchmark foundation APIs before the Python execution engine is wired in.
Key objects: `model_profile`, `model_snapshot`, `runtime_profile`, `dataset_manifest`, `test_template`, `test_instantiation`, `test_run_result`, and `benchmark_plan`.
Persistence/runtime usage: `benchmark_test_instantiations` and `benchmark_test_run_results` store validated immutable JSON documents plus stable document hashes.
Compatibility notes: these schemas stay standalone for the current AJV-by-file validator. Scenario-era template and result schemas remain separate until the benchmark engine replaces that path.
