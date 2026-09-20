import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "../../../core/types";
import type { GraphFlowConfig } from "../../../config/schema";
import { resolveGraphStorePath } from "../../../config/paths";
import { GraphifySqliteClient } from "../../../graph/sqlite-client";
import { readGraphStoreFileChunked } from "../../../graph/graph-store-json-chunks";
import {
  GRAPH_STORE_MAX_READ_BYTES,
  applyGraphStoreDelta,
  graphStoreDeltaPath,
} from "../../../graph/graphify-file-client";
import { logger } from "../../../utils/logger";
import type { GraphClient } from "../../../graph/client-factory";
import type { ContextPreviewResult, SkillInsightItem } from "./types.js";

export function extractTokenCost(feedback: string): number {
  const match = feedback.match(/tokens=(\d+)/);
  if (match && match[1]) {
    return Number(match[1]);
  }

  return Math.max(1, Math.ceil(feedback.length / 4));
}

export function loadGraphStore(config: GraphFlowConfig): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const transport = config.graphPolicy.transport;

  if (transport === "memory") {
    return { nodes: [], edges: [] };
  }

  if (transport === "sqlite" || transport === "auto") {
    const dbPath = resolveGraphStorePath(config);
    try {
      const client = new GraphifySqliteClient(dbPath);
      const snapshot = client.readSnapshot();
      client.close();
      return snapshot;
    } catch {
      const fallbackPath = dbPath.replace(/\.sqlite$/i, ".json");
      return readFileGraphStore(fallbackPath);
    }
  }

  return readFileGraphStore(resolveGraphStorePath(config));
}

export async function resolveGraphStoreAfterIndex(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (config.graphPolicy.transport === "memory" && graphClient.readSnapshot) {
    return graphClient.readSnapshot();
  }

  return loadGraphStore(config);
}

export function readFileGraphStore(
  storePath: string,
  options: { singleStringLimitBytes?: number } = {}
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!storePath || !existsSync(storePath)) {
    return { nodes: [], edges: [] };
  }

  // `readFileSync(path, "utf8")` cannot materialize a store above V8's maximum
  // string length; parse those in bounded chunks instead of reporting "no graph"
  // (which would look like an empty workspace and trigger a re-index loop).
  const limit = options.singleStringLimitBytes ?? GRAPH_STORE_MAX_READ_BYTES;
  const sizeBytes = getFileSize(storePath);
  if (sizeBytes > limit) {
    try {
      const chunked = readGraphStoreFileChunked(storePath);
      return {
        nodes: chunked.nodes as GraphNode[],
        edges: chunked.edges as GraphEdge[],
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), storePath },
        "Chunked graph store read failed"
      );
      return { nodes: [], edges: [] };
    }
  }

  try {
    const raw = readFileSync(storePath, "utf8");
    const base: { nodes: GraphNode[]; edges: GraphEdge[] } = raw.trim()
      ? (() => {
          const parsed = JSON.parse(raw) as Partial<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
          return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
        })()
      : { nodes: [], edges: [] };

    // Incremental writes land in a delta log; readers must see both.
    const deltaPath = graphStoreDeltaPath(storePath);
    if (!existsSync(deltaPath)) {
      return base;
    }
    try {
      return applyGraphStoreDelta(base, readFileSync(deltaPath, "utf8"));
    } catch {
      return base;
    }
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function readRawConfig(configPath: string): Partial<GraphFlowConfig> | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<GraphFlowConfig>;
  } catch {
    return undefined;
  }
}

/**
 * Anchor types whose node content counts toward the raw baseline: the code
 * carriers an agent would actually read. L2/L3 payloads (skills, decisions,
 * dialogue turns) are delivered as compacted summaries, not read raw, so
 * they stay out of the sum and are covered by the `compressedTokens` floor.
 */
const RAW_BASELINE_CODE_TYPES = new Set(["File", "Symbol", "Module"]);

export interface RawContextEstimateInput {
  /** Delivered anchor channel (`LayeredContextPackage.anchorChannel`). */
  anchors: ReadonlyArray<{ id: string; type: GraphNode["type"] }>;
  /** Graph store used only to resolve anchor ids to node content. */
  store: { nodes: GraphNode[]; edges: GraphEdge[] };
  query: string;
  compressedTokens: number;
}

