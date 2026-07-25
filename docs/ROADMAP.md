# InferHarness Product Roadmap

Status: Active product roadmap

Last updated: 2026-07-25

## 1. Purpose

This roadmap defines the product outcomes and feature families that should guide
InferHarness development. It separates completion of existing capabilities from
future product expansion so short-term improvements contribute to a coherent
direction.

This document is intentionally not an implementation specification. It does not
define APIs, database tables, JSON Schema changes, component designs, or release
dates. Those decisions belong in focused implementation plans created when a
roadmap milestone is selected for delivery.

## 2. Product Intent

InferHarness helps an individual AI engineer or application developer identify
the best model and inference-server combination for a specific benchmark
template.

Within a template, the best candidate is the model/server combination that
correctly completes the largest proportion of expected tasks. Performance, cost,
and resource metrics explain tradeoffs or break ties unless the template makes
them part of successful task completion.

The primary workflow is model/server selection. Replaying an established
comparison to detect regressions is a valuable secondary use of the same
evidence.

## 3. Product Boundaries

The roadmap preserves these boundaries:

- InferHarness remains local-first and provider-neutral.
- One engineer controls one local InferHarness instance.
- The local control plane may test local servers, remote servers, and public
  provider APIs.
- Comparisons remain scoped to a specific template.
- Candidate rankings require comparable evidence.
- Quantitative and qualitative evaluation remain supported.
- Benchmark documents and results remain reproducible and auditable.
- Implementation details remain subordinate to the versioned product contracts
  under `docs/`.

Hosted operation, multi-user collaboration, and distributed execution are not
part of the five core milestones.

## 4. Current Baseline

InferHarness already provides:

- an inference-server and model catalog;
- benchmark template browsing and authoring;
- local dataset authoring;
- execution of one template against several model/server targets;
- sequential benchmark orchestration;
- provider normalization for chat and tool-use workflows;
- persisted benchmark runs and Results views;
- manual evaluation and leaderboard foundations.

The following areas exist but are incomplete relative to the durable
specifications:

- canonical metrics and aggregation;
- runtime parameter handling across providers;
- comparison eligibility;
- failure, cancellation, and partial-result persistence;
- benchmark-native qualitative evaluation;
- strict schema enforcement;
- long-running execution and orchestration.

## 5. Milestone 1: Trustworthy Selection Core

### Outcome

Existing benchmark capabilities produce trustworthy, comparable, and auditable
model/server selection evidence.

### Feature families

- Complete canonical metric observations and aggregation.
- Correct task-success, sample-coverage, and end-to-end pass reporting.
- Consistent runtime parameter handling across providers.
- Comparison eligibility checks and explicit incomparable states.
- Reliable failure, cancellation, and partial-result persistence.
- Stronger conformance between schemas and runtime behavior.
- Benchmark-native qualitative evaluation.
- Per-template model/server ranking.

### Completion signal

An engineer can trust that the winning candidate completed the most expected
tasks under comparable conditions, and can understand why any candidate or
sample was excluded.

## 6. Milestone 2: Complete Selection Experience

### Outcome

The primary selection workflow is coherent from benchmark preparation through
an auditable recommendation.

### Feature families

- Guided candidate comparison.
- Capability and comparability preflight.
- Saved and repeatable comparisons.
- Multi-template, multi-target benchmark campaigns.
- Independent ranking for each template in a campaign.
- Clear performance tradeoff and exclusion explanations.
- Auditable comparison reports.
- A cohesive Templates, Datasets, Run, Results, and Evaluate journey.

### Completion signal

An engineer can prepare a comparison, run it, identify the best model/server
combination for each selected template, save the evidence, and repeat the same
comparison later.

## 7. Milestone 3: Durable Execution at Scale

### Outcome

InferHarness can execute long-running and high-volume benchmarks without
depending on one open browser request.

### Feature families

- Background execution.
- Job queue and progress tracking.
- User cancellation and controlled restart or resume.
- Incremental result persistence.
- Large-dataset execution.
- Controlled local concurrency.
- Capacity and load testing.
- Host and accelerator telemetry.

Sequential execution remains the default for ordinary functional comparisons.
Concurrency is introduced through explicit benchmark modes where contention is
controlled or intentionally measured.

### Completion signal

An engineer can start, monitor, interrupt, recover, and audit a long-running
benchmark without losing completed work or compromising comparison integrity.

## 8. Milestone 4: Task Coverage Expansion

### Outcome

InferHarness can select model/server combinations for a broader range of AI
tasks.

### Feature families

- Additional text-generation operations.
- Embedding evaluation.
- Richer multi-turn and agentic tasks.
- Multimodal tasks.
- Protocol and inference-server health tests.
- Larger and alternative dataset storage modes.
- Additional providers required by supported task families.

New operation families should be delivered as complete product slices. Schema
vocabulary alone does not constitute product support.

### Completion signal

Each advertised task family can be authored, executed, evaluated, compared, and
understood through the normal InferHarness workflow.

## 9. Milestone 5: Automation and Portability

### Outcome

Completed selection workflows can be reproduced outside the interactive UI and
moved safely between environments.

### Feature families

- Headless and command-line execution.
- CI integration.
- Machine-readable results and exit semantics.
- Import and export of benchmark bundles.
- Reproducible execution commands.
- Human-readable result exports.
- Cross-machine schema compatibility.

Automation must reuse the same execution and comparison behavior as the
interactive application rather than creating a parallel runner.

### Completion signal

An engineer can move a benchmark definition to another machine, reproduce the
comparison, automate it, and interpret the resulting evidence without a hosted
InferHarness account.

## 10. Future Capabilities

The following feature families are deferred until the five core milestones are
stable:

- managed probes for measurement locality;
- distributed load generation;
- remote execution workers;
- distributed scheduling;
- multi-user collaboration;
- hosted InferHarness operation;
- shared external artifact storage.

Managed probes may later execute benchmark work near an inference server to
reduce controller-to-target network effects and generate controlled concurrent
load. They remain compatible with one local control plane, but they introduce a
distributed execution boundary and should therefore follow a stable local
engine and orchestration model.

## 11. Definition of Done

Operational quality is part of every milestone rather than a final cleanup
phase. A roadmap capability is complete only when:

- its documented contract and runtime behavior agree;
- existing local data remains usable or has a documented migration;
- valid and invalid cases are tested;
- provider differences are explicit and covered where relevant;
- UI, API, and persisted evidence agree;
- user-facing and durable documentation are current;
- failures remain actionable and auditable;
- the capability is not advertised while only partially implemented;
- the repository release checks pass.

## 12. Roadmap Governance

Milestones express dependency order, not fixed release numbers or dates.
Development within a milestone should prioritize closing coherent product gaps
over adding isolated options.

When a new idea appears:

1. Determine whether it completes an existing milestone outcome.
2. Place it in the earliest milestone whose outcome requires it.
3. Defer implementation design until that milestone is actively planned.
4. Avoid moving future capabilities forward unless product evidence changes the
   roadmap boundary.

Update this roadmap when product intent, milestone order, feature families, or
scope boundaries change materially.
