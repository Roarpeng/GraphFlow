# ADR-0003: Feature flags, precedence and the one-switch rollback

- Status: Accepted
- Date: 2026-10-01
- Spec: §22 (feature flags), §23 (modes), §24 (rollback)

## Context

Every efficiency behaviour (reuse, routing, learning, harness, sub-agents, network) must be
switchable without a redeploy. A single switch must also return the system to the native
worker path. Benchmarks must compare arms under controlled flags, regardless of what the
operator has configured locally.

## Decision

Flags live in `src/flags.ts`. Defaults follow spec §22:

| Flag | Default | Flag | Default |
|------|:-:|------|:-:|
| `EFF_AGENT_ENABLED` | 0 | `EFF_MODEL_ROUTING` | 1 |
| `EFF_SHADOW_MODE` | 1 | `EFF_SUBAGENT` | 0 |
| `EFF_CONTEXT_REUSE` | 1 | `EFF_SELF_LEARNING` | 0 |
| `EFF_PLAN_REUSE` | 0 | `EFF_DYNAMIC_HARNESS` | 0 |
| `EFF_RESULT_REUSE` | 0 | `EFF_EXTERNAL_WRITE_APPROVAL` | 1 |
| `EFF_TOOL_ROUTING` | 1 | `EFF_NETWORK_DEFAULT` | 0 |

- **Precedence**: built-in defaults < flags file `graphflow-out/eff-agent/flags.json` (written by `eff-agent flags set` via `writeFlagsFile`) < environment variables. Accepted values are `1/0`, `true/false`, `on/off`, `yes/no`. An unparseable value keeps the lower-precedence value and produces a warning instead of failing the run.
- **Effective mode** = the requested mode capped by the flags (`effectiveMode`). With `EFF_AGENT_ENABLED=0` **or** `EFF_SHADOW_MODE=1`, `conservative`/`adaptive` degrade to **shadow**: decisions are computed and recorded, and the worker runs unchanged. This is the one-switch rollback to the native worker path. `advisory` and `baseline` are never capped.
- **Security flags** (`EFF_EXTERNAL_WRITE_APPROVAL`, `EFF_NETWORK_DEFAULT`, `EFF_SUBAGENT`) are applied to the security policy by `applySecurityEnvFlags`. An unparseable value keeps the **safer** setting.
- **Benchmark arms force their own flags** (`benchArmFlags`) inside isolated per-task worktrees, because each arm is an experiment and must not inherit operator overrides: baseline turns context reuse and routing off; graphflow turns routing off; shadow uses the defaults; conservative enables the agent plus plan reuse; adaptive additionally enables result reuse and the dynamic harness.

## Consequences

- Positive: rollback is a single environment variable (`EFF_AGENT_ENABLED=0`), with no data migration. Cache rollback (namespace generation bump) and policy rollback (policy lifecycle) are separate, finer switches.
- Positive: out of the box, the agent cannot change worker behaviour (`EFF_AGENT_ENABLED=0`, `EFF_SHADOW_MODE=1`). Turning it on is an explicit operator act.
- Negative: two flags gate the same thing (enabled vs. shadow). This is kept on purpose: `ENABLED` is the kill switch, and `SHADOW` is the staged-rollout knob.
- Negative: benchmark results describe the arm's forced flags, not the operator's configuration. Reports must name the arm.
