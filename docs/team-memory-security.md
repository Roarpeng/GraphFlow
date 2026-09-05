# Team Shared Memory & Poisoning Protection

> Status: **shipped MVP** (v1.15.0). GraphFlow 的团队共享记忆模型、RBAC 与安全边界。
> 相关文档：[ATP/IR 规范](atp-ir-spec-v1.md) · [竞品对比](comparison.md) · [ROADMAP](../ROADMAP.md)
> 客户端示例：[examples/team-memory/graphflow.config.example.json](../examples/team-memory/graphflow.config.example.json)

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
| **Graph** | `graphPolicy.transport: mcp-http` — `graphflow team serve` (Graphify JSON-RPC) with tenant isolation + RBAC; transparent fallback to local file storage on transport failure (not on 401/403) | the code knowledge graph itself: files, modules, symbols, Skill/Episode nodes, edges |
| **Skills** | `graphflow skill sync export / import` — a committable `.graphflow/skills/team-skills.json`, bidirectional MERGE semantics (per-skill-id union, newer `updatedAt` wins, ties keep local, local-only skills preserved). Optional `skill sync push / pull` against the team server. | distilled, scored project skills with provenance and golden queries |
| **Episodes** | outcome reporting (`graphflow_report_outcome`) + auto-capture hooks persist episodes as graph nodes; the team server makes those nodes visible team-wide when clients write through mcp-http | task → outcome → lessons → deviation records that feed recall |

The design intent: memory flows through git and an optional team endpoint the
way code does — reviewable, diffable, and attributable.

**Local-first default is unchanged.** Loopback / file / sqlite solo use needs
no token. Auth + RBAC turn on for shared HTTP (and are required by default
when `graphflow team serve` binds a non-loopback address).

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
7. **HTTP RBAC (MVP).** Shared HTTP surfaces map JWT `role` / `scope` or a
   bearer role map to `viewer` | `contributor` | `admin` and fail closed:
   unresolved role is a deny. Viewers read; contributors write graph / skill
   sync / artifact import; admins delete and mutate governance.

Threat posture in one sentence: GraphFlow assumes the *transport* of memory
may be untrusted, and places all trust decisions at the *promotion* boundary,
where local evidence is required — plus least-privilege on the wire.

## 4. Positioning vs other team-memory approaches

| Approach | Primary mechanism | What it optimizes |
| --- | --- | --- |
| **TeamBrain-style (git-native)** | memory as git artifacts with review/merge gates | reviewability and audit trail of recorded knowledge |
| **Tencent Cloud Agent Memory Hub-style** | centralized memory service | memory as a managed team asset across agents |
| **GraphFlow** | shared graph backend + skill sync + episode sharing, with promotion gating and HTTP RBAC | **graph + skill evolution**: memory that is not only recorded but *retrieved under a token budget and improved by outcomes* |

The difference is not transport but substance: session-transcript memory
answers "what was said"; GraphFlow's memory answers "what works here",
because skills are scored against real task outcomes and the retrieval layer
is regression-gated. Transcript-style and hub-style systems can sit upstream
of GraphFlow — their records become episodes; GraphFlow's flywheel turns them
into validated skills.

## 5. Ops runbook (shipped MVP)

### 5.1 Stand up a team memory server

Loopback (dev, auth optional — local-first):

```bash
npx graphflow team serve --host 127.0.0.1 --port 8787 --store .graphflow/team-store
```

Shared bind (auth + RBAC required):

```bash
export GRAPHFLOW_TEAM_JWT_SECRET='replace-with-a-long-random-secret'
npx graphflow team serve \
  --host 0.0.0.0 --port 8787 \
  --allow-host team.example.com:8787 \
  --store /var/lib/graphflow/team-store \
  --http-jwt-secret "$GRAPHFLOW_TEAM_JWT_SECRET" \
  --http-token admin:${ADMIN_BEARER} \
  --http-token contributor:${WRITE_BEARER} \
  --http-token viewer:${READ_BEARER} \
  --allow-tenant acme --allow-tenant default
```

