/**
 * R9 closing audit — aggregator (runner).
 *
 * runAudit derives the changed-file baseline (see baseline.ts), builds the
 * default AuditContext (rule loading + graph probing), runs all checkers
 * concurrently, and folds their findings into one AuditReport:
 * - checkers run via Promise.allSettled — a rejected checker records
 *   `{name, findings: -1}` in summary.checkers and contributes 0 findings;
 *   it never aborts the other checkers;
 * - findings are sorted error-first, then kind lexicographic, then id (stable);
 * - `ok` is errors===0 (warnings do not block) unless strict, where any
 *   finding blocks (ok = total===0). strict = options.strict ??
 *   GRAPHFLOW_AUDIT_STRICT === "1".
 *
 * The four built-in checkers are lazy dynamic imports inside the default
 * checkers path: injected `deps.checkers` (tests / embedding hosts) never
 * touch those modules, so this file compiles and runs even while the checker
 * files are still being authored in parallel.
 *
 * Graph node conventions (file-indexer-nodes.ts / working-set.ts):
 * File node id = `file:{relPath}` (metadata.path = relPath);
 * defines: File→Symbol; references: File→Symbol; imports: File→File.
 */
import { createGraphClient, type GraphClient } from "../graph/client-factory.js";
import type { GraphNode } from "../core/types.js";
import { resolveConfig } from "../config/resolve.js";
import { deriveAuditBaseline } from "./baseline.js";
import { loadAuditRuleSet } from "./rules.js";
import type {
  AuditChecker,
  AuditContext,
  AuditFinding,
  AuditOptions,
  AuditReport,
} from "./types.js";

export interface RunAuditDeps {
  /** Test/embedding injection — skips the four lazy default checkers entirely. */
  checkers?: AuditChecker[];
  /** Test injection for baseline derivation. */
  baseline?: typeof deriveAuditBaseline;
  /** Test injection for the rule/graph context handed to every checker. */
  context?: AuditContext;
}

const FILE_ID_PREFIX = "file:";

const SEVERITY_RANK: Record<AuditFinding["severity"], number> = {
  error: 0,
  warning: 1,
};

/** 惰性加载的四个内置检查器（并行开发中；缺失/加载失败记 findings:-1，不阻塞聚合）。 */
const DEFAULT_CHECKER_LOADERS: Array<{ name: string; load: () => Promise<AuditChecker> }> = [
  {
    name: "dependency-checker",
    load: async () => (await import("./checkers/dependency-checker.js")).createDependencyChecker(),
  },
  {
    name: "doc-consistency-checker",
    load: async () =>
      (await import("./checkers/doc-consistency-checker.js")).createDocConsistencyChecker(),
  },
  {
    name: "orphan-checker",
    load: async () => (await import("./checkers/orphan-checker.js")).createOrphanChecker(),
  },
  {
    name: "rule-checker",
    load: async () => (await import("./checkers/rule-checker.js")).createRuleChecker(),
  },
];

