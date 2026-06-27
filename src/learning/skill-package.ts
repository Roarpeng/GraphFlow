/**
 * skill-package.ts — 技能包导入 / 导出
 *
 * 将图存储中所有 Skill 类型节点导出为可移植的 JSON 技能包，
 * 方便团队共享与跨工作区迁移。导入时自动跳过已存在的技能，避免覆盖。
 *
 * 技能包格式：
 * ```json
 * {
 *   "version": "1.0",
 *   "exportedAt": "2026-01-01T00:00:00.000Z",
 *   "skills": [ { "id": "skill:...", "type": "Skill", "content": "...", "metadata": {} } ]
 * }
 * ```
 *
 * 设计参考 src/graph/artifact-manager.ts 的导入/导出模式。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger";
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

/** 技能包版本 */
const SKILL_PACKAGE_VERSION = "1.0" as const;

/** 技能节点（即 Skill 类型的 GraphNode） */
export type SkillNode = GraphNode;

/** 技能包格式 */
export interface SkillPackage {
  version: "1.0";
  exportedAt: string;
  skills: SkillNode[];
}

/** 导出结果 */
export interface SkillExportResult {
  path: string;
  skillCount: number;
  bytes: number;
}

/** 导入结果 */
export interface SkillImportResult {
  path: string;
  imported: number;
  skipped: number;
  total: number;
}

/**
 * 导出所有 Skill 类型节点为 JSON 技能包。
 *
 * @param graphClient 图存储客户端
 * @param outputPath 输出文件路径
 */
export async function exportSkillPackage(
  graphClient: GraphClient,
  outputPath: string,
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

  const pkg: SkillPackage = {
    version: SKILL_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    skills,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  const json = JSON.stringify(pkg, null, 2);
  writeFileSync(outputPath, json, "utf8");
  const bytes = statSync(outputPath).size;

  logger.info(
    { path: outputPath, skillCount: skills.length, bytes },
    "技能包导出完成",
  );

  return { path: outputPath, skillCount: skills.length, bytes };
}

/**
 * 导入技能包，跳过已存在的技能。
 *
 * @param graphClient 图存储客户端
 * @param inputPath 输入文件路径
 */
export async function importSkillPackage(
  graphClient: GraphClient,
  inputPath: string,
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

  // 收集已存在的技能 id，跳过重复导入（避免覆盖本地演化数据）
  const existingIds = new Set<string>();
  if (graphClient.readSnapshot) {
    const snapshot = graphClient.readSnapshot();
    for (const node of snapshot.nodes) {
      if (node.type === "Skill") {
        existingIds.add(node.id);
      }
    }
  }

  const toImport: SkillNode[] = [];
  let skipped = 0;
  for (const skill of skills) {
    // 校验技能节点结构
    if (!skill || typeof skill.id !== "string" || skill.type !== "Skill") {
      skipped += 1;
      continue;
    }
    if (existingIds.has(skill.id)) {
      skipped += 1;
      continue;
    }
    toImport.push(skill);
    existingIds.add(skill.id); // 防止技能包内重复 id 被多次导入
  }

  if (toImport.length > 0 && graphClient.upsertNodes) {
    await graphClient.upsertNodes(toImport);
  }

  logger.info(
    { path: inputPath, imported: toImport.length, skipped, total: skills.length },
    "技能包导入完成",
  );

  return {
    path: inputPath,
    imported: toImport.length,
    skipped,
    total: skills.length,
  };
}
