# ATP/IR — Agent Thinking Protocol Intermediate Representation
## Public Specification v1.2 (additive over v1.1 / v1.0)

> Status: **Stable** ｜ Protocol version: `atp-ir/1.2` (additive over `atp-ir/1.1` / `atp-ir/1.0`) ｜ Reference implementation: GraphFlow (`@roarpeng/graphflow`) v1.8+
>
> This document is the **versioned public contract** for the Agent Thinking
> Protocol IR and its agent-bridge submit/merge flow. Third-party tools may
> implement compatible producers (that emit ATP work items) or consumers
> (that answer and merge them). Changes to this document follow the
> compatibility rules in §7.
>
> v1.1 is additive over v1.0: goal anchors, the clarification gate, the
> alignment-check work item, deviation reporting, and goal versioning (§5.1).
>
> v1.2 is an additive increment over v1.1: memory/outcome auto-backfill and
> the protocolized memory API (§8) add OPTIONAL work items only. No
> required-ID changes; v1.0 / v1.1 implementations remain compatible.
> GraphFlow also accepts optional Engineering KG link fields on
> `report_outcome` (`requirementIds` / `conceptIds` / `codeHints`) to write
> episode → `derived_from` → Requirement/Concept/code edges.

---

## 1. Purpose

Modern coding agents reason ad-hoc: they jump from request to code. ATP
defines a **structured thinking pipeline** that any agent can execute, and an
**interchange representation (IR)** that lets a host tool (e.g. GraphFlow)
orchestrate that thinking across agent boundaries — including when the host
has **no LLM of its own** and must delegate reasoning to the connected agent.

Design goals:

- **Intent first** — understand purpose before planning.
- **Facts before opinions** — evidence before judgment.
- **Root cause over symptoms** — Five Whys before fixes.
- **Options before decisions** — Decision Matrix before commitment.
- **Plan before execution** — an explicit DAG before work.
- **Reflection-driven improvement** — scored self-assessment closes the loop.

## 2. Protocol roles

| Role | Meaning |
| --- | --- |
| **Producer** | Emits a set of `AgentWorkItem`s for a task (GraphFlow `graphflow_plan` / `graphflow_run` / `graphflow_insight`). |
| **Agent** | Answers work items with its own model; submits answers back. |
| **Consumer** | Validates completeness, merges answers into insight + final DAG plan (GraphFlow `graphflow_insight submit/merge`). |

A single deployment may be both producer and consumer (GraphFlow), with an
external coding agent (Cursor, Claude Code, …) as the answering agent.

**Non-GraphFlow reference producer:** [`examples/atp-minimal-producer/`](../examples/atp-minimal-producer/) emits a valid simple-plan work-item set (intent + decomposition) as JSON with no network — useful for third-party Producer implementations that target this IR.

## 3. Core data types

### 3.1 `AgentWorkItem`

```jsonc
{
  "id": "intent-analysis",          // stable machine ID (§4)
  "kind": "intent",                 // enum, see below
  "hat": "White Hat",               // optional; only for kind=six-hats/five-whys
  "prompt": "Task: ...",            // instruction for the answering agent
  "expectedFormat": "json",         // currently always "json"
  "responseSchema": { "…": "…" },   // expected JSON shape (informal, human-readable values)
  "optional": true                  // optional; absent/false = REQUIRED
}
```

`kind` enum:

| kind | meaning |
| --- | --- |
| `intent` | Intent Analysis (stage 1) |
| `requirement` | Requirement Analysis (stage 2) |
| `six-hats` | One Six-Thinking-Hats perspective (stages 4) |
| `five-whys` | Root-cause追问 for one hat (stage 5) |
| `first-principles` | First Principles decomposition (stage 6) |
| `decision-matrix` | Multi-option scoring (stage 7) |
| `plan-refinement` | Final DAG plan production (stages 8–9) |
| `reflection` | Plan quality self-assessment (stage 10) |
| `query-translate` | CJK→English query translation helper (non-ATP utility) |
| `document-semantic` | Optional post-index extraction of document key entities/claims (non-ATP utility); submit upserts `Concept`/`Requirement` + cross-layer edges |

### 3.2 `TaskNode` (DAG plan item)

```jsonc
{
  "id": "task-1",
  "description": "implement the tokenizer cache",
  "dependencies": ["task-0"],        // ids of prerequisite nodes
  // OPTIONAL enrichment (producers SHOULD emit, consumers MAY ignore):
  "priority": 1,                      // 1 = highest
  "complexity": "Low | Medium | High",
  "verification": ["unit tests pass"],
  "inputs": ["existing tokenizer"],
  "outputs": ["cache module"],
  "risks": ["memory growth"],
  "assignedAgent": "backend"          // frontend|backend|testing|docs|general
}
```

### 3.3 Insight payloads (submitted answers)

