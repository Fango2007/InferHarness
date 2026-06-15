# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added

- **Adaptive Results performance views** — the Results dashboard now has an Auto performance view with manual modes for cold-start comparison, latency trend, pass-rate trend, latency histogram, and model-summary table comparisons backed by filtered model aggregates.
- **Project workflow guardrails** — `AGENTS.md` now combines the main branch workflow, Node 25 rules, challenge-and-skill behavior instructions, and a static-data rule that keeps prompts, schemas, fixtures, and examples out of application code.
- **Benchmark template agent** — Templates now includes a review-first benchmark-template agent that uses a database-persisted Settings model, challenges underspecified requests, loads its prompt from Markdown with the full `test_template` schema and example injected, validates generated drafts server-side, and applies drafts to the existing editor without auto-saving.

### Fixed

- **Benchmark foundation stress test timeout** — the indexed lookup stress test now has an explicit timeout that matches its own 10-second performance budget, avoiding Vitest preemption on slower CI runners.
- Restored tracked `AGENTS.md` project workflow rules while keeping the Node 25.x native-module guidance, restored `CLAUDE.md` tracking, and aligned Claude-specific project guidance with the enforced Node 25.x runtime.
- **Template agent settings rate limiting** — `/system/settings` and `/system/settings/template-agent-model` now use an in-memory per-client rate limit before reading or updating app settings.

## [0.8.0] - 2026-06-14

### Added

- **Real first-run onboarding** — added a frontend-only guided setup path that uses existing server, model, benchmark document, and run/result APIs to help users create their first production-ready server, model selection, starter benchmark template, and successful run without demo data or new backend endpoints.
- **Automatic local API token bootstrap** — first local startup now creates or syncs `INFERHARNESS_API_TOKEN` and `VITE_INFERHARNESS_API_TOKEN` in `.env` when missing, keeping the frontend and backend able to communicate on a fresh install.
- **README project badges** — the root README now shows version, Node.js, Python, CI, and MIT license badges.

### Changed

- **Onboarding-aware shell** — added the setup pill, welcome page, progress ribbons, handoff prompts, Settings tour controls, sidebar setup locking, and first-run completion prompt while keeping users on the Run page after a successful benchmark.
- **Starter benchmark creation** — the Run page can create a valid reusable `test_template` starter benchmark through the existing benchmark document API.

## [0.7.0] - 2026-06-14

### Added

- **Settings side-shell model selection** — Settings now uses a categorized side-shell with a dedicated local-only `Model Selection` picker backed by active `/models` records, plus foldable environment sections scoped to Runtime, Providers & Auth, Connectivity, Frontend, and Advanced instead of a duplicated catch-all environment tab.
- **README settings alignment** — the root README now calls out active development status and Settings-managed environment values.
- **Paired benchmark stage runner checkpoint** — `paired_request_loop` templates now validate and run with pair-member preservation, pair metric paths such as `pair.cold.elapsed_ms`, and simple `difference` derived metrics while keeping paired-stage authoring in the Templates Raw JSON drawer.
- **Complete benchmark-template stage authoring** — the Templates editor now exposes paired-stage fields including pair delays, pair members, simple difference derived metrics, stage observability JSON, and custom metric IDs while retaining Raw JSON as an escape hatch.
- **Templates benchmark-template authoring checkpoint** — the existing Templates page now authors benchmark `test_template` document CRUD through `/benchmark/documents`, while keeping `benchmark_plan` creation out of the UI for the later Run-page flow.
- **BenchmarkPlan ref-document checkpoint** — benchmark-native documents can now be persisted through `/benchmark/documents`, stored `benchmark_plan` documents can be created/read through `/benchmark/plans`, and `/benchmark/plans/:id/run` resolves template/dataset/runtime/model refs into the existing multi-model plan runner while keeping the inline `/benchmark/plans/run` route transitional.
- **Model load time metric** — `load_duration_ms` extracted from server-native response metadata (Ollama reports exact load time in nanoseconds on every `/api/chat` and `/api/generate` response). Exposed as a first-class metric in `computeItemMetrics` and aggregated as `max` (load only fires on the cold request). Run page metrics panel shows a "model load" row when the value is non-null and > 0; hidden for servers that don't report it (llama.cpp, vLLM, TGI).
- **Ollama protocol timing metrics** — `total_duration` (ns) feeds `server_total_time_ms` (server-measured total including load+prefill+decode); `prompt_eval_duration` (ns) → `server_prompt_eval_ms`; `eval_duration` (ns) → `server_eval_ms`. Applies to all Ollama-compatible servers (Ollama, Inferencer, etc.). Run page shows "server prefill" and "server decode" rows when non-null; server-reported, no red.
- **oMLX native metrics** — `usage.model_load_duration` (seconds) now feeds `load_duration_ms` alongside Ollama's `load_duration` (nanoseconds); `usage.total_time` (seconds) surfaces as new `server_total_time_ms` metric representing server-measured processing time (excludes network, comparable to `elapsed_ms`). Run page shows "server time" row when non-null.
- **Request-triggered load estimator** — `estimateRequestTriggeredLoad()` computes a heuristic `load_estimate` from ordered `metric_results` when ≥ 3 samples exist: compares first-request latency against the median of warm requests; detects a load event when the cold spike exceeds `max(50% of warm baseline, 3× warm stddev)`. Prefers `first_token_ms` over `elapsed_ms` when streaming data is present. Stored as `load_estimate` on the result document. Run page shows "model load (est.)" in **bold red** when detected and no native `load_duration_ms` is available — signals heuristic rather than server-reported value.

