/**
 * agent-assignment.ts — 多 Agent 协作编排基础
 *
 * 基于任务描述关键词自动为 DAG 节点分配建议的 agent 专业领域（AgentSpecialty）。
 * 这是规划阶段的标注框架，不涉及真正的多 agent 执行，只标注建议的 agent 角色，
 * 供 executionDescriptor 携带，方便外部编排器 / 人工决策参考。
 */

import type { AgentSpecialty, TaskNode } from "./types";

/** 各专业领域的关键词匹配规则（小写匹配） */
const SPECIALTY_KEYWORDS: Record<Exclude<AgentSpecialty, "general">, string[]> = {
  testing: ["test", "testing", "spec", "vitest", "jest", "unit test", "e2e", "coverage"],
  frontend: ["ui", "component", "css", "style", "react", "vue", "dom", "layout", "render", "view"],
  backend: ["api", "server", "database", "model", "endpoint", "route", "service", "schema", "migration", "orm"],
  docs: ["doc", "readme", "changelog", "documentation", "guide", "tutorial", "wiki"],
};

/**
 * 根据任务描述推断建议的 agent 专业领域。
 *
 * 匹配优先级：testing > frontend > backend > docs > general。
 * 当多个领域都匹配时，取第一个命中的领域（按上述优先级顺序）。
 *
 * @param description 任务描述
 * @returns 建议的 AgentSpecialty
 */
export function inferAgentSpecialty(description: string): AgentSpecialty {
  const text = (description ?? "").toLowerCase();
  if (!text) {
    return "general";
  }

  const order: Exclude<AgentSpecialty, "general">[] = ["testing", "frontend", "backend", "docs"];
  for (const specialty of order) {
    const keywords = SPECIALTY_KEYWORDS[specialty];
    if (keywords.some((kw) => text.includes(kw))) {
      return specialty;
    }
  }

  return "general";
}

/**
 * 为 DAG 任务节点列表自动分配建议的 agent 专业领域。
 *
 * 该函数不修改原始节点对象，返回带有 assignedAgent 字段的新节点数组。
 * 如果节点已显式指定 assignedAgent，则保留原值不覆盖。
 *
 * @param nodes DAG 任务节点列表
 * @returns 标注了 assignedAgent 的新节点列表
 */
export function assignAgentsToTasks(nodes: TaskNode[]): TaskNode[] {
  return nodes.map((node) => {
    // 已显式指定的不覆盖
    if (node.assignedAgent) {
      return node;
    }
    const specialty = inferAgentSpecialty(node.description);
    return { ...node, assignedAgent: specialty };
  });
}

/**
 * 将任务节点列表转换为 executionDescriptor 使用的 agent 分配映射。
 *
 * @param nodes 已分配 agent 的任务节点列表
 * @returns agent 分配映射数组
 */
export function buildAgentAssignments(
  nodes: TaskNode[],
): Array<{ taskId: string; specialty: AgentSpecialty }> {
  return nodes
    .filter((node) => Boolean(node.assignedAgent))
    .map((node) => ({ taskId: node.id, specialty: node.assignedAgent! }));
}
