# ADR-0001: Keep the Efficiency Agent as an independent workspace package in this repository

- Status: Accepted
- Date: 2026-10-01
- Spec: §1 (boundary), §19 (CI gates), §25 (layout), Sprint 0

## Context

The Efficiency Agent is a decision layer on top of the GraphFlow substrate. The spec requires
a hard boundary: the agent consumes GraphFlow through MCP/API and never copies its algorithms.
We could put the agent in a separate repository to make that boundary physical, or keep it
next to the substrate.

Most early changes touch both sides at once: the substrate's `graphflow_run` advisory is the
embryo of the Execution Contract, the decision ledger and `efficiency-policy.json` form a
closed loop across the boundary, and MCP tool annotations are consumed by the agent's risk
model. In two repositories, each such change would need a cross-repo release dance before a
contract break could be detected.

## Decision

Keep the agent in this repository as the independent npm workspace package
`packages/efficiency-agent` (`@roarpeng/graphflow-efficiency-agent`, `private: true` for now).

- **Independently buildable**: its own `package.json`, `tsconfig.json` (`rootDir: src`, stricter flags than root) and `npm run build`.
- **Independently testable**: its own `vitest.config.ts` without the root test setup, and its own `tests/`.
- **Independently gated**: its own CI workflow `.github/workflows/efficiency-agent.yml` with the release gate (`scripts/release-gate.mjs`) and the supply-chain job (`scripts/supply-chain.mjs`).
- **Boundary**: runtime code (`src/`, `bin/`) imports nothing from the root `src/`. GraphFlow is reached only through the MCP server over stdio and public `graphflow-out/` files (see `docs/GRAPHFLOW_COMPATIBILITY.md`). The single exception is `tests/graphflow-compat.test.ts`, which imports root modules on purpose to detect substrate breaks in the same commit.
- **Extraction path**: `git subtree split --prefix packages/efficiency-agent -b eff-agent-split` produces a standalone history. After extraction, the compat test switches from relative root imports to the published `@roarpeng/graphflow` package, pinned to the frozen range.

## Consequences

- Positive: a substrate change that breaks a consumed surface fails CI in the same PR. The workflow triggers on `src/surfaces/mcp/**` and `src/core/efficiency-advisory.ts` as well as the package.
- Positive: one lockfile and one install. The package reuses the root `node_modules` (`@modelcontextprotocol/sdk`, vitest, TypeScript).
- Negative: the boundary is enforced by convention and review plus the "no root imports in `src/`" rule, not by repository walls. A future lint rule (no `../../../src` in package `src/`) would make it mechanical.
- Negative: package release tags (`eff-agent-v*`) share the repository with GraphFlow releases, so the tag prefixes must stay distinct.
