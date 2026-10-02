# GraphFlow Substrate Compatibility Contract

Status: **frozen v1** (spec §27 action #1, §1 boundary, §21 MCP).
Substrate: `@roarpeng/graphflow` **2.0.x** (verified against 2.0.3).
Consumer: `@roarpeng/graphflow-efficiency-agent` 0.1.x (`packages/efficiency-agent`).
Enforcement: `packages/efficiency-agent/tests/graphflow-compat.test.ts` (runs in the
release gate's `code` step via `vitest run packages/efficiency-agent/tests/`) and
`tests/mcp-tool-annotations.test.ts` (root suite).

## 1. Boundary rule

The efficiency agent consumes GraphFlow **only** through:

1. the GraphFlow MCP server over stdio (a child process, one short-lived server per call), and
2. a small set of **public files** under the workspace's `graphflow-out/` directory.

Its runtime code (`src/`, `bin/`) imports **no** module from the root `src/` tree and never
reimplements a GraphFlow algorithm (context compression, ranking, indexing, planning).
Only the compat test imports root modules — on purpose, so a substrate change that breaks a
consumed surface fails CI in the same commit.

## 2. Consumed surfaces

Stability levels:

- **frozen** — field names, types and semantics are fixed for the whole 2.x major. Only additive changes (new optional fields) are allowed.
- **additive** — like frozen, but the surface itself is newer. New optional fields may appear in any minor release; consumers must ignore unknown fields.
- **experimental** — the agent uses it best-effort and degrades cleanly if it disappears. It may change in a minor release with a CHANGELOG note.

| # | Surface | Direction | Stability | Since |
|---|---------|-----------|-----------|-------|
| S1 | MCP server process, transport and identity | agent → substrate | frozen | 2.0.0 |
| S2 | `graphflow_context` request + response | agent ↔ substrate | frozen | 2.0.0 |
| S3 | `graphflow_run` → `advisory` (Execution Contract v1 subset) | substrate → agent | frozen | 2.0.0 |
| S4 | Decision ledger `graphflow-out/decision-ledger.jsonl` | substrate → agent | additive | 2.0.0 |
| S5 | Learned policy `graphflow-out/efficiency-policy.json` | agent → substrate | additive | 2.0.0 |
| S6 | Graph artifact metadata (`graphflow-out/graphflow-graph.json` / `graph-store.json`) | substrate → agent | experimental | 2.0.0 |
| S7 | MCP tool `annotations` + `_meta["graphflow/*"]` governance tags | substrate → agent and hosts | additive | 2.0.3 |
| S8 | Tool inventory (10 tool names) and bridge-mode arguments | substrate → agent and hosts | frozen | 2.0.0 |

### S1 — MCP server process, transport, identity

Code: `src/host/graphflow-mcp-client.ts` (`resolveGraphFlowServer`, `fetchGraphFlowContext`).

- **Server resolution order** (the first match wins):
  1. `eff-agent … --graphflow-mcp "<cmd> <args…>"`
  2. env `EFF_GRAPHFLOW_MCP="<cmd> <args…>"` (quoted tokens supported), or
     `EFF_GRAPHFLOW_MCP=http://127.0.0.1:<port>/mcp` for a resident `graphflow-mcp --http --port <port>`
     (Streamable HTTP, nothing is spawned). Non-loopback URLs need `EFF_GRAPHFLOW_MCP_TOKEN`
     (sent as `Authorization: Bearer`); without it every fetch fails open with the refusal reason.
  3. `~/.graphflow/runtime/mcp-launcher.cjs`, launched with the current `node` (`process.execPath`)
  4. none: GraphFlow is unreachable, so the pipeline fails open to a twin-only context. `--no-graphflow` forces this case.
- **Spawn contract**: stdio transport, `cwd = rootDir`, child stderr ignored, full parent env plus:
  - `GRAPHFLOW_MCP_STDIO=1` — the server keeps stdout for JSON-RPC only.
  - `GRAPHFLOW_WORKSPACE_ROOT=<rootDir>` — binds the server to the project.
- **Client identity**: `{ name: "eff-agent", version: "0.1.0" }`.
- **Server identity (frozen)**: `serverInfo.name === "graphflow"` and `serverInfo.version` equal
  to the installed `@roarpeng/graphflow` `package.json` version (`src/surfaces/mcp/version.ts`,
  never a hard-coded string). The same identity is returned by `initialize` and by the draft
  `server/discover`. This is asserted by `tests/mcp-tool-annotations.test.ts`.
- **Timeout**: 120 s per call (default); timeout, spawn failure or `isError` → fail-open.

### S2 — `graphflow_context`

Request (the only arguments the agent sends):

```json
{ "name": "graphflow_context", "arguments": { "query": "<task>", "rootDir": "<abs root>", "recordDialogue": false } }
```

`recordDialogue: false` is required: the agent's probes must not write dialogue turns into
the user's graph. The schema must keep `query` (string), `rootDir` (string) and
`recordDialogue` (boolean) optional-compatible. Any new **required** argument is a breaking
change. `englishQuery` (string) is pinned as well because hosts use it for CJK tasks.

Response — the agent parses the JSON in the first `content[]` item with `type: "text"`:

| Field | Type | Use |
|-------|------|-----|
| `summary` | `string[]` (required) | first 24 strings → prompt context (fenced as untrusted data) |
| `anchors` | `Array<{ id: string; type?: string; relevance?: number }>` (required) | anchor ids → `anchorFiles`, which feed fingerprint `relevantFiles` |
| `anchors[].id` grammar | `file:<path>` / `symbol:<path>:<hex≥6>` / `module:<path>` | path extraction (`anchorFilesFromIds`); extensionless module paths get `.ts` appended |
| `tokenBudget.compressedTokens` | `number?` | trace context-token figure (provenance `estimated`: the substrate's own estimate) |
| `tokenBudget.estimatedRawTokens` | `number?` | raw-token estimate for savings reporting (`estimated`) |
| `dialogueHits` | `unknown[]?` | only `.length` is used |

Missing `summary` or `anchors`, unparseable JSON, or `isError: true` → `{ ok: false }` and the
pipeline fails open to project-twin context (spec §9). All other response fields are ignored.

Known constraint: the agent reads the **text** copy. GraphFlow's default `mcp.textCopy` is
`"full"`. If a workspace config sets `mcp.textCopy: "auto"`, responses over 4 KiB carry a stub
text copy (full data only in `structuredContent`), and the agent fails open. Reading
`structuredContent` first is the planned client fix; until it lands, keep `textCopy` at `"full"`.

### S3 — `graphflow_run` advisory (Execution Contract v1 subset)

Producer: `src/core/efficiency-advisory.ts` (`buildEfficiencyAdvisory`, deterministic Layer A)
plus `src/core/meta-advisory.ts` (optional Layer B), wired in
`src/surfaces/cli/runtime/routing.ts`. It is emitted as the top-level `advisory` field of the
`graphflow_run` result, next to `executionDescriptor` (not inside it), on the normal path and
on the no-LLM bridge fallback path.

Consumer check: `assertAdvisoryCompatible()` in `src/contract.ts`. Fields relied on (all frozen):

| Field | Constraint |
|-------|-----------|
| `schemaVersion` | `"1.0"` |
| `taskId` | non-empty string (`task:<sha256(normalized task)[0..16]>`) |
| `mode` | `"shadow"` (substrate) — the contract also allows `conservative` / `adaptive` |
| `reuseMode` | `REUSE` / `ADAPT` / `FRESH` (Layer A never emits `REUSE`) |
| `confidence` | number in 0..1 |
| `signals.taskComplexity` | `simple` / `complex` |
| `context.source` / `context.requiredAnchors` | `"graphflow"` / `string[]` (inlined `[anchor <id>]` ids) |
| `worker.modelTier` | `economy` / `standard` / `heavy` |
| `worker.executionMode` / `worker.maxRounds` | `one-shot` / `loop`; maxRounds ≥ 1 |
| `validation` | `string[]` of executable commands (prose is filtered out) |
| `project` (optional) | non-empty `root` when present |
| `experience` (optional) | `episodes: string[]` when present |
| `tools` (optional) | `{ name, capability }[]` |
| `policyApplied` (optional) | `{ version: number }` when an `efficiency-policy.json` override applied |
| `decision.provenance` / `llmCalls` / `durationMs` | `deterministic` ⇒ `llmCalls === 0`; `llm` when Layer B (TypeSafe Jev) participated |

Tolerated additive fields: `signals.topEpisodeSimilarity`, `experience.topSimilarity`,
`context.maxTokens`, `context.cached`, `decision.metaReflection`. Contract evolution rules
are in [ADR-0002](adr/0002-contract-additive-extension.md).

Note: the package pipeline builds its own `ExecutionContractV1` (with the additive fields
`decisionId`, `budget`, `permissions`, …) and validates it with the same
`assertAdvisoryCompatible`, so the substrate advisory and the agent contract cannot drift apart.

### S4 — Decision ledger (`graphflow-out/decision-ledger.jsonl`)

Producer: `src/learning/decision-ledger.ts` (`appendDecisionLedgerRecord`). One JSON object
per line is appended on every `graphflow_run` advisory. The ledger is disabled with
`GRAPHFLOW_DECISION_LEDGER=0`. Consumer: `eff-agent policy learn <ledger>`
(`src/learning/policy-from-ledger.ts`).

Fields relied on: `kind === "decision"` (other kinds are skipped), `taskId: string`,
`taskCategory?: string` (triage `simple`/`complex`), `reuseMode?`, `modelTier?`, `llmCalls?`,
`durationMs?`. Torn or blank lines are skipped and never fatal. New record kinds and new
optional fields are additive.

### S5 — Learned policy (`graphflow-out/efficiency-policy.json`)

Writer: `eff-agent policy learn` (package `PolicyUpdate` JSON). Reader: `loadEfficiencyPolicy()`
in `src/learning/decision-ledger.ts`, applied by `graphflow_run`, which stamps
`advisory.policyApplied`.

| Field | Reader requirement |
|-------|--------------------|
| `version` | number (**required**, else the file is ignored) |
| `modelTierByCategory` | object (**required**), keys = triage category, values `economy`/`standard`/`heavy` |
| `executionModeByCategory` | object, values `one-shot`/`loop` (default `{}`) |
| `minSamples` / `avoidPatterns` / `rationale` | optional (defaults 5 / `[]` / `[]`) |

The substrate reads the file structurally, never through a package import. A malformed file
reads as "no policy". The pipeline's own per-category policy (`graphflow-out/eff-agent/policy.json`,
keyed by the agent's task categories) is private to the agent; the substrate never reads it.

### S6 — Graph artifact metadata

`graphArtifactVersion()` in `src/host/project-facts.ts` stats
`graphflow-out/graphflow-graph.json` and then `graphflow-out/graph-store.json`, and returns
`<basename>:<size>:<round(mtimeMs)>` as the fingerprint's context-track `graphVersion`. **File
contents are never read.** If neither file exists, `graphVersion` is undefined and the
fingerprint is still computed. Experimental: if GraphFlow renames or moves the artifact, the
context track gets less precise, but correctness is unaffected (the project track still binds
git state and file hashes).

### S7 — MCP tool annotations and governance tags (spec §21)

Every tool in `src/surfaces/mcp/tool-definitions.ts` declares MCP `annotations` (`title`,
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and a top-level `title`,
plus GraphFlow-namespaced `_meta`. The `_meta` vocabulary is the efficiency agent's own:
risk ids from `policies/risk-classes-v1.json`, capability ids from `policies/capabilities-v1.json`.
The compat test enforces both vocabularies.

`_meta` keys: `graphflow/risk` (risk under the default configuration: no LLM key, no team
server), `graphflow/capabilities`, `graphflow/writeScope` (`none` / `graphflow-state` /
`caller-path`), and, when a configured provider can widen the reach,
`graphflow/conditionalCapabilities` + `graphflow/conditionalRisk`.

| Tool | readOnly | destructive | idempotent | openWorld | risk | capabilities | writeScope | conditional |
|------|:-:|:-:|:-:|:-:|:-:|---|---|---|
| `graphflow_context` | ✗ | ✗ | ✗ | ✗ | R1 | fs.read, fs.write | graphflow-state | — |
| `graphflow_plan` | ✗ | ✗ | ✗ | ✓ | R1 | fs.read, fs.write | graphflow-state | network.connect → R2 |
| `graphflow_run` | ✗ | ✗ | ✗ | ✓ | R1 | fs.read, fs.write, process.exec | graphflow-state | network.connect → R2 |
| `graphflow_report_outcome` | ✗ | ✗ | ✗ | ✗ | R1 | fs.read, fs.write | graphflow-state | — |
| `graphflow_insight` | ✗ | ✗ | ✗ | ✗ | R1 | fs.read, fs.write | graphflow-state | — |
| `graphflow_index` | ✗ | ✗ | ✓ | ✗ | R1 | fs.read, fs.write | graphflow-state | — |
| `graphflow_artifact` | ✗ | ✓ | ✓ | ✗ | R1 | fs.read, fs.write | caller-path | — |
| `graphflow_skill_insights` | ✓ | ✗ | ✓ | ✗ | R0 | fs.read | none | — |
| `graphflow_diagnose` | ✓ | ✗ | ✓ | ✗ | R0 | fs.read | none | network.connect → R2 |
| `graphflow_skill_guide` | ✓ | ✗ | ✓ | ✗ | R0 | — | none | — |

Rationale for the non-obvious cells:

- `graphflow_context` is **not** read-only: by default it records a dialogue turn or workbench message, and `content`/`assistantReply` archive data. With `recordDialogue: false` it still may write caches. That is why the agent passes `recordDialogue: false`.
- `graphflow_run`: always runs `git rev-parse HEAD` (`process.exec`) and appends episodes, feedback and the decision ledger. With an LLM provider or `TYPESAFE_API_KEY` configured, it calls those external APIs, hence `openWorldHint: true` and the conditional R2.
- `graphflow_plan`: seeds a workbench, and calls the configured LLM when a key exists. Without a key it bridges to the agent.
- `graphflow_index`: rewrites derived graph artifacts only. `mode: "full"` clears and rebuilds but preserves the memory subgraph, so it is idempotent and non-destructive to user code or memory.
- `graphflow_artifact`: `import` upserts nodes and edges over existing ids (overwrites graph state), and `export` writes to a caller-named path. Hence `destructiveHint: true` and `writeScope: caller-path`. Hosts should escalate when `outputPath` leaves the workspace.
- `graphflow_diagnose`: read-only, but with team mode configured it probes the team graph server.
- Team-mode remote graph stores (a deployment choice) can make every graph-touching tool reach the network. The table describes the default local store.

Hints are hints: MCP clients must not treat them as enforcement. The agent's security
gate (`src/security/*`) remains the enforcement point for actions the agent itself launches.

### S8 — Tool inventory and bridge-mode arguments

The 10 tool names (`graphflow_context`, `graphflow_plan`, `graphflow_run`,
`graphflow_report_outcome`, `graphflow_insight`, `graphflow_index`, `graphflow_artifact`,
`graphflow_skill_insights`, `graphflow_skill_guide`, `graphflow_diagnose`) are frozen. The
compat test also pins `graphflow_run.required = ["task"]` and
`graphflow_report_outcome.required = ["episodeId", "success"]` (plus `lessons: array`), which
benchmarks and external hosts drive in bridge mode.

## 3. What the agent deliberately does NOT use (spec §1, §12 "consume via MCP, never internals")

- **The graph store**: neither the SQLite backend (`*.sqlite`, `better-sqlite3`) nor the JSON graph store contents. Only file metadata (S6) is read.
- **Internal TypeScript modules** of `@roarpeng/graphflow` (`src/core/*`, `src/graph/*`, `src/learning/*`, `src/routing/*` …) at runtime. Only the compat test imports them.
- **Embeddings or vector search**: no embedding model, no ONNX runtime, no similarity over GraphFlow vectors. The agent's own experience search is Jaccard over its own history (`src/agent/experience.ts`).
- **GraphFlow ranking, compression, indexing or planning algorithms**: never copied. Context comes from `graphflow_context`, and the plan from the agent's own harness.
- **GraphFlow's episodic memory and skill store** (`graphflow_skill_insights`, episodes): not read at runtime. The agent keeps its own experience store under `graphflow-out/eff-agent/`.
- **Dialogue/workbench writes**: always suppressed with `recordDialogue: false`.
- **GraphFlow LLM/TypeSafe provider configuration**: model calls belong to the worker CLI, not to the substrate.

## 4. Version policy

1. Compatibility is keyed on the **semver of `@roarpeng/graphflow`**. This contract covers `>=2.0.0 <3.0.0`.
2. **Frozen** surfaces change only additively within a major: new optional request arguments and new optional response fields. Renaming, retyping, removing, making an argument required, or changing semantics is breaking.
3. **Removal or breaking change** requires (a) a deprecation notice in CHANGELOG and in the affected tool description for at least **one minor release**, then (b) a **major** version bump. This document and the compat test are updated in the same commit.
4. **Additive** surfaces may gain optional fields in any minor release. Consumers ignore unknown fields.
5. **Experimental** surfaces may change in a minor release with a CHANGELOG note. The agent must keep a clean fail-open path for them.
6. **Enforcement**: `tests/graphflow-compat.test.ts` (package) and `tests/mcp-tool-annotations.test.ts` (root). The `efficiency-agent.yml` workflow triggers on changes to `src/surfaces/mcp/**` and `src/core/efficiency-advisory.ts`, so a substrate-only PR still runs the gate. A failing compat test blocks the release.
7. On extraction to a separate repository ([ADR-0001](adr/0001-monorepo-package.md)), the compat test switches its relative root imports to the published `@roarpeng/graphflow` package, pinned to the range above.
