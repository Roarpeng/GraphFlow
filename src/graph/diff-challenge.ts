/**
 * diff-challenge.ts — 图 diff 质询清单（只提问、不执行测试的廉价质量门）
 *
 * agent 改完代码后，把 touchedFiles 交给本模块，GraphFlow 对照知识图谱生成
 * 一份"质询问题清单"交还 agent 自己回答。核心价值：图知道全量调用关系，
 * agent 不知道。
 *
 * U3 计划质询门：调用方也可传 planNodes（merge 产出的最终计划），模块从
 * description 提取文件/符号并入 touched 集合，让同一挑战链在执行前（而非改后）运行。
 *
 * 诚实边界：本模块不声称检测签名变更/行为回归，只陈述图上可证的事实——
 * 依赖的节点/边约定均来自仓库现有索引器：
 *   - File 节点 id = `file:{relPath}`，metadata.path = relPath（file-indexer-nodes.ts）
 *   - Symbol 节点 id = `symbol:{relPath}:{hash}`，metadata.name / metadata.file（file-indexer-nodes.ts）
 *   - defines: File → Symbol（file-indexer-nodes.ts）
 *   - references: 引用方 File → 被引用 Symbol；calls: 调用方 Symbol → 被调用 Symbol（file-indexer-edges.ts）
 *   - implements: 代码 Symbol/File → Requirement（document-semantic-ingest.ts / core/types.ts 注释）
 *   - Requirement 节点 id 前缀 `requirement:`，标题在 metadata.title、正文在 content
 *
 * 失败语义：异步失败 fail-open 返回空清单（质询门永远不应阻塞主流程）。
 */
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export interface PlanNodeDescriptor {
  /** 计划节点 id（TaskNode 结构兼容） */
  id: string;
  /** 计划节点描述文本——文件/符号提取的唯一来源 */
  description: string;
}

export interface ChallengeOptions {
  /** 本次改动的仓库相对路径（与图谱 relPath 同格式，支持反斜杠/`./` 前缀自动归一） */
  touchedFiles: string[];
  /**
   * 最终计划节点（merge 产出）：从 description 提取文件路径/符号，
   * 与 touchedFiles 合并去重后进入同一挑战生成链（U3 计划质询门）。
   */
  planNodes?: Array<PlanNodeDescriptor>;
  /** 截断上限，默认 20；超出置 truncated */
  maxChallenges?: number;
}

export type ChallengeKind = "external-caller" | "requirement-link" | "deleted-symbol";

export interface Challenge {
  kind: ChallengeKind;
  /** 直接可读的中文质询句 */
  question: string;
  evidence: {
    /** 被触碰的符号名 */
    symbol?: string;
    /** 本次改动的文件 */
    touchedFile: string;
    /** 未被触碰却相关联的文件 */
    externalFile?: string;
    /** Requirement 节点 id 或标题 */
    requirement?: string;
    /** 图边 relation */
    relation: string;
  };
}

