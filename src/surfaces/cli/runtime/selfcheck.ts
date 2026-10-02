import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { graphStoreDeltaPath } from "../../../graph/graphify-file-client";
import { hasPendingGraphIndexWork } from "../../../graph/file-indexer-cache";
import { resolveIndexManifestName } from "../../../graph/client-factory";
import { loadGraphStore } from "./helpers";
import { redactSecrets } from "../../../learning/dialogue-thread";
import { hasUsableLlmProvider } from "../../../config/llm-availability";
import { getTypescriptBackendStatus } from "../../../graph/language-indexers/typescript";

/**
 * `graphflow selfcheck` — one command, read-only, ~seconds: is this
 * installation actually healthy? Every check below exists because a live
 * acceptance round found it silently broken somewhere (config silently
 * falling back to defaults, a dialogue-only store suppressing code indexing,
 * a grown delta log making every read take half a minute, a revoked key
 * reported as healthy). Red/green output; --json carries the same data.
 */

export interface SelfcheckItem {
  name: string;
  status: "ok" | "warn" | "fail" | "na";
  detail: string;
}

export interface SelfcheckResult {
  ok: boolean;
  items: SelfcheckItem[];
  /** Counters surfaced for quick glance. */
  summary: { ok: number; warn: number; fail: number; na: number };
}