### Fixed

- Stream dropdown in Run page Step 4 options grid now matches the height of number inputs (`font-size: 12px` and explicit `height: 35px` applied uniformly via `.run-options-grid` selector).
- Derived/estimated metrics in the Run page metrics panel (`tok / s (decode)`, `tok / s (overall)`, `prefill tok / s`, `model load (est.)`) now render in bold red via `.is-estimated` class, consistently distinguishing computed values from directly measured or server-reported ones.

## [0.6.0] - 2026-06-10

### Added

- **Benchmark metrics & aggregation** — new `benchmark-metrics` service computing the full schema-advertised metric set per item (`tokens_per_second`, `output_input_token_ratio`, `exact_match`, `contains_required_terms`, `json_valid`, `schema_valid`, `regex_match`, and tool-call metrics) plus run-level aggregations (`mean`/`median`/`min`/`max`/`sum`/`count`/`p50`/`p90`/`p95`/`p99`/`stddev`/`variance`), with boolean metrics surfaced as `success_rate` and partial-execution sample accounting.
- Run page right-side metrics panel now shows tokens-per-second, duration `p95` and item count for multi-item runs, and a correctness section (per-metric success rate) when the template requests correctness metrics.
- Generation parameters (temperature, top_p, max_tokens, stream) editable inline in the Run page Step 4 options grid; previously hardcoded to defaults.
- Decode-aware throughput metrics `decode_tokens_per_second` (`output_tokens / (elapsed_ms − first_token_ms)`) and `prefill_tokens_per_second` (`input_tokens / first_token_ms`), isolating generation speed from prompt prefill on streaming runs; both null on non-streaming runs. Metrics panel shows decode / overall / prefill tok/s separately.

### Changed

- Benchmark runner replaces the stub aggregator (`count`/`elapsed_ms_mean`/`output_tokens_sum`) with template-driven metric computation and aggregation; `metric_version` bumped from `basic-v1` to `metrics-v1`.
- Response normalizer now surfaces `tool_calls` so tool-call metrics can be computed.
- Run page smoke template requests `tokens_per_second`, `decode_tokens_per_second`, `prefill_tokens_per_second`, and `p95`/`count` aggregations.
- Run page metrics panel labels clarified: `latency` → `duration` (total request time, distinct from `ttft`).

### Security

- Upgraded `shell-quote` to `^1.8.4` via a root override to remediate a known advisory.

## [0.5.0] - 2026-06-08

### Added

- **Benchmark test pipeline (phase 1)** — new `POST /benchmark` route accepts structured benchmark plans and dispatches dataset-backed test runs against registered inference servers.
- Seven JSON schemas for benchmark documents: `model_profile`, `model_snapshot`, `runtime_profile`, `dataset_manifest`, `test_template`, `test_instantiation`, `test_run_result`, and `benchmark_plan`, with schema-version-based kind inference.
- `benchmark-schemas` service exposing `validateBenchmarkDocument`, `benchmarkKindFromDocument`, and `benchmarkSchemaPath` for typed document validation.
- `benchmark-datasets` service for loading, validating, and caching dataset manifests, with support for embedded, compressed-blob, and manifest-only dataset formats.
- `benchmark-foundation` service for creating, storing, and reloading structured benchmark results against the SQLite schema.
- `benchmark-runner` service orchestrating full benchmark plan execution: instantiation, dataset injection, per-model inference dispatch, and result persistence.
- `INFERHARNESS_BENCHMARK_DATASET_ROOT` environment variable for server-side benchmark dataset file resolution.
- `INFERHARNESS_INFERENCE_TLS_INSECURE` environment variable (default `false`) to disable TLS certificate verification for outbound inference requests, equivalent to `curl --insecure`.
- `POST /inference-servers/probe` endpoint tests connection and lists models without writing to DB, used by the server creation drawer before saving.
- Per-server refresh icon button on server cards triggers `refreshInferenceServerDiscovery` for that server on demand.
- Refresh-all icon button in the servers section header re-probes all active servers in parallel.
- `probeServer()` now accepts `parseModels: false` for lightweight health checks that confirm reachability without parsing the model list.
- Capabilities filter (thinking / coding / instruct / MoE) on the Catalog model rail, with URL-backed `capabilities` query parameter.
- Parameter count upper-bound slider on the Catalog model rail, with URL-backed `maxParams` query parameter and inline label.
- Parameter count label pill displayed on model cards.
- GPU cores field added to the inference server create/edit drawer, collected through the extended server schema.

