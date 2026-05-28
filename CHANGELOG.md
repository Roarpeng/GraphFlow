# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-05-28

### Added

- Core orchestration pipeline with simple/complex routing and DAG execution.
- Validator retry loop with human review fallback state.
- Model tier routing and provider fallback path (OpenAI, Anthropic, 百炼, 豆包).
- Graph client factory with memory and Graphify MCP HTTP transports.
- Automatic graph sync after successful run.
- Near-lossless context packaging:
  - summary + anchor dual channel
  - L1/L2/L3 quotas
  - dynamic refill manager with de-dup anchors
- Workspace file indexer for File/Symbol graph nodes.
- CLI commands:
  - `run`
  - `context preview`
  - `graph index`
- Learning flywheel baseline:
  - feedback collector
  - sample builder
  - learning dataset exporter
  - canary gate
- VS Code extension scaffold integrated with GraphFlow runtime.
- Config template: `graphflow.config.example.json`.

### Changed

- README updated to match implemented features and runnable commands.
- Config schema expanded with graph and near-lossless controls.

### Verified

- `npm run lint`
- `npm run build`
- `npm test` (25 tests passing)
- CLI smoke checks for `graph index` and `context preview`
- VS Code extension build