function compareFindings(a: AuditFinding, b: AuditFinding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function normalizeRelPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 定位 File 节点：优先 getNodesByIds(`file:{relPath}`)，缺失/抛错降级 queryByKeyword(basename)。 */
async function resolveFileNode(
  client: GraphClient,
  relPath: string
): Promise<GraphNode | undefined> {
  const nodeId = `${FILE_ID_PREFIX}${relPath}`;
  if (client.getNodesByIds) {
    try {
      const hits = await client.getNodesByIds([nodeId]);
      const hit = hits.find((n) => n.type === "File" && n.id === nodeId);
      if (hit) return hit;
    } catch {
      // degrade to keyword lookup
    }
  }
  try {
    const basename = relPath.split("/").pop() ?? relPath;
    const hits = await client.queryByKeyword(basename);
    return hits.find(
      (n) =>
        n.type === "File" &&
        (n.id === nodeId || (typeof n.metadata?.path === "string" && n.metadata.path === relPath))
    );
  } catch {
    return undefined;
  }
}

/**
 * 数 File 节点的入边（fail-open，任一查询失败只少计不计错）：
 * - 指向该文件的 imports/references 入边（谁导入/引用了它）；
 * - defines 反向：该文件 defines 出边的符号被其它文件 references 的入边数
 *   （File→Symbol references 是文件引用外部符号的唯一表达，故入边要落在符号上）。
 */
async function countInboundEdges(client: GraphClient, nodeId: string): Promise<number> {
  const neighbors = client.getNeighbors?.bind(client);
  if (!neighbors) return 0;
  let count = 0;
  try {
    const direct = await neighbors([nodeId], ["imports", "references"], "in");
    count += direct.length;
  } catch {
    // degrade
  }
  try {
    const defined = await neighbors([nodeId], ["defines"], "out");
    const symbolIds = defined.map((entry) => entry.node.id);
    if (symbolIds.length > 0) {
      const refs = await neighbors(symbolIds, ["references"], "in");
      count += refs.length;
    }
  } catch {
    // degrade
  }
  return count;
}

/**
 * probeFile 默认实现：按需构造图 client（resolveConfig 绑定 root），用完即 close。
 * 任何一步失败返回 undefined（图不可用降级——检查器把它当"无法证明"而非报错）。
 */
async function probeFileWithGraph(
  root: string,
  relPath: string
): Promise<{ nodeId?: string; inboundEdges: number } | undefined> {
  let client: GraphClient;
  try {
    client = createGraphClient(resolveConfig("graphflow.config.json", { rootDir: root }));
  } catch {
    return undefined;
  }
  try {
    const normalized = normalizeRelPath(relPath);
    const node = await resolveFileNode(client, normalized);
    if (!node) return undefined;
    return { nodeId: node.id, inboundEdges: await countInboundEdges(client, node.id) };
  } catch {
    return undefined;
  } finally {
    try {
      await client.close?.();
    } catch {
      // close 失败不掩盖探测结果
    }
  }
}

/** CLI legacyText：一行汇总（errors/warnings/ok/baseline）+ findings 逐条 `[kind] message`。 */
export function formatAuditLegacyText(report: AuditReport): string {
  const head =
    "errors=" +
    report.summary.errors +
    " warnings=" +
    report.summary.warnings +
    " ok=" +
    report.ok +
    "; baseline=" +
    report.baseline.strategy +
    "(" +
    report.baseline.changedFiles.length +
    " files)";
  if (report.findings.length === 0) {
    return head;
  }
  return head + "\n" + report.findings.map((f) => "  [" + f.kind + "] " + f.message).join("\n");
}

/**
 * Run the closing audit.
 *
 * @param options audit options (since / strict / test hooks).
 * @param root fallback root — CLI passes process.cwd(); effective root =
 *   options.rootOverride ?? config.graphPolicy.workspaceRoot ?? root.
 * @param config resolved GraphFlowConfig (only graphPolicy.workspaceRoot is read).
 * @param deps injection surface for tests (checkers / baseline / context).
 */
export async function runAudit(
  options: AuditOptions,
  root: string,
  config?: { graphPolicy?: { workspaceRoot?: string } },
  deps: RunAuditDeps = {}
): Promise<AuditReport> {
  const effectiveRoot = options.rootOverride ?? config?.graphPolicy?.workspaceRoot ?? root;

  const deriveBaseline = deps.baseline ?? deriveAuditBaseline;
  const baseline = deriveBaseline(effectiveRoot, {
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.changedFilesOverride !== undefined
      ? { changedFilesOverride: options.changedFilesOverride }
      : {}),
  });

  const context: AuditContext =
    deps.context ??
    ({
      loadRules: () => loadAuditRuleSet(effectiveRoot),
      probeFile: (relPath: string) => probeFileWithGraph(effectiveRoot, relPath),
    } satisfies AuditContext);

  const checkerSummaries: Array<{ name: string; findings: number }> = [];

  let checkers: AuditChecker[];
  if (deps.checkers) {
    checkers = deps.checkers;
  } else {
    // 惰性加载内置检查器：单个模块缺失/加载失败记 -1，不影响其余模块。
    const loaded = await Promise.allSettled(DEFAULT_CHECKER_LOADERS.map((entry) => entry.load()));
    checkers = [];
    loaded.forEach((result, index) => {
      if (result.status === "fulfilled") {
        checkers.push(result.value);
      } else {
        checkerSummaries.push({ name: DEFAULT_CHECKER_LOADERS[index]!.name, findings: -1 });
      }
    });
  }

  const results = await Promise.allSettled(
    checkers.map((checker) => checker.run(baseline.changedFiles, effectiveRoot, context))
  );

  const findings: AuditFinding[] = [];
  results.forEach((result, index) => {
    const checker = checkers[index]!;
    if (result.status === "fulfilled") {
      const found = Array.isArray(result.value) ? result.value : [];
      checkerSummaries.push({ name: checker.name, findings: found.length });
      findings.push(...found);
    } else {
      // 执行失败的 checker：0 findings + summary 记 -1（哨兵值表示失败，不是 0 个发现）。
      checkerSummaries.push({ name: checker.name, findings: -1 });
    }
  });

  findings.sort(compareFindings);

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const strict = options.strict ?? process.env.GRAPHFLOW_AUDIT_STRICT === "1";

  return {
    command: "audit",
    baseline: {
      strategy: baseline.strategy,
      ...(baseline.ref !== undefined ? { ref: baseline.ref } : {}),
      changedFiles: baseline.changedFiles,
      note: baseline.note,
    },
    strict,
    findings,
    summary: {
      total: findings.length,
      errors,
      warnings,
      checkers: checkerSummaries,
    },
    ok: strict ? findings.length === 0 : errors === 0,
  };
}
