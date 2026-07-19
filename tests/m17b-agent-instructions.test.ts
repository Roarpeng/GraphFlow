import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInstructionBlock,
  installProjectGeminiInstructions,
} from "../src/integrations/skill-installer";

const AUTHORITATIVE_10 = [
  "graphflow_context",
  "graphflow_plan",
  "graphflow_run",
  "graphflow_report_outcome",
  "graphflow_insight",
  "graphflow_index",
  "graphflow_artifact",
  "graphflow_skill_insights",
  "graphflow_skill_guide",
  "graphflow_diagnose",
] as const;

describe("M17b agent instruction block (10 MCP tools)", () => {
  it("buildInstructionBlock uses graphflow_context and lists the 10 tools", () => {
    const block = buildInstructionBlock();

    expect(block).toContain("graphflow_context");
    expect(block).not.toContain("graphflow_preview_context");
    expect(block).not.toContain("graphflow_expand_anchor");
    expect(block).toContain("CallMcpTool");
    expect(block).toContain("server");
    expect(block).toContain("toolName");
    expect(block).toContain("arguments");

    for (const tool of AUTHORITATIVE_10) {
      expect(block).toContain(tool);
    }
  });

  it("install overwrites a stale managed block that still names graphflow_preview_context", () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-instr-"));
    const geminiPath = join(dir, "GEMINI.md");
    writeFileSync(
      geminiPath,
      [
        "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->",
        "## GraphFlow Context-First Rule",
        "",
        "1. Call `graphflow_preview_context` with the task/query first.",
        "<!-- GRAPHFLOW:END -->",
        "",
      ].join("\n"),
      "utf8"
    );

    try {
      const results = installProjectGeminiInstructions(dir);
      expect(results[0]?.status).toBe("updated");

      const content = readFileSync(geminiPath, "utf8");
      expect(content).toContain("graphflow_context");
      expect(content).not.toContain("graphflow_preview_context");
      expect(content).toContain("CallMcpTool");
      expect(content).toBe(buildInstructionBlock());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
