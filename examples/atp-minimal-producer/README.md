# ATP minimal producer (third-party compatible)

Reference **Producer** for [ATP/IR v1](../../docs/atp-ir-spec-v1.md) (`atp-ir/1.2`): emit `AgentWorkItem`s that a compatible **Consumer** (GraphFlow or another host) can submit/merge.

This example does **not** depend on GraphFlow MCP at runtime. It only builds a valid simple-plan work-item set and prints JSON.

## Roles (spec §2)

| Role | This example |
| --- | --- |
| **Producer** | `producer.ts` — emits `simple-plan-intent` + `simple-plan-decomposition` (+ optional `alignment-check`, `memory-recall`, `memory-backfill`) |
| **Agent** | Your coding agent answers each **required** item as JSON (ignore host-managed `memory-*`) |
| **Consumer** | GraphFlow `graphflow_insight` submit/merge, or any host that implements the same IR |

## Protocol versions

| Version | What this producer emits |
| --- | --- |
| **atp-ir/1.1** required | `simple-plan-intent`, `simple-plan-decomposition` |
| **atp-ir/1.1** optional | `alignment-check` |
| **atp-ir/1.2** optional (§8) | `memory-recall`, `memory-backfill` (host-managed markers; no agent answer) |

v1.1 consumers **MUST ignore** unknown optional items (§7). Emitting v1.2 markers does not break older consumers.

## Run

```bash
npx tsx examples/atp-minimal-producer/producer.ts
npx tsx examples/atp-minimal-producer/producer.ts "Refactor the context slicer"
```

Stdout is a JSON object with `protocol: "atp-ir/1.2"` and `agentWorkItems` (stable machine IDs, `expectedFormat: "json"`).

Sample fixture: [`fixture.work-items.json`](./fixture.work-items.json).

## Hand off to GraphFlow (optional)

1. Produce work items (this script).
2. For each **required** item, answer with your model, then:

   ```text
   graphflow_insight({ mode: "submit", task, workItemId, response })
   ```

3. Merge:

   ```text
   graphflow_insight({ mode: "merge", task })
   ```

4. After execution: `graphflow_report_outcome` with `episodeId` / success / lessons, and optionally `requirementIds` / `conceptIds` / `codeHints` to write episode → `derived_from` → Engineering KG edges.

Pure builders live in `src/agents/atp-example-producer.ts` so tests and this CLI share one shape.