/**
 * Raw-context baseline estimated from the DELIVERED anchor set — the volume
 * the anchors stand for — instead of every node the query fuzzily matches.
 *
 * The previous whole-graph formulation summed id+type+content over all
 * store nodes matching any query term; for a pure-CJK query the term
 * extraction produced no latin terms, so EVERY node matched and the
 * "baseline" was the entire store (observed ~339K tokens against a ~13K
 * token anchor set — a 25x inflation that made 100% savings meaningless).
 *
 * Semantics kept from the old formula:
 * - per-node convention `estimateTokenCount(id + "\n" + type + "\n" + content)`
 *   for File/Symbol/Module anchors resolvable in the store;
 * - floor: the estimate never drops below the delivered payload
 *   (compressedTokens) or the query echo.
 *
 * Empty anchor set: nothing was delivered, so there is no honest raw
 * alternative to compare against — return the conservative floor instead of
 * scanning the store.
 */
export function estimateRawContextTokens(input: RawContextEstimateInput): number {
  const byId = new Map<string, GraphNode>();
  for (const node of input.store.nodes) {
    if (node?.id && !byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  let rawTokens = 0;
  for (const anchor of input.anchors) {
    const node = byId.get(anchor.id);
    if (!node || !RAW_BASELINE_CODE_TYPES.has(node.type)) {
      continue;
    }
    rawTokens += estimateTokenCount(`${node.id}\n${node.type}\n${node.content}`);
  }

  return Math.max(input.compressedTokens, rawTokens, estimateTokenCount(input.query));
}

export function calculateSavingsPercent(rawTokens: number, compressedTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((rawTokens - compressedTokens) / rawTokens) * 100)));
}

/**
 * Dual-baseline accounting: the honest comparison baseline for agents that
 * already have grep + read. `estimatedRawTokens` compares against "read every
 * matching file" (~22K tokens on a real repo), which overstates the
 * alternative for a grep-capable agent; the true alternative is closer to
 * "one grep + read the fragment around the top anchor" (~2-3K tokens).
 * 双基线记账：对已有 grep+read 的 agent，`estimatedRawTokens`（读全部相关文件）
 * 高估了对照成本；真实基线接近"grep 一次 + 读 top anchor 附近片段"。
 *
 * Deterministic formula (never reads file content — fs.stat byte size only):
 * 公式（确定性、可文档化、不读文件内容，仅允许 fs.stat 拿字节数）：
 *
 *   estimatedGrepBaselineTokens =
 *     min(estimatedRawTokens,
 *         max(1, round(topAnchorBytes / 4 * GREP_BASELINE_FRAGMENT_SHARE)
 *              + GREP_BASELINE_FIXED_OVERHEAD_TOKENS))   // stat 可用时
 *     | max(1, round(estimatedRawTokens * 0.3))           // stat 失败/无文件锚点回退
 *
 * - `topAnchorBytes / 4`: bytes→tokens via the same "4 chars ≈ 1 token"
 *   convention as `estimateTokenCount`'s fallback estimator.
 *   字节数折算沿用 estimateTokenCount 兜底估算的"4 字符≈1 token"惯例。
 * - `* GREP_BASELINE_FRAGMENT_SHARE (0.25)`: only the quarter of the file
 *   around the hit is read. 假设只读命中片段附近约四分之一。
 * - `+ GREP_BASELINE_FIXED_OVERHEAD_TOKENS (200)`: fixed grep cost (query +
 *   match list). grep 本身的固定开销（查询 + 命中列表）。
 * - Capped at `estimatedRawTokens`: the grep+fragment baseline never exceeds
 *   the read-everything baseline. 封顶：grep 基线不超过"读全部"基线。
 */
export const GREP_BASELINE_FRAGMENT_SHARE = 0.25;
export const GREP_BASELINE_FIXED_OVERHEAD_TOKENS = 200;
export const GREP_BASELINE_FALLBACK_SHARE = 0.3;

