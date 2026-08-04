/**
 * skill-package.ts — 技能包导入 / 导出（双向 MERGE）
 *
 * 将图存储中所有 Skill 类型节点导出为可移植的 JSON 技能包，
 * 方便团队共享与跨工作区迁移。导入采用双向 MERGE（而非覆盖）。
 *
 * 技能包格式：
 * ```json
 * {
 *   "version": "1.1",
 *   "exportedAt": "2026-01-01T00:00:00.000Z",
 *   "skills": [ { "id": "skill:...", "type": "Skill", "content": "...", "metadata": {} } ],
 *   "goldenQueries": [ "自然语言检索查询 ..." ]
 * }
 * ```
 *
 * 冲突策略（import，默认 / 未带 --force 时）：
 *  - 按技能 id 取并集（per-skill-id union）。
 *  - 同 id 冲突时 `updatedAt` 较新者胜（incoming.updatedAt > local.updatedAt 才覆盖）。
 *  - `updatedAt` 相同（并列）保留本地，不回写。
 *  - 仅本地存在的技能一律保留；仅包中存在的技能导入。
 *  - `--force` 恢复覆盖（overwrite）语义：包中所有技能无条件写入本地。
 *
 * goldenQueries（团队 golden 检索基准集，随包传递）：
 *  - export：把 canonical 查询列表打包进 `goldenQueries` 字段。
 *  - import：把包内查询合并进本地集合（按查询文本去重、本地优先排序），
 *    写入 `.graphflow/team-golden.json` 旁车文件（绝不写回测试文件）。
 *
 * 设计参考 src/graph/artifact-manager.ts 的导入/导出模式。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger";
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { parseSkillState, parseCompositeState, serializeAtomic, serializeComposite } from "./skill-store";
import type { SkillProvenance } from "./skill-types";

/** 技能包版本（v1.1 起携带 goldenQueries 与 MERGE 导入语义） */
const SKILL_PACKAGE_VERSION = "1.1" as const;

/** 技能节点（即 Skill 类型的 GraphNode） */
export type SkillNode = GraphNode;

/** 技能包格式 */
export interface SkillPackage {
  version: "1.1";
  exportedAt: string;
  skills: SkillNode[];
  /** 团队 golden 检索基准查询（查询文本列表） */
  goldenQueries?: string[];
}

/** 导出选项 */
export interface SkillExportOptions {
  /** 打包进技能包的 golden 查询列表 */
  goldenQueries?: string[];
}

/** 导入选项 */
export interface SkillImportOptions {
  /** 恢复覆盖语义：包中技能无条件写入，golden 查询整组覆盖旁车文件 */
  force?: boolean;
  /** golden 旁车文件路径（.graphflow/team-golden.json） */
  goldenPath?: string;
}

/** 导出结果 */
export interface SkillExportResult {
  path: string;
  skillCount: number;
  bytes: number;
  /** 打包的 golden 查询数（未打包时省略） */
  goldenQueries?: number;
}

/** 导入结果 */
export interface SkillImportResult {
  path: string;
  imported: number;
  skipped: number;
  /** 冲突中 updatedAt 较新者胜、覆盖了本地版本的条数（计入 imported） */
  updated: number;
  total: number;
  /** 合并后写入的 golden 旁车文件路径（技能包携带 goldenQueries 时） */
  goldenPath?: string;
  /** 合并后的 golden 查询数 */
  goldenQueries?: number;
}

/**
 * 读取技能节点的 updatedAt（epoch ms）。
 * 优先从 content JSON（SkillState.updatedAt）解析，回退到 metadata.updatedAt。
 */
function skillUpdatedAt(node: SkillNode): number {
  try {
    const parsed = JSON.parse(node.content) as { updatedAt?: unknown };
    if (typeof parsed.updatedAt === "number") {
      return parsed.updatedAt;
    }
  } catch {
    // content 非 JSON，尝试 metadata
  }
  const meta = node.metadata?.updatedAt;
  return typeof meta === "number" ? meta : 0;
}

/**
 * 记忆投毒防护（P1-3）：外部来源（sync/import）技能入库门禁。
 *
 * 1. 标记 provenance.source = "sync"（携带来源仓库/时间；包内自带
 *    provenance 时保留 originRepo/episodeId，source 强制为 sync）。
 * 2. 初始分类不得直接为 proven（也不得携带 anti-pattern 的负分历史）：
 *    外部技能一律从 correctable 起步，清零 uses/linkedSuccess/failStreak
 *    与分数，必须经本地成功使用（applySkillLearning 晋升路径）才可成为 proven。
 * 3. 无法解析的 content 仅透传（结构校验在上层），不阻断导入。
 */