### Changed

- Server creation drawer now uses a test-first workflow: "Test connection" probes the endpoint and shows discovered models before any DB write; "Save to Catalog" then creates the record and runs discovery.
- Health checks (`GET /inference-servers/health`) pass `parseModels: false` to avoid redundant model parsing during periodic polling.
- Automatic TTL-based discovery refresh removed from Catalog — model lists are refreshed only on explicit user action (per-card icon, refresh-all, or server save).
- `CONNECTIVITY_POLL_INTERVAL_MS` renamed to `INFERHARNESS_HEALTH_POLL_INTERVAL` and now accepts seconds instead of milliseconds (default: 30).
- `probeServer()` extracted into a dedicated `inference-server-probe.ts` service, eliminating duplicated HTTP probe logic across `refreshDiscovery` and `checkInferenceServerHealth`.
- "Last probe" timestamp removed from server cards and the server detail rail.
- Capabilities and `maxParams` filters cleared on server deselect and rail clear.
- Server create/edit drawer now uses dropdown fields and a two-column layout.
- Mistral `/v1/models` discovery now keeps only canonical entries where `id == name`, dropping alias rows before DB persistence.
- Run-groups endpoints and data model removed; benchmark pipeline replaces the former grouped-run concept.

### Fixed

- Deleting an inference server no longer throws a FOREIGN KEY constraint error; child records (metric samples, test results, runs, evaluations, models) are now deleted in dependency order within a transaction.
- Contract and integration tests for benchmark schemas now reference committed fixture files instead of the gitignored `specs/` directory, fixing all 26 CI failures.
- Root-level `vitest` run no longer fails due to missing or misrouted test configuration.

## [0.4.1] - 2026-05-11

### Added

- Results dashboard now compares raw cold-start performance across servers and models with sample-backed summary rows and box plots for cold penalty, cold total, and hot total metrics.
- Results run detail drawers now support guarded hard deletion of completed runs, removing result documents, metric samples, queue skips, and run-group item links while preserving linked evaluations.
- Server discovery now upserts discovered models with persisted parser-derived metadata, including clean base names, quantized providers, parameter labels, active MoE labels, formats, quantization bits, and use-case tags.

### Changed

- Catalog and Models metadata filters/details now use persisted `/models` records as their source of truth instead of inferring provider, format, quantized provider, or use cases from raw model IDs.
- Catalog Servers now keeps `Filter`, `Archived`, and `+ Add server` in the section header, opens the filter rail only on demand, defaults to active servers, and starts server cards unselected with click-to-toggle detail rails.
- Catalog model inspection now uses the routed `/catalog/models/:id` handoff layout while preserving the Catalog header, Servers/Models sub-tabs, and inference context bar.

### Fixed

- Catalog server archive actions now keep the selected server available in the archived view so the detail rail immediately exposes the matching `Unarchive` action.

## [0.4.0] - 2026-05-10

### Added

- Backend run groups now persist grouped Run executions, instantiate selected templates per target, launch child runs concurrently, expose `/run-groups` create/read/cancel endpoints, and isolate per-target failures.
- Results now has a run-backed `/results-view/query` API and `/results-view/runs/:runId` detail API for the merged Dashboard/History experience, including filter metadata, scorecards, chart series, recent runs, dense history rows, and drawer data.
- Evaluation detail is now available at `GET /evaluations/:evaluationId` so leaderboard rows can open a detail drawer for the representative evaluation.
- Inference parameter presets are now persisted through `/inference-param-presets` CRUD endpoints and exposed in the shared frontend context bar.
- Evaluate now has a queue API backed by completed `test_results`, with source-linked scoring and skip persistence while preserving the existing five 1-5 leaderboard score fields.

