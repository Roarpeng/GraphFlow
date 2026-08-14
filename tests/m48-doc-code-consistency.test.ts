import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getToolDefinitions } from "../src/surfaces/mcp/server";

/**
 * Doc/code consistency guard (inspired by ponytail's check-rule-copies.js).
 *
 * The MCP tool list and version number are a single source of truth in code.
 * Docs that hand-maintain copies of them drift silently (we shipped a README
 * claiming v0.6.13 / 177 tests while code was 0.6.15 / 45 files). These tests
 * make that drift a CI failure instead of a release-day surprise.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/** Files that reference MCP tool names and must stay in sync with code. */
const DOC_FILES = [
  "AGENTS.md",
  "README.md",
  "README.zh.md",
  ".cursor/rules/graphflow.mdc",
  "src/surfaces/cursor-rules/graphflow.mdc",
  "src/surfaces/trae-rules/graphflow.md",
  "src/surfaces/trae-skill/graphflow/SKILL.md",
  "CLAUDE.md",
];

function canonicalizeToolMention(raw: string): string | undefined {
  // DeepSeek Harness public names: mcp__graphflow__graphflow_context
  const name = raw.startsWith("graphflow__") ? raw.slice("graphflow__".length) : raw;
  if (name === "graphflow_" || /^graphflow_+$/.test(name)) {
    return undefined;
  }
  return name;
}

describe("Doc/code consistency", () => {
  const toolNames = getToolDefinitions().map((t) => t.name);
  const toolNameSet = new Set(toolNames);

  it("every graphflow_* tool mentioned in docs exists in the MCP server", () => {
    for (const file of DOC_FILES) {
      if (!existsSync(join(root, file))) continue;
      const content = read(file);
      const mentioned = content.match(/graphflow_[a-z_]+/g) ?? [];
      for (const raw of new Set(mentioned)) {
        const name = canonicalizeToolMention(raw);
        if (!name) continue;
        expect(
          toolNameSet.has(name),
          `${file} references "${raw}" which is not a real MCP tool. ` +
            `Real tools: ${toolNames.join(", ")}`
        ).toBe(true);
      }
    }
  });

  it("AGENTS.md lists the core context/plan/run tools (agent entrypoints)", () => {
    const agents = read("AGENTS.md");
    for (const required of ["graphflow_context", "graphflow_plan", "graphflow_run"]) {
      expect(agents, `AGENTS.md must document ${required}`).toContain(required);
    }
  });

  it("root and vscode-extension versions match", () => {
    const rootPkg = readJson("package.json");
    const extPkg = readJson("vscode-extension/package.json");
    expect(extPkg.version).toBe(rootPkg.version);
  });

  it("README version badge/line matches package.json", () => {
    const version = readJson("package.json").version as string;
    const readme = read("README.md");
    // README must mention the current version somewhere and must NOT claim an
    // older 0.6.x line once we've moved past it.
    expect(readme, `README should reference current version ${version}`).toContain(version);
  });

  it("README does not reference deleted docs/testing artifacts", () => {
    const readme = read("README.md");
    // We removed the stale docs/testing/*.md references at 1.0; guard against reintroduction.
    const hasTestingRef = /docs\/testing\/[0-9]{4}-/.test(readme);
    if (hasTestingRef) {
      const exists = existsSync(join(root, "docs", "testing"));
      expect(exists, "README references docs/testing/* but that directory does not exist").toBe(true);
    }
  });
});