- **IntentAnalysis**: `{ explicitIntent, implicitIntent, coreProblem, nonGoals[], successDefinition, complexity? }`
- **RequirementAnalysis**: `{ functional[], nonFunctional[], constraints[], priority, scope:{included[], excluded[]} }`
- **Hat answer** (`six-hats`): `{ observation, criticalInsight, supportingEvidence?, risks?, opportunities?, recommendations[]? }`
- **Five-Whys answer**: `{ whys: [{ question, answer }], rootCause }`
- **FirstPrinciplesAnalysis**: `{ assumptions[], facts[], deconstructedTo[], challenges[] }`
- **DecisionMatrixResult**: `{ options: [{ name, description, scores:{complexity,cost,risk,maintainability,impact}, pros[], cons[] }], recommendedOption, rationale }` (scores 1–10; complexity/cost/risk lower-better, maintainability/impact higher-better)
- **Plan** (`plan-refinement`): JSON array of `TaskNode` (max 8 nodes)
- **PlanReflection**: `{ confidence (0..1), uncertainties[], missingInformation[], improvementDirections[] }`

## 4. Work-item ID registry

### 4.1 Full ATP set (complex tasks)

| ID | kind | required |
| --- | --- | --- |
| `intent-analysis` | intent | ✅ |
| `requirement-analysis` | requirement | ✅ |
| `hat-1-white` … `hat-6-blue` | six-hats | ✅ (6 items) |
| `why-1-white` … `why-6-blue` | five-whys | ✅ (6 items) |
| `first-principles` | first-principles | ✅ |
| `decision-matrix` | decision-matrix | ✅ |
| `plan-refinement` | plan-refinement | ✅ |
| `plan-reflection` | reflection | optional |
| `task-risk-mitigation` | — | optional |

### 4.2 Simple-plan bridge set (lightweight planning without host LLM)

| ID | kind | required |
| --- | --- | --- |
| `simple-plan-intent` | intent | ✅ |
| `simple-plan-decomposition` | plan-refinement | ✅ |
| `alignment-check` | alignment | optional (post-execution) |

The two sets MUST NOT be mixed in one merge: presence of any
`simple-plan-*` ID selects the simple-plan merge contract.

### 4.3 Protocol-level items (any set)

| ID | kind | required |
| --- | --- | --- |
| `clarification` | clarification | conditional — required when intent confidence < 0.6 |
| `alignment-check` | alignment | optional, post-execution |
| `memory-recall` | memory | optional — **v1.2 increment** (see §8) |
| `memory-backfill` | memory | optional — **v1.2 increment** (see §8) |

## 5. Submit / merge protocol

```
producer:  plan(task) ──► { agentWorkItems, agentInstructions, status:"awaiting-agent" }
agent:     for each REQUIRED item → answer with own model
agent:     insight submit  { task, workItemId, response (JSON string), episodeId? }
agent:     insight merge   { task }
consumer:  merge ──► { complete, submittedCount, missing[], insight, plan,
                       needsClarification?, intentConfidence? }
```

1. **Submit** is idempotent per `(task, workItemId)`: re-submitting replaces
   the previous answer. `response` MUST be a JSON string parseable into the
   §3.3 payload for that item kind; unparseable payloads are stored raw and
   count as submitted but degrade merge quality.
2. **Merge** computes the required-ID set (§4), reports `complete=true` only
   when every required ID has a submission AND the clarification gate (§5.1)
   is satisfied, and derives:
   - `insight` — a SixHatsInsight-shaped synthesis (sparse for the
     simple-plan bridge: `refinedTaskStatement` from `coreProblem`).
   - `plan` — the final `TaskNode[]`; from `plan-refinement` /
     `simple-plan-decomposition` when parseable, else the producer's
     heuristic suggestion.
3. **Outcome reporting** is a separate concern: after execution, agents call
   `report_outcome(episodeId, success, lessons[], deviation?, requirementIds?,
   conceptIds?, codeHints?)` so the learning flywheel can score skills and
   update the episode (`pending → pass|fail`). Optional Engineering KG ids /
   code hints write episode → `derived_from` → Requirement/Concept/code edges
   (same experience↔eng provenance as document-semantic insight ingest).

### 5.1 Goal anchors, clarification gate, and alignment checks (atp-ir/1.1)

**Goal anchor.** Submitting `intent-analysis`, `simple-plan-intent`, or
`clarification` with a payload containing `coreProblem` and/or
`successDefinition` upserts a first-class **goal node**
(`id = goal:<hash(task)>`, metadata `kind:"goal"`). The anchor — coreProblem,
successDefinition, nonGoals — is injected into every packaged prompt context
for that task so executing agents stay aligned with the ORIGINAL requirement.
Submit results echo `goal: { goalId, version, versioned, changedFields,
staleEpisodes, confidence? }`.