### Changed

- CI, release, and local Node version guidance now target Node.js 25 while declaring the supported runtime range as `>=22.19 <26`, matching Undici 8 requirements without claiming Node 26 support before native SQLite dependencies allow it.
- `better-sqlite3` is now pinned to the latest verified 12.9 release line for the current Node runtime window.
- Frontend styling now loads the new design-system foundation tokens, vendored IBM Plex fonts, and shared component primitives for cards, buttons, inputs, health pills, metrics, and architecture-tree surfaces.
- The frontend shell now uses React Router with a 220px always-expanded five-item sidebar, URL-backed Catalog/Results sub-tabs, legacy route redirects, and sidebar health/count status instead of the former global metric-card header.
- Catalog now replaces the legacy Inference Servers and Models bodies with a merged Servers/Models funnel, URL-backed server/model filters, server health view, slide-over add/edit drawer, card grids, and a full-width model inspector layout.
- Run now uses a unified 1-8 model workflow with query-backed model chips, shared template/options controls, single-target detail rendering, multi-target comparison columns, and summary aggregation.
- Results now uses a single merged Dashboard/Leaderboard/History page with a shared 240px filter rail, URL-owned tab/filter/sort/pagination/detail state, export/share/reset actions, run detail drawers for Dashboard and History, and evaluation detail drawers for Leaderboard.
- Package 06 polish adds shared reg-lights, a persistent inference context bar on Run/Templates/Results/Evaluate, a two-pane Templates layout, and a manual Evaluate scoring queue.
- Run, Templates, Results, and Evaluate now share merged page headers with the inference context bar aligned directly below the page header.
- Results now uses a full-width staged funnel with relationship-aware Servers -> Models -> Tests/range filtering, a full-width empty dashboard state, and downstream pruning when upstream selections change.
- Results and Catalog Models funnels now share numbered stages, aligned Clear/Collapse controls, Catalog-style collapsible rail treatment, and persisted collapse state.
- Results Tests/range and Catalog Models filter rails now use scoped Clear actions that preserve upstream selections while clearing only the filters owned by that rail.
- Leaderboard remains backed by `evaluations` while accepting server, model, score range, sort, and group query parameters, including grouping by server and `inference_config.quantization_level`.
- Inference server authentication can now use stored raw bearer/custom-header tokens for backend probes and runs while preserving the existing `token_env` fallback.

### Fixed

- Backend Vitest runs now ignore production SQLite database defaults, use a dedicated `backend-test.sqlite` by default, and fail fast if a backend test tries to open the production DB.
- Backend proxy support now sends plain HTTP outbound requests to the configured proxy in absolute-form while retaining CONNECT tunneling for HTTPS targets, routes backend outbound fetches through the configured Undici dispatcher directly, and no longer lets process-level `NO_PROXY` bypass backend proxy routing unless `AITESTBENCH_INFERENCE_NO_PROXY` is set.
- Inference server API responses now mask stored raw auth tokens and expose only token presence metadata.

## [0.3.2] - 2026-05-05

### Added

- Backend inference-server calls can now be routed through an optional Undici proxy configured with `AITESTBENCH_INFERENCE_PROXY` and `AITESTBENCH_INFERENCE_NO_PROXY`, without exposing proxy settings to the frontend.

### Changed

- CI and release workflows now run on Node.js 22 to match current backend dependency requirements.

### Fixed

- Results dashboard performance graphs now link repeated runs from the same template/model into one series even when generated active test IDs differ.
- Results dashboard merged metric graphs now keep different models as separate lines instead of collapsing same-test metrics together.
- Results dashboard default date ranges now include the newest result even when its timestamp has seconds or milliseconds, preventing single-run dashboards from appearing empty.
- Settings **Empty database** now clears all application SQLite tables, including evaluation prompts and evaluations that feed the leaderboard.
- Leaderboard view now clears stale displayed rows immediately after the database is emptied from settings.
- Architecture inspection errors now show visible, non-empty diagnostics in the model detail page instead of leaving only a red button state.
- MLX architecture inspection now uses config-backed estimation directly, avoiding PyTorch-dependent `AutoModel` construction and allowing models such as `/inferencerlabs/Qwen3-Coder-30B-A3B-Instruct-MLX-6.5bit` to inspect successfully from `config.json`.
- Architecture inspector subprocess failures now include captured output or an explicit timeout diagnostic when the Python process exits or is killed without a structured error.
- Models page filters now infer provider, quantized provider, format, quantization bit-depth, and use-case metadata from discovered model IDs, and collapse provider-prefixed aliases so the model filter shows clean base model names only.

