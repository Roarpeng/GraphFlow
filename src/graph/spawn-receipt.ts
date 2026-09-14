/**
 * Spawn receipt（subagent 出生证）。
 *
 * 多 agent 协作时，父 agent 不把大段背景文本复制给每个 subagent（同样材料抄 N 遍是
 * token 复利浪费），而是签发一张紧凑收据：任务描述 + 图锚点引用 + 取回指令。
 * subagent 拿着几百 token 的收据，用 graphflow_context 按需展开自己真正需要的部分。
 */

import type { GraphClient } from "./client-factory";
import type { GraphNode } from "../core/types";

export interface SpawnReceiptOptions {
  /** 交给 subagent 的任务描述（必填，会原文出现在收据里）。 */
  task: string;
  /** 召回锚点用的检索词；缺省用 task 文本分词。 */
  query?: string;
  /** 收据锚点上限，默认 6。 */
  maxAnchors?: number;
}

export interface SpawnAnchor {
  /**
   * 锚点 id 直接复用图谱节点 id，即本仓库既有的锚点外观约定：
   * File → `file:<path>`，Symbol → `symbol:<file>:<hash>`，
   * Concept/Requirement → 语义节点 id 前缀。该格式与 graphflow_context
   * 的 anchorId 入参一致，故不引入 `graphflow://node/<id>` 之类的新格式。
   */
  id: string;
  kind: "symbol" | "file" | "knowledge";
  label: string;
}

export interface SpawnReceipt {
  task: string;
  /** 按 query 关键词召回的相关节点锚点，去重后截断到 maxAnchors（默认 6）。 */
  anchors: SpawnAnchor[];
  /** 给 subagent 的取回指令（固定中文模板）。 */
  instructions: string;
  /** 收据序列化文本 length/4 的诚实估算（不含本字段自身的自引用）。 */
  estimatedReceiptTokens: number;
}

/** 默认锚点上限。 */
const DEFAULT_MAX_ANCHORS = 6;

/** 中英文停用词（分词后过滤，避免无意义关键词浪费召回次数）。 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is",
  "are", "at", "by", "from", "that", "this", "it", "as", "be", "was", "were",
  "的", "了", "和", "是", "在", "与", "及", "或", "中", "对", "从", "被", "把",
  "请", "需要", "一个", "这个", "以及", "使用", "进行",
]);

const INSTRUCTIONS_WITH_ANCHORS = [
  "你是从一张出生证（spawn receipt）启动的 subagent：本收据即你的全部背景，父会话未向你复制任何大段材料。",
  "anchors 是父 agent 预召回的图节点引用（id 复用仓库锚点格式，如 symbol:file:hash），仅是索引而非内容。",
  "取回方式：调用 graphflow_context，传入 query（自然语言检索）或 anchorId（锚点 id）即可按需展开对应节点的压缩上下文。",
  "只展开当前任务真正需要的锚点，不要一次性全部展开——按需取回正是出生证机制省 token 的关键。",
  "结论回写时请引用你实际依据的锚点 id，便于父 agent 校验与归档。",
].join("\n");

const INSTRUCTIONS_EMPTY = [
  "你是从一张出生证（spawn receipt）启动的 subagent：本收据即你的全部背景，父会话未向你复制任何大段材料。",
  "本次未召回到任何预置锚点（anchors 为空）：请用 graphflow_context 传 query 关键词自行探索图谱。",
  "结论回写时请说明你依据的节点 id 或文件位置，便于父 agent 校验与归档。",
].join("\n");

/** 分词：按空白与常见中西文标点切分，小写化，去停用词。 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。;；]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** 节点 → 出生证锚点；不属于 symbol/file/knowledge 三类的节点返回 null（过滤掉）。 */
function toSpawnAnchor(node: GraphNode): SpawnAnchor | null {
  let kind: SpawnAnchor["kind"];
  if (node.type === "Symbol") {
    kind = "symbol";
  } else if (node.type === "File") {
    kind = "file";
  } else if (node.type === "Concept" || node.type === "Requirement") {
    kind = "knowledge";
  } else {
    return null;
  }
  return { id: node.id, kind, label: labelOf(node) };
}

/** label 取节点名（metadata.name），否则取 content 前 60 字符（折叠空白）。 */
function labelOf(node: GraphNode): string {
  const metaName = node.metadata?.name;
  if (typeof metaName === "string" && metaName.length > 0) {
    return metaName;
  }
  return node.content.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** 收据序列化（不含 estimatedReceiptTokens，避免自引用）。 */
function serializeReceiptPayload(receipt: Omit<SpawnReceipt, "estimatedReceiptTokens">): string {
  return JSON.stringify(receipt);
}

/**
 * 签发一张 subagent 出生证。
 *
 * 召回流程：query（缺省用 task 文本）分词 → 逐词 queryByKeyword → 按 id 合并去重
 * → 过滤出 Symbol/File/Concept/Requirement 四类节点映射为锚点 → 截断 maxAnchors。
 * 图查询异步失败时 fail-open：返回空锚点收据（instructions 仍生成，提示自行探索）。
 */
export async function issueSpawnReceipt(
  client: GraphClient,
  options: SpawnReceiptOptions
): Promise<SpawnReceipt> {
  const maxAnchors = Math.max(0, options.maxAnchors ?? DEFAULT_MAX_ANCHORS);
  const tokens = Array.from(new Set(tokenize(options.query ?? options.task)));

  let anchors: SpawnAnchor[] = [];
  if (tokens.length > 0) {
    try {
      const seen = new Set<string>();
      const collected: SpawnAnchor[] = [];
      for (const token of tokens) {
        const nodes = await client.queryByKeyword(token);
        for (const node of nodes) {
          if (seen.has(node.id)) continue;
          seen.add(node.id);
          const anchor = toSpawnAnchor(node);
          if (anchor) collected.push(anchor);
        }
      }
      anchors = collected.slice(0, maxAnchors);
    } catch {
      // fail-open：图查询失败不阻塞签发，返回空锚点收据。
      anchors = [];
    }
  }

  const receipt = {
    task: options.task,
    anchors,
    instructions: anchors.length > 0 ? INSTRUCTIONS_WITH_ANCHORS : INSTRUCTIONS_EMPTY,
  };
  return { ...receipt, estimatedReceiptTokens: Math.max(1, Math.ceil(serializeReceiptPayload(receipt).length / 4)) };
}