export interface ChallengeList {
  challenges: Challenge[];
  total: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHALLENGES = 20;

/** 排序优先级：deleted-symbol > external-caller > requirement-link（潜在破坏面递减） */
const KIND_ORDER: Record<ChallengeKind, number> = {
  "deleted-symbol": 0,
  "external-caller": 1,
  "requirement-link": 2,
};

function emptyList(): ChallengeList {
  return { challenges: [], total: 0, truncated: false };
}

/** 归一为图谱使用的 POSIX 相对路径格式 */
function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * 计划描述的符号形状正则——与 src/learning/skill-admission.ts 的
 * PROJECT_SYMBOL_PATTERNS 等价（彼处未导出，故本地维护，改动需两侧同步）。
 * 提取用途的差异：camelCase 加了 `\b` 前缀（原模式用于形状检测，允许词中命中；
 * 提取时词中命中会截出 "raphFlow" 这类残片），另补 PascalCase（类名如 Foo）
 * 与单个首字母大写词（计划里 "refactor Foo in a.ts" 的 Foo）。
 */
const FILE_NAME_PATTERN = /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/gi;
const SLASH_PATH_PATTERN = /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/gi;
const CAMEL_CASE_PATTERN = /\b[a-z]+[A-Z][a-zA-Z0-9]*/g;
const SNAKE_CASE_PATTERN = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi;
const PASCAL_CASE_PATTERN = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const CAPITALIZED_WORD_PATTERN = /\b[A-Z][a-z0-9]{2,}\b/g;

/**
 * 从计划节点 description 提取被触及的文件与符号（纯函数，不查图）。
 * - files：带扩展名的文件名/路径（含 `src/core/x.ts`、反斜杠自动归一为 POSIX）
 * - symbols：camelCase / snake_case / PascalCase / 首字母大写词 / 无扩展名的路径式引用
 *   （如 `src/core`）。符号候选是超集——真正的过滤发生在挑战生成时对图的
 *   精确 name 匹配上，查不到的候选静默丢弃，绝不臆测。
 */
export function extractTouchedFromPlan(
  planNodes: ReadonlyArray<PlanNodeDescriptor>
): { files: string[]; symbols: string[] } {
  const files = new Set<string>();
  const symbols = new Set<string>();

  for (const node of planNodes ?? []) {
    const description = typeof node?.description === "string" ? node.description : "";
    if (!description) continue;
    // Windows 反斜杠路径先归一为 `/`，让 FILE/SLASH 模式可整段命中
    const text = description.replace(/\\/g, "/");

    for (const match of text.match(FILE_NAME_PATTERN) ?? []) {
      const normalized = normalizeRelPath(match);
      if (normalized.length > 0) files.add(normalized);
    }
    for (const match of text.match(SLASH_PATH_PATTERN) ?? []) {
      // 无扩展名的路径式引用（`src/core`）按符号候选处理；带扩展名的已被上面收集
      // （不用 FILE_NAME_PATTERN.test——全局正则有 lastIndex 状态，test 结果不可靠）
      if (!/\.[a-z0-9]{2,8}$/i.test(match)) symbols.add(match);
    }
    for (const pattern of [CAMEL_CASE_PATTERN, SNAKE_CASE_PATTERN, PASCAL_CASE_PATTERN, CAPITALIZED_WORD_PATTERN]) {
      for (const match of text.match(pattern) ?? []) symbols.add(match);
    }
  }

  // 剔除已是某文件路径片段的符号（如 "my_file.ts" 里的 "my_file"），避免双计
  for (const file of files) {
    for (const candidate of symbols) {
      if (file.includes(candidate)) symbols.delete(candidate);
    }
  }

  return { files: Array.from(files), symbols: Array.from(symbols) };
}

function metaString(node: GraphNode, key: string): string | undefined {
  const raw = node.metadata?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** 路径型 metadata（file/path）额外做 POSIX 归一 */
function metaPath(node: GraphNode, key: string): string | undefined {
  const raw = metaString(node, key);
  return raw ? normalizeRelPath(raw) : undefined;
}

/** Symbol 节点 → 其所属文件（metadata.file，兜底解析 id 前缀 `symbol:{relPath}:{hash}`） */
function fileOfSymbol(node: GraphNode): string | undefined {
  const fromMeta = metaPath(node, "file");
  if (fromMeta) return fromMeta;
  if (node.id.startsWith("symbol:")) {
    const rest = node.id.slice("symbol:".length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) return normalizeRelPath(rest.slice(0, lastColon));
  }
  return undefined;
}

/** File 节点 → 其路径（metadata.path，兜底剥掉 id 的 `file:` 前缀） */
function pathOfFileNode(node: GraphNode): string | undefined {
  const fromMeta = metaPath(node, "path");
  if (fromMeta) return fromMeta;
  if (node.id.startsWith("file:")) return normalizeRelPath(node.id.slice("file:".length));
  return undefined;
}

function symbolName(node: GraphNode): string | undefined {
  const raw = node.metadata?.["name"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function isRequirement(node: GraphNode): boolean {
  return node.type === "Requirement" || node.id.startsWith("requirement:");
}

/** Requirement 展示标题：metadata.title → content 首个非空行（截断保证可读） */
function requirementTitle(node: GraphNode): string {
  const title = metaString(node, "title");
  if (title) return title;
  const firstLine = node.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return node.id;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/** 精确取节点：优先 getNodesByIds，未命中退回关键字查询后按 id 精确匹配（同 engineering-knowledge.loadNode） */
async function findNodeById(client: GraphClient, id: string): Promise<GraphNode | undefined> {
  if (client.getNodesByIds) {
    const direct = (await client.getNodesByIds([id])).find((n) => n.id === id);
    if (direct) return direct;
  }
  return (await client.queryByKeyword(id)).find((n) => n.id === id);
}

/** 方向感知的邻居查询；client 未实现 getNeighbors 时返回空（宁缺毋滥，不臆测边） */
async function neighbors(
  client: GraphClient,
  nodeIds: string[],
  relations: GraphEdge["relation"][],
  direction: "out" | "in"
): Promise<Array<{ node: GraphNode; via: GraphEdge["relation"] }>> {
  if (!client.getNeighbors) return [];
  return client.getNeighbors(nodeIds, relations, direction);
}

export async function buildChallengeList(
  client: GraphClient,
  options: ChallengeOptions
): Promise<ChallengeList> {
  const touched = Array.from(
    new Set((options.touchedFiles ?? []).map(normalizeRelPath).filter((p) => p.length > 0))
  );
  const rawMax = options.maxChallenges;
  const max =
    typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.max(0, Math.floor(rawMax))
      : DEFAULT_MAX_CHALLENGES;
  const touchedSet = new Set(touched);

  try {
    // —— U3 计划质询门：从 planNodes 提取文件/符号，与 touchedFiles 合并去重。
    //    文件直接并入；符号经图精确解析（Symbol 且 metadata.name 完全相等）落到
    //    所属文件后并入——查不到的候选静默丢弃，绝不臆测。
    const planNodes = options.planNodes ?? [];
    if (planNodes.length > 0) {
      const planTouched = extractTouchedFromPlan(planNodes);
      for (const file of planTouched.files) {
        if (file.length > 0) touchedSet.add(file);
      }
      for (const symbol of planTouched.symbols) {
        const hits = (await client.queryByKeyword(symbol)).filter(
          (node) => node.type === "Symbol" && symbolName(node) === symbol
        );
        for (const hit of hits) {
          const file = fileOfSymbol(hit);
          if (file) touchedSet.add(file);
        }
      }
    }
    if (touchedSet.size === 0) return emptyList();

    const challenges: Challenge[] = [];
    const seen = new Set<string>();
    const push = (challenge: Challenge): void => {
      const key = [
        challenge.kind,
        challenge.evidence.touchedFile,
        challenge.evidence.relation,
        challenge.evidence.symbol ?? "",
        challenge.evidence.externalFile ?? "",
        challenge.evidence.requirement ?? "",
      ].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      challenges.push(challenge);
    };

    for (const relPath of touchedSet) {
      const fileId = `file:${relPath}`;
      const fileNode = await findNodeById(client, fileId);

      // —— deleted-symbol：touched 文件在图中无 File 节点（可能已删除/重命名），
      //    但仍能查到 id 形如 `symbol:{relPath}:` 的残留符号节点，且其符号仍被
      //    外部（非 touched）文件引用/调用。图上无痕迹则不产出，绝不臆测。
      if (!fileNode) {
        const orphanSymbols = (await client.queryByKeyword(relPath)).filter(
          (n) => n.type === "Symbol" && n.id.startsWith(`symbol:${relPath}:`)
        );
        for (const sym of orphanSymbols) {
          const name = symbolName(sym);
          for (const { node: caller, via } of await neighbors(client, [sym.id], ["calls", "references"], "in")) {
            const externalFile =
              caller.type === "File" ? pathOfFileNode(caller) : fileOfSymbol(caller);
            if (!externalFile || touchedSet.has(externalFile)) continue;
            push({
              kind: "deleted-symbol",
              question: `file:${relPath} 不在图中（可能已删除或重命名），其符号 ${name ?? sym.id} 仍被 file:${externalFile} ${via === "calls" ? "调用" : "引用"}——外部调用方是否需要更新？`,
              evidence: {
                touchedFile: relPath,
                relation: via,
                externalFile,
                ...(name ? { symbol: name } : {}),
              },
            });
          }
        }
        continue;
      }

      // 文件在图中：取其 defines 的符号（File → Symbol 出边）
      const defined = (await neighbors(client, [fileId], ["defines"], "out"))
        .map((item) => item.node)
        .filter((n) => n.type === "Symbol");

      // —— external-caller：touched 文件 defines 的符号，被不在 touched 集合的
      //    文件中的符号 calls / 被 untouched 文件 references（入边）。
      for (const sym of defined) {
        const name = symbolName(sym);
        for (const { node: caller, via } of await neighbors(client, [sym.id], ["calls", "references"], "in")) {
          let externalFile: string | undefined;
          let callerSymbol: string | undefined;
          if (caller.type === "File") {
            externalFile = pathOfFileNode(caller);
          } else {
            externalFile = fileOfSymbol(caller);
            callerSymbol = symbolName(caller);
          }
          if (!externalFile || touchedSet.has(externalFile)) continue;
          const callerDesc = callerSymbol
            ? `file:${externalFile} 的符号 ${callerSymbol}`
            : `file:${externalFile}`;
          const verb = via === "calls" ? "仍在调用它" : "仍在引用它";
          push({
            kind: "external-caller",
            question: `本次改动触及 file:${relPath} 的符号 ${name ?? sym.id}，${callerDesc} ${verb}——已验证兼容吗？`,
            evidence: {
              touchedFile: relPath,
              relation: via,
              externalFile,
              ...(name ? { symbol: name } : {}),
            },
          });
        }
      }

      // —— requirement-link：implements 边方向为 代码(Symbol/File) → Requirement，
      //    故从 touched 符号与 File 节点的出边找 Requirement（方向自查自证）。
      const requirementHits: Array<{ node: GraphNode; symbol?: string }> = [];
      for (const sym of defined) {
        const name = symbolName(sym);
        for (const { node: req } of await neighbors(client, [sym.id], ["implements"], "out")) {
          if (!isRequirement(req)) continue;
          requirementHits.push({ node: req, ...(name ? { symbol: name } : {}) });
        }
      }
      for (const { node: req } of await neighbors(client, [fileId], ["implements"], "out")) {
        if (!isRequirement(req)) continue;
        requirementHits.push({ node: req });
      }
      for (const hit of requirementHits) {
        const title = requirementTitle(hit.node);
        const symClause = hit.symbol ? `（符号 ${hit.symbol}）` : "";
        push({
          kind: "requirement-link",
          question: `Requirement ${title} 的实现${symClause}被本次改动触及——该需求仍然满足吗？`,
          evidence: {
            touchedFile: relPath,
            relation: "implements",
            requirement: title,
            ...(hit.symbol ? { symbol: hit.symbol } : {}),
          },
        });
      }
    }

    const sorted = challenges.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const total = sorted.length;
    const kept = sorted.slice(0, max);
    return { challenges: kept, total, truncated: total > kept.length };
  } catch {
    // fail-open：质询清单永远不应因图查询失败而阻塞调用方
    return emptyList();
  }
}
