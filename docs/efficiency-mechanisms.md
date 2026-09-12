# Efficiency mechanisms (SoL-Pi borrow)

> Status: P0/P1/P2 of the SoL-Pi adoption are implemented. Every mechanism is
> ON by default (`efficiencyPolicy` is the "best config"); switch any of them
> off from the **GraphFlow: Settings** page or by setting its section to `false`.
> Explicit calls (`graphflow_context` with `content`/`handle`, `reduce: true`)
> are never gated.

Source: NVIDIA [SoL-Pi](https://nvlabs.github.io/SoL-Pi/) — `efficiency for efficiency`.
SoL-Pi searches harness mechanisms under a *capability floor*: a token saving
counts as efficiency only when task quality stays within a predeclared
tolerance. GraphFlow reproduces the boundary it can own: an MCP memory/context
service that never takes over tool execution, shell, or the host's compaction API.

## 1. Configuration (best config: all ON by default)

```json
{
  "efficiencyPolicy": {
    "observations": {
      "enabled": true,
      "inlineThresholdBytes": 8192,
      "headBytes": 2048,
      "tailBytes": 1536,
      "ttlDays": 14,
      "redactOnStore": true,
      "reduce": { "enabled": true, "strategy": "fingerprint", "maxReceiptTokens": 400 }
    },
    "contextPressure": {
      "enabled": true,
      "maxContextTokens": "auto",
      "cacheWriteReadRatio": 12.5,
      "minSavingRatio": 0.2
    },
    "actionFusion": { "enabled": true }
  }
}
```

Explicit calls are explicit intent and are **not** gated: `graphflow_context`
with `content`/`handle`, `reduce: true`, or a returned `executionDescriptor`.
The flags govern automatic/config-driven behaviour only.

## 2. The four mechanisms

| Mechanism | GraphFlow surface | Notes |
| --- | --- | --- |
| ObservationPack | `graphflow_context` `content`/`handle`/`page`/`range` | content-addressed store under `.graphflow/observations/`; head/tail excerpt + exact paged recall of the **stored** bytes. `redactOnStore` (default `true`) redacts secret-like spans before storage, so recall is byte-exact modulo that declared transform; set it `false` to prove raw losslessness |
| Evidence-Preserving Reducer | `graphflow_context` `reduce: true` | every retained line is re-verified verbatim against the archive; `strategy: "llm"` needs an explicit `provider` + `model`, otherwise the resolver stays `fingerprint` and an llm reduce fails open with `reducer-route-missing` |
| Online Context Compact | `graphflow_context` `contextPressure` arg + result block | budget is scaled by *observed* pressure; `compaction` is an economic advisory and is emitted only when `usedTokens` + `remainingTurnsEstimate` are supplied. GraphFlow never fabricates pressure |
| Action Fusion | `graphflow_run` `executionDescriptor.steps` / `fused` | an edit immediately followed by run/validate collapses into one action unit. Execution stays with the host |

## 3. Efficiency and capability floor (P1)

`src/learning/efficiency-report.ts` records **paired arms** for the same work
(baseline vs packaged) and disqualifies a comparison when:

- tokens did not improve (`no-efficiency-gain`),
- the capability score regressed beyond tolerance (`capability-regression:score`),
- the response count dropped (`capability-regression:response-count`) — the
  control that proves the saving is not `doing less`.

The report is persisted to `graphflow-out/efficiency.json`. `governance
release-gate` now accepts opt-in floor thresholds:

```
graphflow governance release-gate \
  --min-efficiency-qualifying 1 \
  --max-capability-regressions 0 \
  --min-anchor-recall-percent 100 \
  --min-body-coverage-percent 80
```

**Producers.** `graphflow mechanism trial` appends the exact record it
evaluated (its own tolerance, never re-scored with the default) to this report,
so real trials feed the floor instead of only the mechanism's Decision node.
Inspect or clear it with `graphflow efficiency [show|reset]`.
[`benchmarks/run-plugin-ab.ts`](../benchmarks/run-plugin-ab.ts) is the plugin
ON/OFF harness that can also drive the same report from real DSH sessions.

Anchor recall and body coverage come from `graphflow-out/context-fidelity.json`
and are only checked when samples exist, so existing gates keep their behaviour.

## 4. Mechanism auto-research loop (P2)

`src/learning/mechanism-research.ts` runs the SoL-Pi loop on mechanisms instead
of skills. State lives in a `Decision` node with id `mechanism:<slug>`:

```
proposed -> in-trajectory -> frozen -> held-out -> admitted | rejected
```

Three rules are enforced in code:

1. **Constrained efficiency** — admission requires a held-out trial whose paired
   comparison qualifies.
2. **Held-out isolation** — after `freeze`, an `in-trajectory` trial is refused,
   so the search cannot keep tuning against the frozen evaluation.
3. **Terminal decisions** — an admitted/rejected mechanism accepts no new trials.

CLI:

```
graphflow mechanism propose --name <name> --family <tools|context|observation|delegation|prompt|method> \
  --claim <avoidable work> --metric tokens [--tolerance 0.05]
graphflow mechanism trial --id mechanism:<slug> --phase <in-trajectory|held-out> \
  --baseline-tokens N --packaged-tokens N [--baseline-score S --packaged-score S] \
  [--baseline-responses R --packaged-responses R] [--episode <id>]
graphflow mechanism freeze  --id mechanism:<slug>
graphflow mechanism admit   --id mechanism:<slug> [--reason <text>]
graphflow mechanism reject  --id mechanism:<slug> --reason <text>
graphflow mechanism list
```

`graphflow diagnose` reports a `mechanisms` summary.

## 5. Projection boundary (P1, deepseek-harness completed)

SoL-Pi shrinks a large tool result *before its first prompt insertion* because
it owns the provider-context projection. GraphFlow does not own that surface.
`src/observations/host-hook.ts` therefore defines the contract a host must
implement:

```ts
const { archived, projected } = await projectToolResult(
  { tool: "bash", text: resultText },
  { rootDir, policy }
);
// archived === true => replace the model-visible result with `projected`
```

**deepseek-harness is now wired** (dsh/plugin.mjs): dsh exposes the same
surface-replace primitive its native dsh-compaction-tool-result-pruner uses —

```js
session.append("tool/result", data, {
  surfaceOp: { op: "replace", startSeq, endSeq },
  sourceEventSeqs: [seq],
})
```

On a tool/result session event the glue archives the exact bytes via
graphflow observe pack, then replaces the surface node with a handle
projection (head/tail + recall instruction). It is ON by default
(GRAPHFLOW_D_DSH_PROJECTION=0 to disable) and fail-open: disabled,
below-threshold, pack failure, a missing surface API, or a rejected append all
leave the original result untouched. Unlike the native pruner's lossy marker,
the archived bytes are recallable byte-exactly and a reduce receipt is
verbatim-verified.

A host that cannot rewrite the model-visible result must **not** call the
in-process projectToolResult contract: archiving without projection does not
reduce context. Other hosts (opencode, Cursor, Codex, Gemini) have no
result-rewrite surface yet; they use the explicit graphflow_context
content/handle protocol from SKILL.md. HOSTS_WITH_TOOL_RESULT_PROJECTION is
now ["deepseek-harness"].

## 6. What not to do (negative lessons from SoL-Pi)

- Do not treat blunt brevity or early compaction as a mechanism.
- Do not use few-shot, RAG, or keyword gates as the primary lever.
- Reduce a tool output before its first insertion, not after.
- Gate ObservationPack by expected lifetime; do not archive everything.
- Evict stale observations deterministically before adding a summarizer.
- Disable dormant mechanisms at configuration time.

## See also

- [context-contract.md](context-contract.md) — savings vs fidelity
- [experience-memory.md](experience-memory.md) — skill flywheel
- [ROADMAP.md](../ROADMAP.md) — R6
