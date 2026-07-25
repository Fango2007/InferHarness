# InferHarness Schema Specifications

This directory documents the active application schemas. These files describe the canonical shapes for persisted records, runtime snapshots, evaluation payloads, benchmark documents, and architecture inspection output. Runtime backend code loads its implementation copy from `backend/src/schemas/`; it must not load schemas from `docs/`. Keep the documented schemas here synchronized with the backend source copy when schema contracts change. New benchmark pipeline contracts should reuse these object names and nested structures directly, or extend the canonical schema when a benchmark need is missing.

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
Role: runtime-promoted contract pack for benchmark templates, datasets, plans, instantiations, and execution results.
Producer/consumer: produced by benchmark document authoring, library import, instantiation, execution, and result persistence; consumed by benchmark foundation APIs, the runner, Results views, and Run-page template selection.
Key objects: `model_profile`, `model_snapshot`, `runtime_profile`, `dataset_manifest`, `test_template`, `test_instantiation`, `test_run_result`, and `benchmark_plan`.
Persistence/runtime usage: `benchmark_test_instantiations` and `benchmark_test_run_results` store validated immutable JSON documents plus stable document hashes. `test_template.metrics` is the canonical allowlist for computed benchmark metrics, including tool-call assertion metrics such as `tool_call_assertion_pass`.
Compatibility notes: these schemas stay standalone for the current AJV-by-file validator.

## Benchmark Pipeline

The benchmark pipeline is schema-first. Authoring documents are mutable and reusable, while execution documents are immutable snapshots that prove what was actually run.

**Layer 1 - Reference documents**
`test_template`, `dataset_manifest`, `runtime_profile`, and `benchmark_plan` are persisted benchmark documents. They can come from the built-in file-backed library, the writable local library, or API saves. These records are reusable inputs, not execution evidence.

**Layer 2 - Plan resolution**
`benchmark_plan` binds the reusable inputs for a run:

```json
{
  "template_ref": "agent-tool-selection-structure-v1",
  "dataset_ref": "dataset-agent-tool-selection-structure-v1",
  "runtime_profile_ref": "run-runtime-...",
  "model_profile_refs": ["server-id:model-id"]
}
```

The resolver loads each referenced document from the benchmark document store. Missing refs fail before any model call.

**Layer 3 - Instantiation**
The foundation layer turns a plan target into a `test_instantiation`. This document snapshots the template, dataset manifest, runtime parameters, model profile, model snapshot, operation spec, and stable hashes. This is the exact reproducible benchmark contract.

**Layer 4 - Execution**
The runner executes the instantiation stage by stage. For dataset loops it resolves dataset items, verifies `dataset_hash` and `item_hashes`, builds provider-specific requests, normalizes responses, and records per-item metrics. Tool-calling datasets carry `tools`, `tool_choice`, and `expected_tool_calls` at item level.

**Layer 5 - Results**
`test_run_result` stores normalized responses, metric results, aggregated metrics, request/response traces, errors, and status. Results views and comparison tables consume these documents instead of recomputing from mutable templates or datasets.

## Benchmark Schema Documents

**`test_template.schema.json`**
Reusable benchmark definition. It declares the logical operation, required capabilities, input contract, execution stages, metric ids, aggregations, and optional metadata/extensions. It should not embed concrete server endpoints or model ids.

**`dataset_manifest.schema.json`**
Persistable proof of benchmark data. It supports embedded inline items, manifest-only file references, and compressed blobs. Each item can include prompts, system prompts, expected answers, expected schemas, tool definitions, tool choice, expected tool calls, tags, and evaluation metadata.

**`runtime_profile.schema.json`**
Reusable runtime policy. It carries inference parameters and execution policy such as timeout, seed, temperature, token limits, and retry/stop behavior.

**`benchmark_plan.schema.json`**
Orchestration document. It references a template, dataset manifest, runtime profile, and one or more model profiles. The Run page creates these documents to bind selected UI inputs into an executable benchmark.

**`test_instantiation.schema.json`**
Immutable run-ready snapshot. It embeds the resolved template snapshot, model profile, model snapshot, operation spec, runtime parameters, execution policy, and dataset manifest. Persisted instantiations are the source of truth for what the runner executed.

**`test_run_result.schema.json`**
Append-only execution result. It records normalized outputs, tool calls, metrics, aggregations, errors, traces, timestamps, and status for one instantiation run.

**`model_profile.schema.json`**
Serializable model target profile. It captures stable model identity and declared capabilities needed to compare template requirements against the selected model/server.

**`model_snapshot.schema.json`**
Point-in-time capability snapshot. It freezes the server/model capabilities observed at instantiation time so later model catalog changes do not rewrite benchmark history.