**Clarification gate (P3).** Intent payloads carry `confidence` (0.0–1.0).
When the effective confidence (the `clarification` submission wins over the
original intent) is below **0.6**, merge reports `complete=false` with
`needsClarification=true` and `intentConfidence`, even if every required ID
was submitted. The agent MUST answer a `clarification` work item and resubmit
with confidence ≥ 0.6 before the plan finalizes. Payloads without a
`confidence` field are treated as fully confident (legacy compatible).

**Alignment check (P2).** After executing a subtask or the whole plan, the
agent SHOULD submit `alignment-check`:

```json
{
  "aligned": true,
  "servedSuccessCriteria": ["..."],
  "violatedNonGoals": [],
  "drift": "none | misread-requirement | scope-creep | tech-drift",
  "correction": ""
}
```

It is recorded as a decision node and NEVER blocks merge.

**Deviation reporting (P1).** `report_outcome` accepts
`deviation ∈ {none, misread-requirement, scope-creep, tech-drift}` classifying
WHY the work deviated from the goal anchor; it is persisted on the episode
record and aggregated in the flywheel report (`skill report` / diagnose).

**Goal versioning (P4).** Goal nodes are versioned. Re-submitting an intent
whose five-tuple materially differs snapshots the old record to
`goal:<hash>:v<n>` (status `superseded`) and advances the active node to
`v<n+1>` with a `changedFields` diff; still-pending episodes for the task are
flagged `staleGoal`. Identical re-submissions only refresh the timestamp.

## 6. Transport bindings

| Binding | Submit | Merge |
| --- | --- | --- |
| MCP | `graphflow_insight {mode:"submit", task, workItemId, response}` | `graphflow_insight {mode:"merge", task}` |
| CLI | `graphflow insight submit --task <t> --work-item <id> --response <json>` | `graphflow insight merge --task <t>` |

Both bindings share identical semantics; this document is the source of truth.

## 7. Compatibility rules

- **Versioning**: the protocol is versioned as `atp-ir/<major>.<minor>`.
  Implementations SHOULD state the version they target.
- **Additive minor changes** (new optional work items, new optional TaskNode
  fields, new kinds) are backward compatible: consumers MUST ignore unknown
  optional items/fields.
- **Breaking changes** (removing/renaming required IDs, changing required
  payload shapes) require a major version bump and a new spec document.
- **Required-ID stability**: within a major version, the required ID sets in
  §4 are frozen. Producers may add optional items freely.
- **Graceful degradation**: consumers MUST treat missing optional items as
  absent (not an error) and MUST tolerate unparseable responses by falling
  back to heuristic plans.

## 8. v1.2 increment — memory/outcome auto-backfill & protocolized memory API

> **增量标注**: this section is the `atp-ir/1.2` additive increment over
> v1.0/v1.1. It adds two OPTIONAL protocol-level work items (§4.3) and
> protocolizes the memory behaviours the reference implementation already
> performs. Consumers targeting v1.0/v1.1 are unaffected: per §7, unknown
> optional items MUST be ignored, and all new behaviours degrade to no-ops
> when a producer/agent does not emit them.

### 8.1 Memory/outcome auto-backfill (`memory-backfill`)

**Protocol.** After execution, `report_outcome(episodeId, success, lessons[],
deviation?, requirementIds?, conceptIds?, codeHints?)` (see §5) **automatically
backfills memory** — the host persists the episode record (task, outcome,
lessons, deviation), applies skill-score updates, and refreshes the goal
anchor's episode linkage without requiring an explicit insight submission.
Optional Engineering KG fields also upsert `derived_from` edges from the
episode to Requirement / Concept / code nodes. This closes the learning
flywheel on the outcome path itself.

**Registry.** `memory-backfill` is an OPTIONAL protocol-level work item (kind
`memory`): producers MAY emit it as a machine-readable marker describing what
was backfilled, and agents MUST NOT treat it as required or answerable.

```jsonc
{
  "id": "memory-backfill",
  "kind": "memory",
  "prompt": "Outcome memory backfill marker (host-managed, no agent answer required)",
  "expectedFormat": "json",
  "responseSchema": { "backfilled": "boolean", "episodeId": "string", "fields": ["outcome|lessons|deviation|skillScores"] },
  "optional": true
}
```

**Semantics.** When present, the host SHOULD echo the backfill result (which
fields were written, which were skipped) in the submit result of
`report_outcome`. Absent/ignored `memory-backfill` = legacy v1.0/v1.1
behaviour (memory still backfilled host-side; no marker in the registry).

### 8.2 Protocolized memory API (`memory-recall`)

