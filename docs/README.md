# InferHarness Documentation

This directory contains durable, repository-maintained documents that define
InferHarness behavior, architecture, and engineering contracts.

Documents here are sources of truth and MUST be updated when the corresponding
product contract changes. Temporary implementation plans, investigation notes,
and one-off proposals do not belong in this directory.

These documents are specification sources of truth, not application runtime
assets. Runtime code should consume implementation copies under the relevant
source tree and keep them synchronized with the documented specification.

## Specifications

- [Product Roadmap](ROADMAP.md): product intent, current capability baseline,
  milestone outcomes, feature-family sequencing, and deferred scope.
- [Architecture](ARCHITECTURE.md): current app runtime topology, frontend and
  backend module boundaries, persistence model, provider integration, and major
  feature areas.
- [Design System](design-system/README.md): current visual language, token layers,
  typography, color, spacing, component primitives, and frontend styling rules.
- [Database Schema](DATABASE_SCHEMA.md): current SQLite table groups,
  relationships, indexes, JSON columns, startup migrations, and change-control
  rules.
- [Metrics](METRICS.md): canonical definitions, formulas, applicability,
  provenance, aggregation, and comparison rules for all InferHarness metrics.
- [Schemas](schemas/README.md): canonical JSON Schema specifications for
  persisted records, runtime snapshots, evaluation payloads, benchmark
  documents, and architecture inspection output.
- [Test Pipeline](test-pipeline/README.md): benchmark execution model,
  schema-driven pipeline rules, local-first/security policy, persistence model,
  and supporting valid/invalid benchmark document examples.
