/**
 * working-set.ts — 工作集预取（working-set prefetch）。
 *
 * agent 本轮编辑/查看的文件构成「活跃工作集」。本模块从图谱出发，沿
 * references / calls / validates 边扩展出下一步大概率要看的相关文件与
 * 活跃符号，提前随 context 返回，避免 agent 自己发起 grep/read 探索轮次。
 *
 * 节点与边约定（与 file-indexer-nodes.ts / file-indexer-edges.ts 一致）：
 * - File 节点 id = `file:{relPath}`，metadata.path = relPath；
 * - Symbol 节点 id = `symbol:{relPath}:{hash}`，metadata.name / metadata.file；
 * - defines: File → Symbol（文件定义符号）；
 * - references: File → Symbol（本文件引用外部符号）；
 * - calls: caller Symbol → callee Symbol；
 * - validates: 任意测试侧校验边（双向都按 test-for 处理）。
 *
 * reason 判定（优先级 test-for > callee > caller > same-file）：
 * - callee：邻居符号被 touched 符号调用（calls 出边）；
 * - caller：邻居符号调用了 touched 符号（calls 入边）；
 * - test-for：候选路径含 test/spec 目录段或 .test./.spec. 等文件标记，或经 validates 边可达；
 * - same-file：其余（references 类连接）——该文件因「符号与候选同文件」而相关。
 * touched 文件自身永远不进候选（排除 touched 自身）。
 *
 * 稳健性：模块从不抛错（fail-open），任一异步失败只让对应结果退化为空；
 * getNeighbors / getNodesByIds 缺失时降级用 queryByKeyword 找 File/Symbol
 * 节点（无边可扩 → files 为空，只报告活跃符号）。
 * 不 import 任何全局配置，全部参数显式传入。
 */
import type { GraphClient } from "./client-factory.js";
import type { GraphEdge, GraphNode } from "../core/types.js";

export interface WorkingSetOptions {
  touchedFiles: string[];
  maxFiles?: number;
  maxSymbols?: number;
}

export interface WorkingSetFile {
  path: string;
  reason: "caller" | "callee" | "same-file" | "test-for";
  viaSymbols: string[];
}

export interface WorkingSetReport {
  touchedFiles: string[];
  /** 建议预取的相关文件，按相关度（viaSymbols 数量）排序，截断 maxFiles（默认 8）。 */
  files: WorkingSetFile[];
  /** 活跃符号（touched 文件定义的），截断 maxSymbols（默认 24）。 */
  symbols: Array<{ id: string; name: string; file?: string }>;
  /** = files.length（agent 不必自己打开的文件数——诚实计数，不乘系数）。 */
  potentiallyAvoidedReads: number;
  /** files 数 × 800（每文件预取包预算提示）。 */
  budgetHintTokens: number;
}

type WorkingSetSymbolEntry = WorkingSetReport["symbols"][number];
type Neighbor = { node: GraphNode; via: GraphEdge["relation"] };

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_SYMBOLS = 24;
/** 每文件预取包预算提示（tokens）。 */
const TOKENS_PER_FILE = 800;

const FILE_ID_PREFIX = "file:";
const SYMBOL_ID_PREFIX = "symbol:";

/** 路径含 test/spec（目录段或 .test./.spec./_test./_spec. 文件标记）→ 视为测试文件。 */
const TEST_PATH_RE = /(^|[\\/])(__tests__|tests?|specs?)([\\/]|$)|[._-](test|spec)\./i;

function normalizeRelPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function metadataString(node: GraphNode, key: string): string | undefined {
  const value = node.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从 `symbol:{relPath}:{hash}` 形式的 id 解析出 relPath。 */
function pathFromSymbolId(id: string): string | undefined {
  if (!id.startsWith(SYMBOL_ID_PREFIX)) return undefined;
  const rest = id.slice(SYMBOL_ID_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

/** 节点所属文件：Symbol 用 metadata.file（回退 id 路径段），File 用 metadata.path（回退 id 后缀）。 */
function nodeSourceFile(node: GraphNode): string | undefined {
  if (node.type === "Symbol") {
    return metadataString(node, "file") ?? pathFromSymbolId(node.id);
  }
  if (node.type === "File") {
    const fromMeta = metadataString(node, "path");
    if (fromMeta) return fromMeta;
    return node.id.startsWith(FILE_ID_PREFIX) ? node.id.slice(FILE_ID_PREFIX.length) : undefined;
  }
  return metadataString(node, "file") ?? metadataString(node, "path");
}

/** 符号显示名：优先 metadata.name，回退 content 第二个 token（`{kind} {name} ...`），最后回退 id。 */
function symbolDisplayName(node: GraphNode): string {
  const fromMeta = metadataString(node, "name");
  if (fromMeta) return fromMeta;
  const tokens = node.content.trim().split(/\s+/);
  const candidate = tokens[1];
  if (candidate && !candidate.startsWith("@") && !candidate.startsWith("(")) {
    return candidate;
  }
  return node.id;
}

function toSymbolEntry(node: GraphNode): WorkingSetSymbolEntry {
  const file = nodeSourceFile(node);
  return { id: node.id, name: symbolDisplayName(node), ...(file ? { file } : {}) };
}

/**
 * 解析 touched 路径对应的 File 节点。
 * 优先 getNodesByIds（id 确定性为 `file:{path}`）；缺失或抛错时降级 queryByKeyword
 * 并严格按 path 过滤（关键词命中可能过宽，这里只接受路径精确相等的 File 节点）。
 */
async function resolveFileNodes(client: GraphClient, paths: string[]): Promise<GraphNode[]> {
  const byIds = client.getNodesByIds?.bind(client);
  if (byIds) {
    try {
      return (await byIds(paths.map((p) => `${FILE_ID_PREFIX}${p}`))).filter((n) => n.type === "File");
    } catch {
      // 降级到 queryByKeyword
    }
  }
  const wanted = new Set(paths);
  const found: GraphNode[] = [];
  for (const path of paths) {
    let matched: GraphNode[];
    try {
      matched = await client.queryByKeyword(path);
    } catch {
      continue;
    }
    for (const node of matched) {
      if (node.type !== "File" || found.some((f) => f.id === node.id)) continue;
      if (wanted.has(nodeSourceFile(node) ?? "")) found.push(node);
    }
  }
  return found;
}

/**
 * 收集 touched 文件定义的 Symbol 节点（活跃符号，未截断——截断只作用于报告）。
 * 优先 getNeighbors(fileIds, ["defines"], "out")；缺失/抛错/无结果时降级
 * queryByKeyword 并按 metadata.file 严格过滤。
 */
async function collectTouchedSymbols(
  client: GraphClient,
  paths: string[],
  fileNodes: GraphNode[]
): Promise<GraphNode[]> {
  const neighbors = client.getNeighbors?.bind(client);
  if (neighbors && fileNodes.length > 0) {
    try {
      const defined = await neighbors(
        fileNodes.map((n) => n.id),
        ["defines"],
        "out"
      );
      const symbols = defined.filter((e) => e.node.type === "Symbol").map((e) => e.node);
      if (symbols.length > 0) return symbols;
    } catch {
      // 降级到 queryByKeyword
    }
  }
  const wanted = new Set(paths);
  const symbols: GraphNode[] = [];
  for (const path of paths) {
    let matched: GraphNode[];
    try {
      matched = await client.queryByKeyword(path);
    } catch {
      continue;
    }
    for (const node of matched) {
      if (node.type !== "Symbol" || symbols.some((s) => s.id === node.id)) continue;
      const file = nodeSourceFile(node);
      if (file !== undefined && wanted.has(file)) symbols.push(node);
    }
  }
  return symbols;
}

interface Candidate {
  path: string;
  viaNames: string[];
  callee: boolean;
  caller: boolean;
  validates: boolean;
}

/**
 * 沿 references/calls（双向）与 validates 边扩展候选文件。
 * viaSymbols 取锚定候选文件的邻居符号名（File 型邻居无法归因单个符号，不贡献 via）。
 * 已按 viaSymbols 数量降序、路径升序排好序；未截断（截断由调用方按 maxFiles 执行）。
 */
async function expandCandidateFiles(
  client: GraphClient,
  touched: Set<string>,
  fileNodes: GraphNode[],
  symbolNodes: GraphNode[]
): Promise<WorkingSetFile[]> {
  const neighbors = client.getNeighbors?.bind(client);
  if (!neighbors) return [];

  const safeNeighbors = async (
    ids: string[],
    relation: GraphEdge["relation"],
    direction: "out" | "in" | "both"
  ): Promise<Neighbor[]> => {
    if (ids.length === 0) return [];
    try {
      return await neighbors(ids, [relation], direction);
    } catch {
      return [];
    }
  };

  const candidates = new Map<string, Candidate>();
  const add = (path: string, viaName: string | undefined, kind: "callee" | "caller" | "same" | "test"): void => {
    if (touched.has(path)) return; // 排除 touched 自身
    let candidate = candidates.get(path);
    if (!candidate) {
      candidate = { path, viaNames: [], callee: false, caller: false, validates: false };
      candidates.set(path, candidate);
    }
    if (viaName && !candidate.viaNames.includes(viaName)) candidate.viaNames.push(viaName);
    if (kind === "callee") candidate.callee = true;
    else if (kind === "caller") candidate.caller = true;
    else if (kind === "test") candidate.validates = true;
  };

  const symbolIds = symbolNodes.map((n) => n.id);
  const fileIds = fileNodes.map((n) => n.id);

  if (symbolIds.length > 0) {
    // 出边 calls：邻居符号被 touched 符号调用 → callee
    for (const { node } of await safeNeighbors(symbolIds, "calls", "out")) {
      const file = nodeSourceFile(node);
      if (node.type === "Symbol" && file) add(file, symbolDisplayName(node), "callee");
    }
    // 入边 calls：邻居符号调用了 touched 符号 → caller
    for (const { node } of await safeNeighbors(symbolIds, "calls", "in")) {
      const file = nodeSourceFile(node);
      if (node.type === "Symbol" && file) add(file, symbolDisplayName(node), "caller");
    }
    // references 入边：引用了 touched 符号的其它文件（邻居是 File）
    for (const { node } of await safeNeighbors(symbolIds, "references", "in")) {
      const file = nodeSourceFile(node);
      if (node.type === "File" && file) add(file, undefined, "same");
    }
    // validates 边（双向）→ test-for
    for (const { node } of await safeNeighbors(symbolIds, "validates", "both")) {
      const file = nodeSourceFile(node);
      if (file) add(file, node.type === "Symbol" ? symbolDisplayName(node) : undefined, "test");
    }
  }
  // references 出边：touched 文件引用的外部符号
  for (const { node } of await safeNeighbors(fileIds, "references", "out")) {
    const file = nodeSourceFile(node);
    if (node.type === "Symbol" && file) add(file, symbolDisplayName(node), "same");
  }
  // touched File 上的 validates 边（双向）→ test-for
  for (const { node } of await safeNeighbors(fileIds, "validates", "both")) {
    const file = nodeSourceFile(node);
    if (file) add(file, node.type === "Symbol" ? symbolDisplayName(node) : undefined, "test");
  }

  const files = [...candidates.values()].map((c): WorkingSetFile => ({
    path: c.path,
    reason:
      c.validates || TEST_PATH_RE.test(c.path)
        ? "test-for"
        : c.callee
          ? "callee"
          : c.caller
            ? "caller"
            : "same-file",
    viaSymbols: c.viaNames,
  }));
  files.sort(
    (a, b) => b.viaSymbols.length - a.viaSymbols.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
  return files;
}

/**
 * 计算工作集预取报告。空 touched、图无数据或任何图查询失败都返回空结构，绝不抛错。
 * 降级契约：getNodesByIds 缺失 → queryByKeyword 找 File 节点；getNeighbors 缺失 →
 * queryByKeyword 找活跃符号，但无法沿边扩展（files 为空）。
 */
export async function computeWorkingSet(
  client: GraphClient,
  options: WorkingSetOptions
): Promise<WorkingSetReport> {
  const raw = Array.isArray(options.touchedFiles) ? options.touchedFiles : [];
  const touchedFiles = [
    ...new Set(raw.filter((p) => typeof p === "string" && p.length > 0).map(normalizeRelPath)),
  ];
  if (touchedFiles.length === 0) {
    return { touchedFiles: [], files: [], symbols: [], potentiallyAvoidedReads: 0, budgetHintTokens: 0 };
  }
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxSymbols = Math.max(0, Math.floor(options.maxSymbols ?? DEFAULT_MAX_SYMBOLS));

  let fileNodes: GraphNode[] = [];
  try {
    fileNodes = await resolveFileNodes(client, touchedFiles);
  } catch {
    fileNodes = [];
  }

  let symbolNodes: GraphNode[] = [];
  try {
    symbolNodes = await collectTouchedSymbols(client, touchedFiles, fileNodes);
  } catch {
    symbolNodes = [];
  }

  let files: WorkingSetFile[] = [];
  try {
    files = await expandCandidateFiles(client, new Set(touchedFiles), fileNodes, symbolNodes);
  } catch {
    files = [];
  }

  const trimmed = files.slice(0, maxFiles);
  return {
    touchedFiles,
    files: trimmed,
    symbols: symbolNodes.slice(0, maxSymbols).map(toSymbolEntry),
    potentiallyAvoidedReads: trimmed.length,
    budgetHintTokens: trimmed.length * TOKENS_PER_FILE,
  };
}