**Protocol.** Memory becomes a first-class protocol concern: **recall** —
similar past episodes (task similarity, lessons, outcomes) are injected into
every packaged prompt context for a task; **store** — the auto-backfill in
§8.1 is the store path. No separate handshake is required; recall is a
passive injection and store is an automatic side effect of outcome reporting.

**Registry.** `memory-recall` is an OPTIONAL protocol-level work item (kind
`memory`): producers MAY emit it to declare the recall injection for a task
(what memory was retrieved and why), so the consumer can audit what the agent
saw.

```jsonc
{
  "id": "memory-recall",
  "kind": "memory",
  "prompt": "Episodic-memory recall injection (host-managed, no agent answer required)",
  "expectedFormat": "json",
  "responseSchema": { "recalled": "number", "topEpisodes": [{ "id": "string", "outcome": "string", "lessonsCount": "number" }] },
  "optional": true
}
```

**Semantics.** Recall degrades gracefully: when the store is empty or the
embedding provider is unavailable, the recall set is empty (Jaccard-only
fallback) and `recalled: 0` — never an error.

### 8.3 Transport bindings (v1.2)

| Concern | Binding (existing, unchanged) | Notes |
| --- | --- | --- |
| Recall injection | `graphflow_context` (preview packages similar episodic memories into context) | v1.2: recall declaration MAY surface as a `memory-recall` item |
| Store / backfill | `graphflow_report_outcome` (auto-backfills episode + skill scores; optional `requirementIds` / `conceptIds` / `codeHints`) | v1.2: MAY surface as a `memory-backfill` item |
| CLI | `graphflow outcome report <episodeId> <success> [--lessons ...] [--requirement-id ...] [--concept-id ...] [--code-hint ...]` | same semantics as MCP binding |

A dedicated `graphflow_memory` binding is **reserved for a future minor
version**; the tool surface is frozen in GraphFlow v1.9.5, so v1.2 exposes
memory exclusively through the existing bindings above.

### 8.4 Compatibility summary

- **Additive-only**: two new OPTIONAL items, one new kind (`memory`); no
  required-ID changes, no payload-shape changes to v1.0/v1.1 items.
- **Backward compatible**: v1.0/v1.1 producers and consumers work unchanged;
  v1.2 producers must still emit all v1.0/v1.1 required items.
- **Graceful degradation**: recall/backfill no-ops when unsupported or empty
  (§7 applies).

---

*Reference implementation points: work-item construction
(`src/core/agent-delegation.ts`), submit/merge (`src/core/submit-agent-insight.ts`,
`src/core/merge-agent-insight.ts`), goal anchors (`src/core/goal-anchor.ts`),
IR types (`src/agents/atp-schema.ts`), episodic memory
(`src/learning/episodic-memory.ts`: `recordEpisode`, `updateEpisodeOutcome`,
`findSimilarEpisodes`, `summarizeEpisodeForPrompt`).*

---

## 9. Related Work / References

The following lines of work inform the ATP/IR design and GraphFlow's memory
flywheel. Descriptions are intentionally brief and limited to the relationship
to this specification; refer to each work's primary source for details.

- **SkillRL** (arXiv 2026, CoRR) — hierarchical skill-library distillation
  with recursive evolution. Structurally isomorphic to GraphFlow's three skill
  tiers (atomic → composite → evolved) and the canary-gated evolution path in
  the reference implementation; SkillRL's recursion corresponds to the
  flywheel's nightly re-distillation loop.
- **Agent Workflow Memory** (arXiv:2409.07429) — induces reusable workflows
  from agent trajectories. Related to the episodic → skill distillation path:
  ATP/IR's `memory-backfill` (§8.1) is the store side and `memory-recall`
  (§8.2) the retrieval side of an analogous trajectory-to-memory loop.
- **MemGPT / Letta** — OS-style memory paging for agents. The L0–L3 layered
  context packaging plays a similar role at the context level: only a working
  set is kept in prompt budget, the rest lives in addressable external store.
- **HippoRAG** — hierarchical graph-based retrieval. GraphFlow's retrieval
  stack (graph anchors + PageRank compression + vector recall with RRF) is a
  code-domain instance of the same graph-structured retrieval idea.
- **Microsoft GraphRAG, "From Local to Global"** — graph plus community
  summary retrieval over document corpora. Evaluation of graph-based
  retrieval in the **code domain** remains largely an open gap; GraphFlow's
  132-query golden set (`benchmarks/retrieval-golden-data.ts`, in CI) is an
  attempt to contribute a reproducible measurement toward filling it.
- **Bounded-memory contract** (2026-07 research trend in agentic long-horizon
  systems) — inject only the typed information the current decision needs,
  rather than unbounded history. This is the same design principle behind
  L0–L3 layered compression and the explicit `maxContextTokens` budget: both
  treat memory injection as a bounded, typed, auditable operation — which is
  precisely what `memory-recall` (§8.2) makes declarable in the protocol.