`--http-token` accepts `role:token` (or `token:role`). Non-loopback binds
refuse to start without credentials and a role map or JWT secret.

Equivalent MCP tool surface (agents talking to GraphFlow tools over HTTP):

```bash
npx graphflow mcp serve --http --host 127.0.0.1 --port 8790 \
  --http-token contributor:${WRITE_BEARER} --rbac
```

### 5.2 Issue a token

HS256 JWT with `role` + `memory:*` scopes (enough for the MVP; no IdP UI):

```bash
npx graphflow team issue-token \
  --subject ada@acme \
  --role contributor \
  --secret "$GRAPHFLOW_TEAM_JWT_SECRET" \
  --ttl 86400 \
  --json
```

Roles:

| Role | Graph / diagnose | Skill sync push | Artifact import | Delete / governance |
| --- | --- | --- | --- | --- |
| `viewer` | read | pull only | deny | deny |
| `contributor` | read + upsert | push + pull | allow | deny |
| `admin` | all | all | allow | allow |

JWT mapping: claim `role`, or scopes `memory:read` / `memory:write` /
`memory:admin` (strongest wins). Missing role + RBAC on = 403 fail closed.

Clients send `Authorization: Bearer <token>` and optional
`X-GraphFlow-Tenant: acme`.

### 5.3 Join as a client

`graphflow.config.json` (see also `examples/team-memory/graphflow.config.example.json`):

```json
{
  "graphPolicy": {
    "transport": "mcp-http",
    "mcpEndpoint": "http://127.0.0.1:8787/mcp",
    "mcpApiKey": "${GRAPHFLOW_TEAM_TOKEN}",
    "mcpTenant": "acme",
    "graphStorePath": "graphflow-out/graphflow-graph.json"
  }
}
```

Then:

```bash
export GRAPHFLOW_TEAM_TOKEN='<jwt or role-tagged bearer>'
npx graphflow diagnose --json
npx graphflow doctor --json
```

`diagnose` / `graphflow_diagnose` expose `team`: transport, endpoint, tenant,
authMode, rbacExpected, reachable, degradedToLocal, role.

A 401/403 does **not** silently write to the local fallback (that would hide
denials). Unreachable servers still degrade to the local file store.

### 5.4 Skill sync + shared graph

```bash
# git-reviewable pack (unchanged MERGE / canary / provenance)
npx graphflow skill sync export
npx graphflow skill sync import

# same pack over the team server (contributor+)
npx graphflow skill sync push
npx graphflow skill sync pull
```

Graph + Skill + Episode nodes also round-trip through `graph.upsert_*` /
`graph.read_snapshot` when the client uses `transport: mcp-http`.

## 6. Honest limits / follow-ups

Shipped in this MVP: team server, JWT/bearer RBAC, tenant isolation, diagnose
+ doctor, skill pack push/pull, graph snapshot RPC.

**Not in this slice** (tracked as enterprise wishlist):

- Hosted OIDC IdP / SSO UI (RS256 public-key JWT already verifies if you
  bring your own issuer)
- Approver-only workflow UI (governance review RPC exists for `admin`)
- Multi-region HA / managed SaaS control plane
- Full snapshot compatibility with third-party Graphify servers that do not
  implement `graph.read_snapshot` / `team.health` (client still degrades)

## 7. Roadmap hooks

- **Team shared-memory security gating** (shipped): provenance marking,
  no-direct-proven for external skills, canary validation, anti-pattern
  isolation — tracked in [ROADMAP.md](../ROADMAP.md).
- **Enterprise RBAC / remote collaboration** (shipped MVP): see §5.
- **Code-domain retrieval evaluation** (planned): open the 132-query golden
  set and methodology as a community dataset, so shared-memory retrieval
  quality is measurable across tools.
- **Third-party benchmark reproduction** (in progress): commit-anchored
  results and public methodology ([benchmark-standards.md](benchmark-standards.md))
  so the security and quality claims above can be independently checked.
