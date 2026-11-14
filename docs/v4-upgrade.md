# GraphFlow v4 development upgrade

## WorkBuddy update package

The `skills/graphflow` directory is the WorkBuddy SkillHub package source. It contains `SKILL.md`, `_skillhub_meta.json` and its icon. Install or import that folder using the WorkBuddy skill interface, and configure its GraphFlow MCP server separately. The skill needs the matching v4 development runtime: install the supplied npm tarball with `npm install -g <path-to-tarball>` and configure the MCP command as `graphflow-mcp`. Restart WorkBuddy after updating. The package version remains 3.9.2 until a coordinated release; do not substitute the older published 3.9.2 runtime for this development build.

The MCP surface remains `gf_read`, `gf_edit`, `gf_exec`, `gf_macro`. Existing arguments still work. This checkout retains package version 3.9.2 until a release is prepared.

## Guarded edits

`gf_edit` stages syntax, relative-import, export, caller-arity and struct-field checks before writing. Contract errors reject by default. `policy: "warn"` is an explicit compatibility override. Multiple files are committed with a journal and rollback; this is an application-level transaction, not a filesystem atomic rename across files.

```json
{ "mode": "prepare", "file": "src/a.ts", "symbol": "run", "newCode": "...", "rootDir": "/workspace" }
```

The response includes `proposalId`, base SHA-256 values, a bounded diff, risk, blocking diagnostics and proposed tests. Commit with `{"mode":"commit","proposalId":"edit:..."}`. A stale file returns `STALE_BASELINE`. A write failure triggers rollback and reports `RECOVERABLE_FAILURE`; `.graphflow/edit-transactions` keeps any unresolved journal. Proposals expire after 30 minutes. `expectedSha256` can pin a direct edit to a previously read file hash.

## Read receipts

`gf_read` accepts `detail: "locate" | "summary" | "code" | "closure"`, `maxOutputTokens`, `sinceReceipt` and `cursor`. A receipt includes the branch and source hashes. An unchanged repeat returns `UNCHANGED`; changed content returns a delta span. A cursor becomes stale when the branch or a source file changes. Budgets below 40 estimated tokens return `budget-too-small`. Token budgets are tool text estimates (four characters per token), not billed API usage.

## Test evidence

`gf_exec` accepts `planOnly` and `verifyLevel: "fast" | "safe" | "full"`. `affected-tests` returns selected tests, heuristic reasons, coverage status and a plan hash. `NO_TESTS` is distinct from `PASS`. Failures carry a fingerprint based on the diagnostic and changed-content hash. Three identical failures with no changed content stop a fourth `gf_exec` run; `overrideFailureStop: true` requires `overrideReason`. Hosts outside `gf_exec` may only display an advisory rescue packet.

## Macro trust and recipes

Mined macros start as `discovered`; saved macros start as `proposed`. `gf_macro` actions `propose`, `approve`, `activate`, `revoke` move through the trust states. `run` also accepts `dryRun: true`. Effectful macros require the active state and a matching workspace version. Parameterized commands use argv without shell operators; codemods use `gf_edit`. Generated standalone runners refuse direct effectful execution.

An active macro can become a verified recipe with `gf_macro(action="verify", id="...", steps=["npm test"])`. `recipe-run` rechecks the verification command after the macro and invalidates the recipe on failure. Recipes record the source hash, project version, permissions and verification time. These local records are not uploaded.

## Evidence and optional LSP

MCP and CLI tool calls append local `.graphflow/evidence-ledger.jsonl` receipts with hashes, estimated output tokens, duration and an explicit verification outcome. No raw prompt, source, command or API key is stored in the ledger. Real model usage appears only when a host supplies it.

An exact symbol read with no heuristic caller evidence may query an installed language server for references. Server startup and requests have short timeouts; absence or failure leaves the AST result intact. The optional LSP check is used by the MCP server and `graphflow read`.

## A/B measurement

`node scripts/v4-ab-report.mjs --check-corpus` validates the 30-task corpus pinned to `5536fb3`. Run the same tasks against that baseline and this checkout, then provide JSONL results to `node scripts/v4-ab-report.mjs results.jsonl`. Each row needs `taskId`, `variant` (`baseline` or `v4`), verified `success`, `durationMs`, `estimatedOutputTokens` or `outputChars`, `testRuns` and `retries`. Supply `observedModelUsage.costUsd` only when the host reports actual cost. Without it, the report says `UNKNOWN`. No A/B success or cost improvement is claimed before both variants are run.
