import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInstructionBlock,
  installProjectGeminiInstructions,
} from "../src/integrations/skill-installer";

const SURGICAL_4 = ["gf_read", "gf_edit", "gf_exec", "gf_macro"] as const;

describe("M17b agent instruction block (4 surgical v3 tools)", () => {
  it("buildInstructionBlock teaches the 4 gf_* surgical tools", () => {
    const block = buildInstructionBlock();

    for (const tool of SURGICAL_4) {
      expect(block).toContain(tool);
    }
    expect(block).not.toContain("graphflow_preview_context");
    expect(block).not.toContain("graphflow_expand_anchor");
    expect(block).not.toContain("graphflow_context");
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
      expect(content).toContain("gf_read");
      expect(content).not.toContain("graphflow_preview_context");
      expect(content).toBe(buildInstructionBlock());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
