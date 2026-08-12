# Context Engineering Contract

> GraphFlow is not “just another code graph.” It is a **Context Engineering**
> service: retrieve what the current decision needs, compress it under an
> explicit token budget, and expose expandable anchors so agents refill only
> when necessary.

Related: [Experience memory](experience-memory.md) · [Agent Plugins install](../README.md#agent-plugins-10) · MCP tool `graphflow_context`

## Positioning

| Approach | What it optimizes | Gap vs GraphFlow |
| --- | --- | --- |
| **Platform-built-in indexing** (IDE / agent vendor indexes) | Fast whole-repo search inside one product | Opaque budget; hard to share across agents; little cross-session learning |
| **RL / long-context fine-tuning** | Model behavior over time | Expensive, non-local, does not give a portable contract for *this* task’s context |
| **GraphFlow Context Engineering** | **Task-driven packaging** with measurable savings | Explicit `tokenBudget` + layered anchors + refill; local-first; works with any MCP host |

Use GraphFlow when you need **auditable compression**, **agent-portable MCP**, and **experience memory** — not when you only need a vendor’s built-in file search.

## Layers (L0 → L3)

```
Query
  │
  ▼
L0  Retrieval — keyword + optional vector (RRF) → candidate nodes
  │
  ▼
L1  Anchors — File / Symbol (high priority, expandable)
  │
  ▼
L2  Modules — aggregated overviews when budget allows
  │
  ▼
L3  Experience — Skill / Decision (episode) hints when always-on layers enabled
  │
  ▼
Package: summary[] + anchors[] + tokenBudget
```

**Refill:** after a preview, call `graphflow_context` again with `anchorId` to expand one L1 (or related) anchor instead of dumping whole files. Prefer refill when `budgetUsedPercent` is still low.

## Contract fields (`graphflow_context` preview)

Returned `tokenBudget` (and related) form the **context contract** between GraphFlow and the host agent:

| Field | Meaning |
| --- | --- |
| `maxContextTokens` | Configured packaging budget (from `graphPolicy.maxContextTokens`) |
| `estimatedRawTokens` | Estimated cost of reading relevant sources without compression |
| `compressedTokens` | Tokens in the packaged summary / anchors payload |
| `estimatedSavingsPercent` | `(raw − compressed) / raw × 100` (when raw > 0) |
| `budgetUsedPercent` | `compressed / maxContextTokens × 100` |
| `anchors` | Expandable handles: `{ id, type, layer: "L1" \| "L2" \| "L3" }` |

Also expect `summary: string[]` (compressed lines) and, for CJK low-match cases, optional `agentWorkItems` (e.g. `query-translate-en`).

### Agent obligations

1. Prefer the package over recursive repo scans.
2. Expand anchors by id when the summary is insufficient.
3. Report savings to humans when useful (`estimatedSavingsPercent`, raw vs compressed).
4. Pass `englishQuery` for Chinese/CJK queries (code symbols are usually English).

## MCP entry point

```typescript
// Preview
await graphflow_context({ query: "how does context slicing budget tokens?", rootDir });

// Refill one anchor
await graphflow_context({ anchorId: "symbol:src/graph/context-slicer.ts:…", rootDir });
```

CLI fallback:

```bash
graphflow --json context preview "how does context slicing budget tokens?"
```

## Install path (host agents)

**Primary:** [Agent Plugins 1.0](../README.md#agent-plugins-10) — `plugin.json` + `mcp.json` + `skills/graphflow/` so hosts discover MCP and the Skill together.

**Fallback:** `npx @roarpeng/graphflow install` for Rules / multi-agent wiring when the host does not load Agent Plugins.

See also [experience-memory.md](experience-memory.md) for how episodes and skills turn outcomes into organizational memory.