export async function runSelfcheck(
  configPath?: string,
  rootDir?: string
): Promise<SelfcheckResult> {
  const items: SelfcheckItem[] = [];

  // 1. Config loads (the fail-fast path throws; here we surface it red).
  let config;
  try {
    config = resolveConfig(configPath ?? "graphflow.config.json", rootDir ? { rootDir } : undefined, { allowUnsafeWorkspace: true });
    items.push({ name: "config", status: "ok", detail: "project/global config layers load and validate" });
  } catch (error) {
    config = undefined;
    items.push({
      name: "config",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!config) {
    // Everything below needs a config; a red config line is the whole story.
    const summary = { ok: 0, warn: 0, fail: 1, na: 0 };
    return { ok: false, items, summary };
  }
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();

  // 2. Graph store: readable, and CODE nodes present (a dialogue-only store
  // used to suppress indexing forever).
  try {
    const store = loadGraphStore(config);
    const byType = new Map<string, number>();
    for (const node of store.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    const codeNodes = (byType.get("File") ?? 0) + (byType.get("Symbol") ?? 0) + (byType.get("Module") ?? 0);
    items.push({
      name: "graph-store",
      status: "ok",
      detail: `${store.nodes.length} nodes (${codeNodes} code nodes) / ${store.edges.length} edges @ ${resolveGraphStorePath(config)}`,
    });
    if (store.nodes.length === 0) {
      items[items.length - 1]!.status = "warn";
      items[items.length - 1]!.detail += " — empty store, first preview/index will populate it";
    } else if (codeNodes === 0) {
      items[items.length - 1]!.status = "warn";
      items[items.length - 1]!.detail += " — no File/Symbol/Module nodes: conversation-only store, code indexing never ran here";
    }
  } catch (error) {
    items.push({ name: "graph-store", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  // 3. Delta log size — a grown log made every file-store read take ~30s
  // before the O(degree) rewrite; compaction keeps it bounded.
  try {
    const storePath = resolveGraphStorePath(config);
    const deltaPath = graphStoreDeltaPath(storePath);
    if (existsSync(deltaPath)) {
      const lines = readFileSync(deltaPath, "utf8").split("\n").filter(Boolean).length;
      const sizeKb = Math.round(statSync(deltaPath).size / 1024);
      const status = lines > 1000 ? "warn" : "ok";
      items.push({
        name: "delta-log",
        status,
        detail: `${lines} ops / ${sizeKb}KB${lines > 1000 ? " — large, expect a fold/compaction soon" : ""}`,
      });
    } else {
      items.push({ name: "delta-log", status: "ok", detail: "no pending delta (fully folded)" });
    }
  } catch (error) {
    items.push({ name: "delta-log", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 4. Index freshness.
  try {
    const pending = hasPendingGraphIndexWork(root, {
      ...(config.graphPolicy.includeExtensions ? { includeExtensions: config.graphPolicy.includeExtensions } : {}),
      manifestName: resolveIndexManifestName(config),
    });
    items.push({
      name: "index-freshness",
      status: pending ? "warn" : "ok",
      detail: pending ? "workspace has files not yet indexed (next preview/run will index)" : "index cache is fresh",
    });
  } catch (error) {
    items.push({ name: "index-freshness", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 4b. TS/JS indexer backend — the primary user language used to degrade to
  // regex extraction silently when the optional 'typescript' package was
  // absent from an npm global/npx install tree (only a stderr log remained).
  try {
    const backend = getTypescriptBackendStatus();
    items.push(
      backend === "compiler"
        ? { name: "ts-indexer", status: "ok", detail: "TS/JS parsed with the TypeScript compiler" }
        : {
            name: "ts-indexer",
            status: "warn",
            detail:
              "TS/JS fell back to REGEX extraction — the optional 'typescript' package did not resolve from this install; AST features (calls/inherits/jsdoc) are degraded",
          },
    );
  } catch (error) {
    items.push({ name: "ts-indexer", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 4c. Cost ledger — is the cost trail actually being written?
  try {
    const { summarizeCost } = await import("../../../learning/cost-ledger.js");
    const summary = summarizeCost(config, { kind: "llm" });
    if (summary.calls > 0) {
      const cachePct = summary.promptTokens > 0 ? Math.round((summary.cacheHitTokens / summary.promptTokens) * 100) : 0;
      items.push({
        name: "cost-ledger",
        status: "ok",
        detail: `${summary.calls} LLM calls recorded; estCost≈${summary.estCostMgc.toFixed(4)} 元; cacheHit ${cachePct}% of prompt tokens${summary.unpricedCalls > 0 ? ` (${summary.unpricedCalls} unpriced)` : ""}`,
      });
    } else {
      items.push({
        name: "cost-ledger",
        status: "na",
        detail: "no own-LLM cost recorded yet (bridge mode records host-delivered bytes only)",
      });
    }
  } catch (error) {
    items.push({ name: "cost-ledger", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 5. LLM round-trip — configured health lies; only a real call tells the truth.
  if (hasUsableLlmProvider(config)) {
    try {
      const { probeRoutingConnectivity } = await import("./routing.js");
      const probes = await probeRoutingConnectivity(configPath, 4_000);
      const failed = probes.filter((p) => !p.ok);
      if (failed.length === 0) {
        items.push({
          name: "llm-probe",
          status: "ok",
          detail: probes.map((p) => `${p.role}:ok(${p.latencyMs}ms)`).join(" | "),
        });
      } else {
        items.push({
          name: "llm-probe",
          status: "fail",
          detail: failed.map((p) => `${p.role}: ${p.error}`).join(" | "),
        });
      }
    } catch (error) {
      items.push({ name: "llm-probe", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    items.push({ name: "llm-probe", status: "na", detail: "no LLM provider configured — plan/run will bridge to the connected agent" });
  }

  // 5b. Judgment tier — which brain answers the cheap-verification roles
  // (plan challenge gate, distillation, lesson extraction)? Local Jev first,
  // then cloud economy, then deterministic rules — the ladder must be visible.
  try {
    const { resolveTypesafeCredentials, typesafeClientOptionsFromConfig } = await import(
      "../../../routing/typesafe-systemone.js"
    );
    const options = typesafeClientOptionsFromConfig(config);
    const creds = resolveTypesafeCredentials(options);
    if (creds?.apiKey) {
      const base = options.baseUrl ?? "";
      const local = /localhost|127\.0\.0\.1|::1/.test(base);
      items.push({
        name: "judgment-tier",
        status: "ok",
        detail: local
          ? `local-jev (${base}) — typed judgments at ~zero marginal cost`
          : "cloud-jev (typesafe.ai) — typed judgments over the network",
      });
    } else if (hasUsableLlmProvider(config)) {
      items.push({ name: "judgment-tier", status: "ok", detail: "cloud-economy — judgment roles route to the configured economy tier" });
    } else {
      items.push({
        name: "judgment-tier",
        status: "na",
        detail: "rules-only — challenge gate runs on graph facts, distillation on heuristics; zero LLM cost",
      });
    }
  } catch (error) {
    items.push({ name: "judgment-tier", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 6. Flywheel pulse.
  try {
    const { getFlywheelReport } = await import("./graph.js");
    const report = getFlywheelReport(configPath);
    const pendingRatio = report.episodes.total === 0
      ? 0
      : report.episodes.pending / report.episodes.total;
    items.push({
      name: "flywheel",
      status: report.episodes.total === 0 ? "na" : pendingRatio > 0.5 ? "warn" : "ok",
      detail: `episodes ${report.episodes.total} (pass ${report.episodes.pass} / fail ${report.episodes.fail} / pending ${report.episodes.pending}), skills ${report.skills.total}, pending ratio ${(pendingRatio * 100).toFixed(0)}%`,
    });
  } catch (error) {
    items.push({ name: "flywheel", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 6b. Mechanically closable episodes (read-only: no git, no verify run).
  try {
    const { reconcilePreview } = await import("./learning.js");
    const preview = await reconcilePreview(configPath);
    if (preview.candidates === 0) {
      items.push({ name: "reconcile", status: "na", detail: "no pending episodes in the lookback window" });
    } else if (!preview.verifyCommand) {
      items.push({
        name: "reconcile",
        status: "warn",
        detail: `${preview.candidates} pending (${preview.withNamedFiles} name files), but reconcilePolicy.verifyCommand is unset — a commit is delivery, not correctness, so nothing can be concluded`,
      });
    } else {
      items.push({
        name: "reconcile",
        status: "ok",
        detail: `${preview.candidates} pending (${preview.withNamedFiles} name files), verifyCommand: ${preview.verifyCommand}; close with 'graphflow reconcile outcomes --apply'`,
      });
    }
  } catch (error) {
    items.push({ name: "reconcile", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  // 7. Redaction spot check (function-level, nothing persisted).
  const sample = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
  const redacted = redactSecrets(sample);
  items.push({
    name: "dialogue-redaction",
    status: redacted.includes("eyJ") ? "fail" : "ok",
    detail: redacted.includes("eyJ") ? "bearer/JWT survived redaction — check GRAPHFLOW_DIALOGUE_REDACT" : "secrets are masked before persistence",
  });

  // 8. Session journal readable.
  try {
    const { readJournalEntries, resolveSessionJournalPath } = await import("../../../hooks/auto-capture.js");
    const entries = readJournalEntries(resolveSessionJournalPath(root));
    items.push({
      name: "session-journal",
      status: "ok",
      detail: `${entries.length} entries @ ${join(root, ".graphflow", "session-journal.jsonl")}`,
    });
  } catch (error) {
    items.push({ name: "session-journal", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  const summary = {
    ok: items.filter((i) => i.status === "ok").length,
    warn: items.filter((i) => i.status === "warn").length,
    fail: items.filter((i) => i.status === "fail").length,
    na: items.filter((i) => i.status === "na").length,
  };
  return { ok: summary.fail === 0, items, summary };
}

export function formatSelfcheckText(result: SelfcheckResult): string {
  const lines = result.items.map((item) => {
    const icon = item.status === "ok" ? "[OK]" : item.status === "warn" ? "[WARN]" : item.status === "fail" ? "[FAIL]" : "[N/A]";
    return `${icon} ${item.name}: ${item.detail}`;
  });
  lines.push(
    `summary: ok=${result.summary.ok} warn=${result.summary.warn} fail=${result.summary.fail} n/a=${result.summary.na} healthy=${result.ok}`
  );
  return lines.join("\n");
}
