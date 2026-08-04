# Team Shared Memory & Poisoning Protection

> Status: design narrative + in-progress gating implementation. GraphFlow 的团队共享记忆模型与安全边界说明。
> 相关文档：[ATP/IR 规范](atp-ir-spec-v1.md) · [竞品对比](comparison.md) · [ROADMAP](../ROADMAP.md)

## 1. The problem: memory islands in multi-agent teams

When several coding agents (Cursor, Claude Code, Cline, …) work on the same
repository, each keeps its own private context:

- **Repeated explanation** — the same architecture decisions, constraints and
  pitfalls are re-explained (or re-discovered by trial and error) in every
  new session, by every team member, on every agent.
- **Memory islands** — one agent's hard-won lesson ("this module's cache must
  be invalidated before reindex") never reaches another agent, because session
  memory is stored in vendor-specific, machine-local formats.
- **No quality gate** — even where memory *can* be shared (committed notes,
  rules files), nothing distinguishes a validated insight from a plausible
  guess or a deliberately injected instruction.

Shared memory is only worth having if it is **portable, structured, and
resistant to poisoning**.

## 2. The GraphFlow approach

GraphFlow treats team memory as three shareable layers, all local-first with
optional shared backends:

| Layer | Sharing mechanism | What travels |
| --- | --- | --- |
| **Graph** | `graphPolicy.transport: mcp-http` — shared Graphify backend (team-hosted), transparent fallback to local file storage | the code knowledge graph itself: files, modules, symbols, edges |
| **Skills** | `graphflow skill sync export / import` — a committable `.graphflow/skills/team-skills.json`, bidirectional MERGE semantics (per-skill-id union, newer `updatedAt` wins, ties keep local, local-only skills preserved) | distilled, scored project skills with provenance and golden queries |
| **Episodes** | outcome reporting (`graphflow_report_outcome`) + auto-capture hooks persist episodes; shared backend makes them visible team-wide | task → outcome → lessons → deviation records that feed recall |

The design intent: memory flows through git and an optional team endpoint the
way code does — reviewable, diffable, and attributable.

## 3. Security model: memory is code

Shared memory is an attack surface. A skill pack merged from a fork, a
dependency's committed `.graphflow/skills`, or a shared backend can carry
stale, wrong, or adversarial guidance straight into future agents' prompts.
GraphFlow applies the same discipline as code review — **memory is treated as
code, with provenance and gates**:

1. **Provenance marking.** Skills merged from external sources carry their
   origin (imported / synced / local) and timestamps; provenance is retained
   through the bidirectional MERGE.
2. **No direct trust.** Skills merged from external sources are treated as
   **unproven until validated locally** — an imported skill never enters the
   `proven` class directly, regardless of its score in the source repository.
3. **Four-class promotion gating.** The skill lifecycle
   (`proven` / `correctable` / `anti-pattern` / `noise`) gates promotion:
   externally sourced skills must accumulate local, outcome-backed evidence
   (pass/fail episodes scored by `report_outcome` and the auto-capture hooks)
   before promotion.
4. **Canary validation.** Evolved / composite skills are verified against
   real tasks (canary runs) before they are allowed to influence planning —
   validation by evidence, not by assertion.
5. **Anti-pattern isolation.** Skills classified `anti-pattern` are isolated
   (excluded from positive injection, retained for audit) rather than
   silently deleted, so a poisoned entry can be inspected and its blast
   radius traced.
6. **Golden queries round-trip.** `skill sync` ships retrieval golden queries
   alongside the pack (`.graphflow/team-golden.json`), so an import can be
   regression-checked against the team's retrieval baseline.

Threat posture in one sentence: GraphFlow assumes the *transport* of memory
may be untrusted, and places all trust decisions at the *promotion* boundary,
where local evidence is required.

## 4. Positioning vs other team-memory approaches

| Approach | Primary mechanism | What it optimizes |
| --- | --- | --- |
| **TeamBrain-style (git-native)** | memory as git artifacts with review/merge gates | reviewability and audit trail of recorded knowledge |
| **Tencent Cloud Agent Memory Hub-style** | centralized memory service | memory as a managed team asset across agents |
| **GraphFlow** | shared graph backend + skill sync + episode sharing, with promotion gating | **graph + skill evolution**: memory that is not only recorded but *retrieved under a token budget and improved by outcomes* |

The difference is not transport but substance: session-transcript memory
answers "what was said"; GraphFlow's memory answers "what works here",
because skills are scored against real task outcomes and the retrieval layer
is regression-gated. Transcript-style and hub-style systems can sit upstream
of GraphFlow — their records become episodes; GraphFlow's flywheel turns them
into validated skills.

## 5. Roadmap hooks

- **Team shared-memory security gating** (in progress): provenance marking,
  no-direct-proven for external skills, canary validation, anti-pattern
  isolation — tracked in [ROADMAP.md](../ROADMAP.md).
- **Code-domain retrieval evaluation** (planned): open the 132-query golden
  set and methodology as a community dataset, so shared-memory retrieval
  quality is measurable across tools.
- **Third-party benchmark reproduction** (in progress): commit-anchored
  results and public methodology ([benchmark-standards.md](benchmark-standards.md))
  so the security and quality claims above can be independently checked.