export interface GrepBaselineInput {
  /** fs.stat size in bytes of the top L1 File anchor, when resolvable. */
  topAnchorBytes?: number;
  /** Read-everything baseline (`tokenBudget.estimatedRawTokens`). */
  estimatedRawTokens: number;
}

export function estimateGrepBaselineTokens(input: GrepBaselineInput): number {
  const rawTokens = Math.max(0, Math.round(input.estimatedRawTokens));
  if (rawTokens <= 0) {
    return 0;
  }
  const statBytes =
    typeof input.topAnchorBytes === "number" &&
    Number.isFinite(input.topAnchorBytes) &&
    input.topAnchorBytes > 0
      ? input.topAnchorBytes
      : undefined;
  const computed =
    statBytes !== undefined
      ? Math.round((statBytes / 4) * GREP_BASELINE_FRAGMENT_SHARE) +
        GREP_BASELINE_FIXED_OVERHEAD_TOKENS
      : Math.round(rawTokens * GREP_BASELINE_FALLBACK_SHARE);
  return Math.max(1, Math.min(rawTokens, computed));
}

/**
 * Decorate a preview result's token budget with the dual-baseline fields
 * (`estimatedGrepBaselineTokens` + `estimatedSavingsPercentVsGrep`), computed
 * against the top L1 File anchor resolved via fs.stat (relative to the
 * workspace root). Pure and best-effort: on any failure (no file anchor,
 * stat error) the fields stay omitted and the input is returned unchanged;
 * already-decorated results pass through untouched (idempotent — the attach
 * chain may revisit a result).
 * 为预览结果的 tokenBudget 附加双基线字段：top L1 File anchor 用 fs.stat 取
 * 字节数（相对 workspace root 解析）。纯函数、尽力而为：拿不到锚点或 stat
 * 失败时字段保持缺省、原样返回；已装饰过的结果幂等直通。
 */
export function withGrepBaselineBudget(
  result: ContextPreviewResult,
  config: GraphFlowConfig
): ContextPreviewResult {
  if (!result?.tokenBudget || result.tokenBudget.estimatedGrepBaselineTokens !== undefined) {
    return result;
  }
  try {
    let topAnchorBytes: number | undefined;
    const topFileAnchor = result.anchors.find(
      (anchor) => anchor.layer === "L1" && anchor.type === "File"
    );
    if (topFileAnchor?.id.startsWith("file:")) {
      const root = config.graphPolicy.workspaceRoot ?? process.cwd();
      topAnchorBytes = statSync(join(root, topFileAnchor.id.slice("file:".length))).size;
    }
    const estimatedGrepBaselineTokens = estimateGrepBaselineTokens({
      ...(topAnchorBytes !== undefined ? { topAnchorBytes } : {}),
      estimatedRawTokens: result.tokenBudget.estimatedRawTokens,
    });
    // 与 estimatedSavingsPercent 同口径：对真实下发总量（accountedTokens）求节省。
    // Same denominator as estimatedSavingsPercent: the TRUE accounted payload.
    const accountedTokens = result.accountedTokens ?? result.tokenBudget.compressedTokens;
    return {
      ...result,
      tokenBudget: {
        ...result.tokenBudget,
        estimatedGrepBaselineTokens,
        estimatedSavingsPercentVsGrep: calculateSavingsPercent(
          estimatedGrepBaselineTokens,
          accountedTokens
        ),
      },
    };
  } catch {
    return result;
  }
}

export function calculateBudgetUsedPercent(compressedTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.round((compressedTokens / maxContextTokens) * 100));
}

export function estimateTokenCount(text: string): number {
  try {
    const { encode } = require("gpt-tokenizer/model/gpt-4o") as { encode: (t: string) => number[] };
    return Math.max(1, encode(text).length);
  } catch {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

export function compactPreview(content: string, maxLength: number): string {
  const compacted = content.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function parseSkillInsight(node: GraphNode): SkillInsightItem | undefined {
  try {
    const parsed = JSON.parse(node.content) as Partial<SkillInsightItem> & { hidden?: boolean };
    if (!parsed.id || !parsed.name) {
      return undefined;
    }
    // Soft-hidden toxic skills (pruneFailedSkills) stay out of insights listings.
    if (parsed.hidden === true) {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}
