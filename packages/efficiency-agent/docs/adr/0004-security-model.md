# ADR-0004: Security model — capability-based permissions, risk classes R0–R5, explicit limits

- Status: Accepted
- Date: 2026-10-01
- Spec: §6 (security), §7 (capabilities), §8 (risk), §9 (fail-open/closed), §12 (privacy)

## Context

The agent launches processes (validation commands, the worker CLI), writes caches and history,
and puts GraphFlow output and past experience into model prompts. The worker itself is usually an
external agent CLI (Claude Code, Codex, …) with its own tool loop that eff-agent cannot see
inside. The security story must say exactly what eff-agent enforces and what it cannot.

## Decision

**Model**: actions are described by capabilities (`policies/capabilities-v1.json`:
`filesystem.read/write`, `process.exec`, `network.connect`, `git.write`, `package.install`,
`secret.read`, `agent.spawn`) and classified into risk classes (`policies/risk-classes-v1.json`):

| Class | Meaning | Default action |
|-------|---------|----------------|
| R0 | read-only | allow |
| R1 | bounded local | allow-bounded |
| R2 | external side effect | approval |
| R3 | secret / escape | deny |
| R4 | destructive | confirm |
| R5 | agent spawn | allow-bounded |

Implementation: `src/security/{capabilities,risk,policy,redact,untrusted}.ts`, behind the
pipeline seam `src/agent/security-adapter.ts` / `security-default.ts`. GraphFlow MCP tools
declare the same vocabulary in `_meta["graphflow/risk" | "graphflow/capabilities"]`.

**Enforced by eff-agent:**

- **Commands eff-agent launches** (validation commands, local-command worker, the worker CLI launch line): classified by `classifyCommand` and gated by `evaluateAction` / `evaluateWorkerLaunch`.
- **Post-run workspace write audit**: `git status --porcelain` snapshots before and after the worker run (`auditWorkspaceWrites`). The delta is evaluated as writes; eff-agent's own state (`graphflow-out/**`, `.graphflow-cache/**`) is excluded.
- **Protected paths** and workspace containment for writes (`checkWritePath`, `matchProtectedPath`). Protected paths are additive across policy files.
- **Read-only tasks** (query/docs-style categories): write-capable commands are refused before launch, and any write found by the post-run audit is denied and recorded.
- **Network off by default** for launched commands (`EFF_NETWORK_DEFAULT=0` → `network.connect` requires approval).
- **Secret redaction** (`redact.ts`) in traces, experience history, lessons and cached outputs. Redaction is idempotent and leaves git SHAs and UUIDs intact.
- **Untrusted-data fencing**: GraphFlow context, past experience and validation output enter prompts only inside nonce-delimited `UNTRUSTED DATA` fences (`wrapUntrusted`). Forged delimiters are stripped, and prompt-injection heuristics flag output.
- **Cache admission**: only validated, evidenced, injection-free, secret-free results are cacheable (`cacheAdmission`), which guards against cache poisoning.
- **Fail-closed policy loading**: a missing policy uses the bundled default; a corrupt or invalid policy file switches to `STRICT_SECURITY_POLICY` (anything beyond bounded local work is denied) and the reason is recorded.

**Not enforced (explicit limits):**

- **The external agent CLI's internal tool use.** Once launched, the worker CLI runs its own tools (shell, edits, network) under its own permission model. eff-agent inspects only the launch command line and audits workspace writes **after** the run. It cannot block a network call or a write outside git's view (ignored files, paths outside the repository) in real time. Operators must run the CLI in its own sandbox or permission mode (for example a read-only or approval mode, a container, or a CI runner without credentials).
- MCP tool annotations are hints; GraphFlow's own handlers are not sandboxed by eff-agent.
- Heuristic injection detection flags content but cannot prove its absence.

## Consequences

- Positive: every security decision is recorded in the trace (`TraceSecurityDecision`: verdict, risk, reasons) and is replayable.
- Positive: a broken policy file can never widen permissions.
- Negative: real containment of the worker depends on the host or CLI sandbox. The docs and the CLI help must keep saying so, and benchmark reports must state the worker's sandbox mode.
