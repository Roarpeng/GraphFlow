import { describe, expect, it } from "vitest";
import {
  buildGraphSnapshotHtml,
  buildSkillInsightsHtml,
} from "../vscode-extension/src/panels";

describe("M15 VS Code observability panels", () => {
  it("renders graph snapshot controls for search, type filters, and node focus", () => {
    const html = buildGraphSnapshotHtml({
      transport: "file",
      storePath: "tmp/graphflow-graph.json",
      nodeCount: 5,
      edgeCount: 4,
      nodeTypeCount: {
        File: 1,
        Symbol: 1,
        Module: 1,
        TaskRun: 1,
        Decision: 1,
        Skill: 0,
      },
      topRelations: [
        { relation: "imports", count: 2 },
        { relation: "defines", count: 2 },
      ],
      sampleNodes: [
        { id: "file:src/index.ts", type: "File", contentPreview: "export {}" },
        { id: "symbol:runTask", type: "Symbol", contentPreview: "run task" },
      ],
      sampleEdges: [{ from: "file:src/index.ts", relation: "defines", to: "symbol:runTask" }],
    });

    expect(html).toContain('id="graph-search"');
    expect(html).toContain('id="graph-type-filter"');
    expect(html).toContain('id="graph-node-list"');
    expect(html).toContain('id="graph-detail"');
    expect(html).toContain('data-role="graph-canvas"');
    expect(html).toContain("file:src/index.ts");
  });

  it("renders skill insights controls for sorting and outcome filtering", () => {
    const html = buildSkillInsightsHtml({
      source: "graph-store",
      transport: "file",
      storePath: "tmp/graphflow-graph.json",
      skills: [
        {
          id: "skill:add-tests",
          name: "add tests",
          score: 4,
          uses: 6,
          lastOutcome: "pass",
          updatedAt: 1,
        },
        {
          id: "skill:refactor-planner",
          name: "refactor planner",
          score: -1,
          uses: 2,
          lastOutcome: "fail",
          updatedAt: 2,
        },
      ],
    });

    expect(html).toContain('id="skill-search"');
    expect(html).toContain('id="skill-outcome-filter"');
    expect(html).toContain('id="skill-sort"');
    expect(html).toContain('data-role="skill-table"');
    expect(html).toContain("add tests");
    expect(html).toContain("refactor planner");
  });
});