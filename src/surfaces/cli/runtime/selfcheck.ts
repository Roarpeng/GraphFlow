import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { graphStoreDeltaPath } from "../../../graph/graphify-file-client";
import { hasPendingGraphIndexWork } from "../../../graph/file-indexer-cache";
import { loadGraphStore } from "./helpers";
import { redactSecrets } from "../../../learning/dialogue-thread";
import { hasUsableLlmProvider } from "../../../config/llm-availability";

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
    config = resolveConfig(configPath ?? "graphflow.config.json", rootDir ? { rootDir } : undefined);
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
    const pending = hasPendingGraphIndexWork(root, config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined);
    items.push({
      name: "index-freshness",
      status: pending ? "warn" : "ok",
      detail: pending ? "workspace has files not yet indexed (next preview/run will index)" : "index cache is fresh",
    });
  } catch (error) {
    items.push({ name: "index-freshness", status: "warn", detail: error instanceof Error ? error.message : String(error) });
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
