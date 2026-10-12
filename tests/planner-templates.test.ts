import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, planTasks } from "../src/agents/planner";
import { classifyTaskTemplate } from "../src/agents/task-clauses";
import type { ModelSelection } from "../src/routing/model-router";
import type { RetrievedEpisode } from "../src/agents/episode-retrieval";

/**
 * Task-profile template routing in the heuristic planner + episode injection
 * into the LLM planner prompt.
 */

const SELECTION: ModelSelection = {
  provider: "openai",
  model: "gpt-test",
  tier: "economy",
  fallbackApplied: false,
};

describe("classifyTaskTemplate", () => {
  it("routes research, bugfix and default tasks", () => {
    expect(classifyTaskTemplate("调研 tokenizer 缓存策略")).toBe("research");
    expect(classifyTaskTemplate("analyze the retrieval ranking pipeline")).toBe("research");
    expect(classifyTaskTemplate("investigate flaky vitest timers")).toBe("research");
    expect(classifyTaskTemplate("fix the crash in cost ledger export")).toBe("bugfix");
    expect(classifyTaskTemplate("修复报错：规划器中文任务崩溃")).toBe("bugfix");
    expect(classifyTaskTemplate("add a dark mode toggle to the settings page")).toBe("default");
    // Research wins when both profiles match.
    expect(classifyTaskTemplate("分析并修复 sqlite 报错")).toBe("research");
    expect(classifyTaskTemplate("")).toBe("default");
  });
});

describe("planTasks template routing", () => {
  it("routes a research task to the 2-node analysis template without an implementation node", () => {
    const plan = planTasks("调研 planner 的上下文压缩方案");

    expect(plan.map((node) => node.id)).toEqual(["task-1", "task-2"]);
    expect(plan[0]?.description).toContain("分析与综合");
    expect(plan[0]?.description).toContain("调研 planner 的上下文压缩方案");
    expect(plan[1]?.description).toContain("验证与引用核对");
    expect(plan[1]?.dependencies).toEqual(["task-1"]);
    expect(plan[0]?.dependencies).toEqual([]);
    expect(plan.some((node) => node.description.startsWith("实现"))).toBe(false);
  });

  it("keeps skill hints on the research template", () => {
    const plan = planTasks("analyze the graph compression layer", ["skill:graph-rank"]);

    expect(plan).toHaveLength(2);
    for (const node of plan) {
      expect(node.skillRefs).toEqual(["skill:graph-rank"]);
      expect(node.description).toContain("use skills: skill:graph-rank");
    }
  });

  it("routes a bugfix task to the linear reproduce → fix → regression chain", () => {
    const plan = planTasks("fix the crash in the cost ledger export");

    expect(plan.map((node) => node.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(plan[0]?.description).toContain("复现与定位");
    expect(plan[1]?.description).toContain("修复实现");
    expect(plan[2]?.description).toContain("回归验证");
    expect(plan[0]?.dependencies).toEqual([]);
    expect(plan[1]?.dependencies).toEqual(["task-1"]);
    expect(plan[2]?.dependencies).toEqual(["task-2"]);
  });

  it("keeps the original 4-node pipeline for plain feature tasks", () => {
    const plan = planTasks("add a dark mode toggle to the settings page");

    expect(plan.map((node) => node.id)).toEqual(["task-1", "task-2", "task-2b", "task-3"]);
    expect(plan[0]?.description).toContain("分析与设计");
    expect(plan[3]?.dependencies).toEqual(["task-2", "task-2b"]);
  });

  it("keeps multi-clause splitting authoritative regardless of profile words", () => {
    const plan = planTasks("fix the login crash and update readme");

    expect(plan.map((node) => node.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(plan[0]?.dependencies).toEqual([]);
    expect(plan[1]?.dependencies).toEqual([]);
    expect(plan[2]?.dependencies).toEqual(["task-1", "task-2"]);
  });
});

describe("buildPlannerPrompt episode injection", () => {
  const episodes: RetrievedEpisode[] = [
    {
      episodeId: "episode:aaa",
      taskPreview: "fix crash in sqlite client on windows",
      success: true,
      lessons: ["close sqlite handles before unlinking", "x".repeat(300)],
      deviation: "none",
      relatedSymbols: ["symbol:sqlite-client"],
      similarity: 0.8,
    },
    {
      episodeId: "episode:bbb",
      taskPreview: "migrate store to sqlite",
      success: false,
      lessons: ["a", "b", "c", "d"],
      relatedSymbols: [],
      similarity: 0.4,
    },
  ];

  it("renders a compact past-episodes section with outcome, deviation and lessons", () => {
    const prompt = buildPlannerPrompt("fix crash in sqlite client", { selection: SELECTION, episodes });

    expect(prompt).toContain("Past episodes");
    expect(prompt).toContain("[outcome=pass, deviation=none] task: fix crash in sqlite client on windows");
    expect(prompt).toContain("[outcome=fail] task: migrate store to sqlite");
    expect(prompt).toContain("lesson: close sqlite handles before unlinking");
    // Long lessons truncate to ~200 chars.
    const longLesson = prompt
      .split("\n")
      .find((line) => line.includes("x".repeat(50)));
    expect(longLesson === undefined ? "" : longLesson.length).toBeLessThanOrEqual(200 + "  lesson: ".length + 3);
    // At most 3 lessons per episode: the 4th lesson of episode:bbb never lands.
    expect(prompt).not.toContain("lesson: d");
  });

  it("omits the section when no episodes are provided (heuristic callers unaffected)", () => {
    const prompt = buildPlannerPrompt("add a dark mode toggle", { selection: SELECTION });
    expect(prompt).not.toContain("Past episodes");
    expect(prompt).toContain("Task: add a dark mode toggle");
  });
});