## [0.3.1] - 2026-05-02

### Changed

- Model format handling now accepts `GCUF` as a compatibility alias for canonical `GGUF`.
- Architecture inspection now supports local GGUF files, MLX models with local `config.json` directories, and local-server MLX IDs that point back to HF-style repos, including leading-slash IDs such as `/lmstudio-community/...-MLX-6bit`.
- Architecture inspection now uses a layered pipeline: exact Transformers construction first, then format-aware config/header fallback with explicit provenance and accuracy metadata.
- Config fallback now normalizes nested decoder configs, estimates dense decoder, multimodal projector, and MoE structures, respects tied embeddings, and returns a clear unsupported error when required dimensions are missing.
- GPTQ, AWQ, SafeTensors, MLX, and GGUF inspection targets now route through the appropriate exact, config-backed, or header-only strategy without downloading weight tensors.
- Architecture cache entries now include inspector metadata and invalidate stale zero-parameter root-only results.

## [0.3.0] - 2026-05-01

### Added

- **Model Architecture Inspector** — model detail pages can inspect supported open-weight models and render an expandable layer tree with parameter counts, shapes, layer-type badges, and summary breakdowns.
- Backend architecture inspection APIs for cache-backed `POST`, cache-only `GET`, cache deletion, and per-model `trust_remote_code` settings.
- Python-based architecture extraction for Hugging Face Transformers configs and local GGUF files without loading model weights.
- Architecture cache storage under `backend/data/model/`, with corrupt-cache recovery, partial-file cleanup, path traversal protection, and a two-inspection concurrency limit.
- Frontend architecture tree controls for expand/collapse, expand all/collapse all, virtualized rendering for large trees, and hover highlighting by layer type.
- Optional Hugging Face token support through `HF_TOKEN` or `HUGGINGFACE_HUB_TOKEN` for gated model inspection.

### Changed

- Models now support navigation to model detail pages from the Models view.
- Release and desktop deployment docs now include Python architecture-inspection dependencies.

### Fixed

- Tightened TypeScript typings around schema validation, redaction, run execution, and chart rendering so release checks compile cleanly with current dependencies.

## [0.2.0] - 2026-04-29

### Security

- Upgraded Vite from 7.3.1 to 8.0.10, resolving three high-severity vulnerabilities (path traversal in optimised deps `.map` handling, `server.fs.deny` bypass via query strings, arbitrary file read via dev-server WebSocket — GHSA-4w7w-66w2-5vf9, GHSA-v2wj-q39q-566r, GHSA-p9ff-h696-f583).
- Co-upgraded `@vitejs/plugin-react` to 6.0.1 and `vitest` to 4.1.5, both of which require Vite 8.

### Added

- **Evaluate page** — submit a prompt to any registered inference server and model, receive the answer with six auto-computed quantitative metrics (input tokens, output tokens, total tokens, latency, word count, estimated cost), rate the answer on five qualitative dimensions (accuracy, relevance, coherence, completeness, helpfulness) using 1–5 sliders, and save an immutable evaluation record.
- **Leaderboard page** — ranked view of all evaluated models by composite qualitative score (arithmetic mean of the five dimensions), showing per-dimension averages, aggregate token/latency/cost statistics, and evaluation count per model.
- **Leaderboard filters** — date-range (from/to) and tag-based (OR logic) filtering; active filters with no matches show a distinct filter-specific empty state; clearing filters restores the full unfiltered ranking.
- **Compare Mode** — run the same prompt against two to four models simultaneously in a side-by-side layout; each model is scored and saved as an independent evaluation record.
- `eval_prompts` and `evaluations` SQLite tables with append-only semantics and indexes for efficient leaderboard aggregation.
- `POST /eval-inference`, `POST /evaluations`, `GET /evaluations`, and `GET /leaderboard` API endpoints, all protected by the existing `x-api-token` middleware.

## [0.1.0] - 2026-03-20

### Added

- Inference server management from the dashboard, including create, edit, archive, and runtime/discovery refresh flows.
- Test template management for JSON and Python-backed templates.
- Run execution, result browsing, and the results dashboard with filters, graphs, and tables.
- Local SQLite persistence, profile support, and API endpoints for runs, results, models, suites, profiles, templates, and system settings.
- CI and GitHub release workflow definitions for validating and publishing tagged releases.

### Changed

- Standardized the default backend port on `8080` so the backend, frontend, Playwright config, and documentation align out of the box.
- Added production-oriented `build` and `start` scripts for the backend and frontend workspaces.
- Excluded the CLI from the `0.1.0` public release surface.
