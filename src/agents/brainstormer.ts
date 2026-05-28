export function brainstormTask(task: string): string[] {
  const normalized = task.trim();
  if (!normalized) {
    return ["澄清目标: 任务描述不能为空"];
  }

  const clauses = normalized
    .split(/\band\b|,|;/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const focus = clauses.slice(0, 3);
  const ideas = [
    `目标澄清: 明确要完成 ${focus.join("、")}`,
    `实现路径: 先拆分子任务并并行推进，再做集成校验`,
    `风险提示: 重点关注跨文件依赖和回归影响`,
  ];

  return ideas;
}
