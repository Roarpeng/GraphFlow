import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { executeToolCall, type ToolCallResponse } from "../src/surfaces/mcp/tool-handlers";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createIsolatedConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "graphflow-structured-"));
  const configPath = join(root, "graphflow.config.json");
  const config = getDefaultConfig();
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      graphPolicy: {
        ...config.graphPolicy,
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        graphStorePath: join(root, "graphflow-graph.json"),
        workspaceRoot: root,
      },
    }),
    "utf8"
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return configPath;
}

function parseText(response: ToolCallResponse): unknown {
  expect(response.content[0]?.type).toBe("text");
  return JSON.parse(response.content[0]!.text);
}

describe("MCP structured tool results", () => {
  it("returns structuredContent for diagnose while preserving its JSON text", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "graphflow_diagnose",
      arguments: { configPath },
    });
    const structured = response.structuredContent as Record<string, unknown>;

    expect(structured).toEqual(parseText(response));
    expect(Object.keys(structured).sort()).toEqual([
      "flywheel",
      "graph",
      "health",
      "runtimeTimeline",
      "stats",
    ]);
  });

  it("returns structuredContent for skill insights", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "graphflow_skill_insights",
      arguments: { configPath },
    });

    expect(response.structuredContent).toEqual(parseText(response));
    expect(response.structuredContent).toMatchObject({
      source: "graph-store",
      skills: [],
    });
  });

  it("keeps export failures as thrown tool errors", async () => {
    const configPath = createIsolatedConfig();
    const promise = executeToolCall({
      name: "graphflow_artifact",
      arguments: { mode: "export", configPath },
    });

    await expect(promise).rejects.toThrow("Graph store is empty");
  });

  it("rejects invalid artifact modes without inventing isError", async () => {
    const promise = executeToolCall({
      name: "graphflow_artifact",
      arguments: { mode: "invalid" },
    });

    try {
      await promise;
      expect.unreachable("graphflow_artifact should reject an invalid mode");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Invalid mode 'invalid' for graphflow_artifact. Use 'export' or 'import'."
      );
      expect(error).not.toHaveProperty("isError");
    }
  });

  it("wraps the skill guide while retaining its string-shaped JSON text", async () => {
    const response = await executeToolCall({
      name: "graphflow_skill_guide",
      arguments: { section: "best-practices" },
    });
    const structured = response.structuredContent as { section: string; guide: string };
    const legacyText = JSON.parse(response.content[0]!.text) as string;

    expect(structured).toEqual({ section: "best-practices", guide: legacyText });
    expect(structured.guide).toContain("## Best Practices");
  });
});
