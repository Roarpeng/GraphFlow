import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import { resolveGraphStorePath } from "../config/paths";
import { getSavingsStats } from "./token-savings";
import { loadGraphStore } from "../surfaces/cli/runtime/helpers";

/**
 * Prometheus-compatible metrics exporter.
 *
 * Exposes cumulative GraphFlow observability metrics in Prometheus text format.
 * Borrowed from codebase-memory-mcp's observability pattern — enables teams to
 * scrape GraphFlow ROI (token savings, graph size, compression ratio) from a
 * standard /metrics endpoint or CLI dump.
 *
 * Metrics exposed:
 *   - graphflow_token_savings_total            (counter) cumulative tokens saved
 *   - graphflow_token_raw_total                (counter) cumulative raw tokens
 *   - graphflow_token_compressed_total         (counter) cumulative compressed tokens
 *   - graphflow_token_savings_percent          (gauge)   average savings ratio
 *   - graphflow_runs_total                     (counter) cumulative preview/run count
 *   - graphflow_graph_nodes                    (gauge)   current graph node count
 *   - graphflow_graph_edges                    (gauge)   current graph edge count
 *   - graphflow_compression_ratio              (gauge)   compressed/raw ratio
 *   - graphflow_index_store_bytes              (gauge)   graph store file size in bytes
 *   - graphflow_index_cache_entries            (gauge)   index cache file count
 */

export interface MetricsSnapshot {
  metrics: Record<string, number>;
  labels: Record<string, string>;
  text: string;
}

interface MetricDef {
  name: string;
  type: "counter" | "gauge";
  help: string;
}

const METRIC_DEFS: MetricDef[] = [
  { name: "graphflow_token_savings_total", type: "counter", help: "Cumulative tokens saved by context compression" },
  { name: "graphflow_token_raw_total", type: "counter", help: "Cumulative raw (uncompressed) tokens" },
  { name: "graphflow_token_compressed_total", type: "counter", help: "Cumulative compressed tokens" },
  { name: "graphflow_token_savings_percent", type: "gauge", help: "Average token savings percentage" },
  { name: "graphflow_runs_total", type: "counter", help: "Cumulative preview/run invocations" },
  { name: "graphflow_graph_nodes", type: "gauge", help: "Current graph node count" },
  { name: "graphflow_graph_edges", type: "gauge", help: "Current graph edge count" },
  { name: "graphflow_compression_ratio", type: "gauge", help: "Compressed/raw token ratio (0-1)" },
  { name: "graphflow_index_store_bytes", type: "gauge", help: "Graph store file size in bytes" },
  { name: "graphflow_index_cache_entries", type: "gauge", help: "Index cache entry count" },
];

/**
 * Collect current metrics snapshot.
 *
 * @param config GraphFlow config
 */
export function collectMetrics(config: GraphFlowConfig): MetricsSnapshot {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const stats = getSavingsStats(config);

  // Graph size from store
  let nodeCount = 0;
  let edgeCount = 0;
  let storeBytes = 0;
  try {
    const store = loadGraphStore(config);
    nodeCount = store.nodes.length;
    edgeCount = store.edges.length;
  } catch {
    // store may not exist yet
  }

  try {
    const storePath = resolveGraphStorePath(config);
    if (existsSync(storePath)) {
      storeBytes = statSync(storePath).size;
    }
  } catch {
    // ignore
  }

  // Index cache entries
  let cacheEntries = 0;
  try {
    const cachePath = join(root, ".graphflow-cache", "index-state.json");
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.state && typeof parsed.state === "object") {
        cacheEntries = Object.keys(parsed.state).length;
      }
    }
  } catch {
    // ignore
  }

  const compressionRatio = stats.totalRawTokens > 0
    ? stats.totalCompressedTokens / stats.totalRawTokens
    : 0;

  const metrics: Record<string, number> = {
    graphflow_token_savings_total: stats.totalSavedTokens,
    graphflow_token_raw_total: stats.totalRawTokens,
    graphflow_token_compressed_total: stats.totalCompressedTokens,
    graphflow_token_savings_percent: stats.averageSavingsPercent,
    graphflow_runs_total: stats.totalRuns,
    graphflow_graph_nodes: nodeCount,
    graphflow_graph_edges: edgeCount,
    graphflow_compression_ratio: compressionRatio,
    graphflow_index_store_bytes: storeBytes,
    graphflow_index_cache_entries: cacheEntries,
  };

  const labels: Record<string, string> = {
    workspace: root.replace(/\\/g, "/"),
  };

  const text = renderPrometheusText(metrics, labels);

  return { metrics, labels, text };
}

/**
 * Render metrics in Prometheus text exposition format.
 *
 * Example output:
 *   # HELP graphflow_token_savings_total Cumulative tokens saved by context compression
 *   # TYPE graphflow_token_savings_total counter
 *   graphflow_token_savings_total{workspace="/repo"} 12345
 */
function renderPrometheusText(
  metrics: Record<string, number>,
  labels: Record<string, string>
): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");

  const lines: string[] = [];

  for (const def of METRIC_DEFS) {
    const value = metrics[def.name] ?? 0;
    lines.push(`# HELP ${def.name} ${def.help}`);
    lines.push(`# TYPE ${def.name} ${def.type}`);
    lines.push(`${def.name}{${labelStr}} ${formatNumber(value)}`);
  }

  return lines.join("\n") + "\n";
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }
  // Prometheus accepts floating point; trim trailing zeros for readability
  return parseFloat(value.toFixed(4)).toString();
}