function markExternalSkillNode(node: SkillNode, originRepo?: string): SkillNode {
  const capturedAt = new Date().toISOString();

  const atomic = parseSkillState(node.content);
  if (atomic) {
    const provenance: SkillProvenance = {
      source: "sync",
      capturedAt,
      ...(originRepo ? { originRepo } : {}),
      ...(atomic.provenance?.episodeId ? { episodeId: atomic.provenance.episodeId } : {}),
    };
    const sanitized = serializeAtomic({
      ...atomic,
      // 外部技能不得携带本地策划基线豁免（seeded 直接判定 proven）。
      seeded: false,
      uses: 0,
      score: 0,
      failStreak: 0,
      linkedSuccess: false,
      lastOutcome: "pass",
      outcomeKind: "correctable",
      provenance,
    });
    return { ...node, content: sanitized };
  }

  const composite = parseCompositeState(node.content);
  if (composite) {
    const provenance: SkillProvenance = {
      source: "sync",
      capturedAt,
      ...(originRepo ? { originRepo } : {}),
      ...(composite.provenance?.episodeId ? { episodeId: composite.provenance.episodeId } : {}),
    };
    const sanitized = serializeComposite({
      ...composite,
      seeded: false,
      coOccurCount: 0,
      successCount: 0,
      failureCount: 0,
      score: 0,
      uses: 0,
      lastOutcome: "pass",
      outcomeKind: "correctable",
      provenance,
    });
    return { ...node, content: sanitized };
  }

  return node;
}

/** 从技能包元数据提取来源仓库标识（尽力而为，缺失时不携带）。 */
function packageOriginRepo(pkg: SkillPackage): string | undefined {
  const raw = (pkg as { originRepo?: unknown; source?: unknown }).originRepo;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  const source = (pkg as { source?: unknown }).source;
  if (typeof source === "string" && source.trim()) {
    return source.trim();
  }
  return undefined;
}

/**
 * 合并 golden 查询：本地优先（保序），按查询文本精确去重，再追加包内新查询。
 */
function mergeGoldenQueries(local: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const query of [...local, ...incoming]) {
    if (typeof query !== "string" || query.trim() === "") {
      continue;
    }
    if (!seen.has(query)) {
      seen.add(query);
      merged.push(query);
    }
  }
  return merged;
}

/** 读取 golden 旁车文件，非法/缺失时返回空列表。 */
function readGoldenQueries(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((q): q is string => typeof q === "string");
    }
  } catch {
    // 旁车文件缺失或损坏 → 视为空本地集合
  }
  return [];
}

/**
 * 导出所有 Skill 类型节点为 JSON 技能包。
 *
 * @param graphClient 图存储客户端
 * @param outputPath 输出文件路径
 * @param opts 导出选项（可携带 goldenQueries）
 */
