# ATP/IR — Agent Thinking Protocol Intermediate Representation
## Public Specification v1.0

> Status: **Stable** ｜ Protocol version: `atp-ir/1.0` ｜ Reference implementation: GraphFlow (`@roarpeng/graphflow`) v1.7+
>
> This document is the **versioned public contract** for the Agent Thinking
> Protocol IR and its agent-bridge submit/merge flow. Third-party tools may
> implement compatible producers (that emit ATP work items) or consumers
> (that answer and merge them). Changes to this document follow the
> compatibility rules in §7.

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

The two sets MUST NOT be mixed in one merge: presence of any
`simple-plan-*` ID selects the simple-plan merge contract.

## 5. Submit / merge protocol

```
producer:  plan(task) ──► { agentWorkItems, agentInstructions, status:"awaiting-agent" }
agent:     for each REQUIRED item → answer with own model
agent:     insight submit  { task, workItemId, response (JSON string), episodeId? }
agent:     insight merge   { task }
consumer:  merge ──► { complete, submittedCount, missing[], insight, plan }
```

1. **Submit** is idempotent per `(task, workItemId)`: re-submitting replaces
   the previous answer. `response` MUST be a JSON string parseable into the
   §3.3 payload for that item kind; unparseable payloads are stored raw and
   count as submitted but degrade merge quality.
2. **Merge** computes the required-ID set (§4), reports `complete=true` only
   when every required ID has a submission, and derives:
   - `insight` — a SixHatsInsight-shaped synthesis (sparse for the
     simple-plan bridge: `refinedTaskStatement` from `coreProblem`).
   - `plan` — the final `TaskNode[]`; from `plan-refinement` /
     `simple-plan-decomposition` when parseable, else the producer's
     heuristic suggestion.
3. **Outcome reporting** is a separate concern: after execution, agents call
   `report_outcome(episodeId, success, lessons[])` so the learning flywheel
   can score skills and update the episode (`pending → pass|fail`).

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

---

*Reference implementation points: work-item construction
(`src/core/agent-delegation.ts`), submit/merge (`src/core/submit-agent-insight.ts`,
`src/core/merge-agent-insight.ts`), IR types (`src/agents/atp-schema.ts`).*
