import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getToolDefinitions } from "../src/surfaces/mcp/server";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("GraphFlow + Serena compose docs", () => {
  it("ships a dedicated compose guide in EN and zh", () => {
    expect(existsSync(join(root, "docs/graphflow-serena.md"))).toBe(true);
    expect(existsSync(join(root, "docs/graphflow-serena.zh.md"))).toBe(true);
    const en = read("docs/graphflow-serena.md");
    const zh = read("docs/graphflow-serena.zh.md");
    const toolNames = new Set(getToolDefinitions().map((t) => t.name));
    for (const body of [en, zh]) {
      expect(body).toContain("graphflow_context");
      expect(body).toContain("graphflow_plan");
      expect(body).toContain("graphflow_report_outcome");
      expect(body).toContain("graphflow-serena.mcp.json");
      expect(body).toMatch(/Pitfall|坑/);
      for (const raw of new Set(body.match(/graphflow_[a-z_]+/g) ?? [])) {
        expect(toolNames.has(raw), `unknown MCP tool ${raw}`).toBe(true);
      }
    }
  });

  it("is linked from README EN/zh and comparison.md", () => {
    expect(read("README.md")).toContain("docs/graphflow-serena.md");
    expect(read("README.zh.md")).toContain("docs/graphflow-serena.zh.md");
    const comparison = read("docs/comparison.md");
    expect(comparison).toContain("graphflow-serena.md");
    expect(comparison).toContain("graphflow-serena.zh.md");
  });

  it("example MCP snippet mounts both servers and is config-only", () => {
    const raw = read("examples/graphflow-serena.mcp.json");
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(parsed.mcpServers?.graphflow?.command).toBe("npx");
    expect(parsed.mcpServers?.graphflow?.args).toContain("graphflow-mcp");
    expect(parsed.mcpServers?.serena?.command).toBe("serena");
    expect(parsed.mcpServers?.serena?.args).toContain("start-mcp-server");

    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const bag of [
      pkg.dependencies,
      pkg.optionalDependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
    ]) {
      expect(bag ?? {}).not.toHaveProperty("serena");
      expect(bag ?? {}).not.toHaveProperty("serena-agent");
    }
  });
});