export async function exportSkillPackage(
  graphClient: GraphClient,
  outputPath: string,
  opts?: SkillExportOptions,
): Promise<SkillExportResult> {
  // 收集所有 Skill 类型节点
  let skills: SkillNode[] = [];
  if (graphClient.readSnapshot) {
    const snapshot = graphClient.readSnapshot();
    skills = snapshot.nodes.filter((n) => n.type === "Skill");
  } else {
    // 降级：当图存储不支持 readSnapshot 时，尝试通过 queryByKeyword 检索
    const hits = await graphClient.queryByKeyword("skill");
    skills = hits.filter((n) => n.type === "Skill");
  }

  const goldenQueries = opts?.goldenQueries?.filter((q) => typeof q === "string") ?? [];
  const pkg: SkillPackage = {
    version: SKILL_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    skills,
    ...(goldenQueries.length > 0 ? { goldenQueries } : {}),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  const json = JSON.stringify(pkg, null, 2);
  writeFileSync(outputPath, json, "utf8");
  const bytes = statSync(outputPath).size;

  logger.info(
    { path: outputPath, skillCount: skills.length, bytes, goldenQueries: goldenQueries.length },
    "技能包导出完成",
  );

  const result: SkillExportResult = { path: outputPath, skillCount: skills.length, bytes };
  if (goldenQueries.length > 0) {
    result.goldenQueries = goldenQueries.length;
  }
  return result;
}

/**
 * 导入技能包（双向 MERGE）。
 *
 * 冲突策略见文件头注释：per-skill-id union、updatedAt 较新者胜、
 * 并列保留本地、本地独有技能保留；`opts.force` 恢复覆盖语义。
 * 技能包携带 goldenQueries 时，合并进本地集合并写入 goldenPath 旁车文件。
 *
 * @param graphClient 图存储客户端
 * @param inputPath 输入文件路径
 * @param opts 导入选项（force / goldenPath）
 */
export async function importSkillPackage(
  graphClient: GraphClient,
  inputPath: string,
  opts?: SkillImportOptions,
): Promise<SkillImportResult> {
  if (!existsSync(inputPath)) {
    throw new Error(`技能包文件不存在: ${inputPath}`);
  }

  const raw = readFileSync(inputPath, "utf8");
  let pkg: SkillPackage;
  try {
    pkg = JSON.parse(raw) as SkillPackage;
  } catch {
    throw new Error(`技能包解析失败: ${inputPath}`);
  }

  if (pkg.version !== SKILL_PACKAGE_VERSION) {
    logger.warn(
      { expected: SKILL_PACKAGE_VERSION, got: pkg.version },
      "技能包版本不匹配，仍尝试导入",
    );
  }

  const skills = Array.isArray(pkg.skills) ? pkg.skills : [];

  // 收集本地 Skill 节点（按 id），用于并集合并
  const localById = new Map<string, SkillNode>();
  if (graphClient.readSnapshot) {
    const snapshot = graphClient.readSnapshot();
    for (const node of snapshot.nodes) {
      if (node.type === "Skill") {
        localById.set(node.id, node);
      }
    }
  }

  const force = opts?.force === true;
  const originRepo = packageOriginRepo(pkg);
  const toImport: SkillNode[] = [];
  let skipped = 0;
  let updated = 0;
  for (const skill of skills) {
    // 校验技能节点结构
    if (!skill || typeof skill.id !== "string" || skill.type !== "Skill") {
      skipped += 1;
      continue;
    }
    // 记忆投毒防护：外部技能一律标记 sync 来源并从 correctable 起步。
    const external = markExternalSkillNode(skill, originRepo);
    const local = localById.get(skill.id);
    if (!local) {
      toImport.push(external);
      localById.set(skill.id, external);
      continue;
    }
    if (force) {
      // --force：覆盖语义，无条件写入
      toImport.push(external);
      localById.set(skill.id, external);
      continue;
    }
    // MERGE：updatedAt 较新者胜；并列或较旧保留本地
    if (skillUpdatedAt(skill) > skillUpdatedAt(local)) {
      toImport.push(external);
      updated += 1;
      localById.set(skill.id, external);
    } else {
      skipped += 1;
    }
  }

  if (toImport.length > 0 && graphClient.upsertNodes) {
    await graphClient.upsertNodes(toImport);
  }

  // golden 查询合并 → 旁车文件（本地优先、按文本去重；force 整组覆盖）
  let goldenPathWritten: string | undefined;
  let goldenQueriesCount: number | undefined;
  if (Array.isArray(pkg.goldenQueries) && opts?.goldenPath) {
    const incomingQueries = pkg.goldenQueries.filter((q) => typeof q === "string");
    const localQueries = force ? [] : readGoldenQueries(opts.goldenPath);
    const merged = force ? incomingQueries : mergeGoldenQueries(localQueries, incomingQueries);
    mkdirSync(dirname(opts.goldenPath), { recursive: true });
    writeFileSync(opts.goldenPath, JSON.stringify(merged, null, 2), "utf8");
    goldenPathWritten = opts.goldenPath;
    goldenQueriesCount = merged.length;
  }

  logger.info(
    { path: inputPath, imported: toImport.length, skipped, updated, total: skills.length },
    "技能包导入完成",
  );

  const result: SkillImportResult = {
    path: inputPath,
    imported: toImport.length,
    skipped,
    updated,
    total: skills.length,
  };
  if (goldenPathWritten !== undefined && goldenQueriesCount !== undefined) {
    result.goldenPath = goldenPathWritten;
    result.goldenQueries = goldenQueriesCount;
  }
  return result;
}
