import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { executeToolCall, type ToolCallResponse } from "../src/surfaces/mcp/tool-handlers";

/**
 * gf_read workbench/dialogue memory bridge (GraphFlow 3.1).
 *
 * `topicId` / `resumeFromTurnId` (with `q`) route to the legacy context
 * preview so the 4-tool v3 surface stays self-sufficient for workspace-memory
 * recall. Plain surgical reads must be untouched.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function createIsolatedConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-gfread-bridge-"));
  const configPath = join(root, "graphflow.config.json");
  const config = getDefaultConfig();
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      graphPolicy: {
        ...config.graphPolicy,
        transport: "file",
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        graphStorePath: join(root, "graphflow-graph.json"),
        workspaceRoot: root,
        embeddingProvider: "fnv",
      },
    }),
    "utf8"
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return configPath;
}

function isV3Envelope(response: ToolCallResponse & { structuredContent: Record<string, unknown> }): boolean {
  return response.structuredContent.tool === "gf_read";
}

describe("gf_read memory bridge (topicId / resumeFromTurnId)", () => {
  it("routes q + topicId to the context preview, not the v3 AST slicer", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "gf_read",
      arguments: {
        q: "where is the config resolved?",
        topicId: "topic-does-not-exist",
        configPath,
        rootDir: dirname(configPath),
      },
    });
    // The legacy preview pipeline answers (structuredContent carries the
    // preview result, never the v3 {tool, ok} envelope).
    expect(isV3Envelope(response)).toBe(false);
    expect(response.structuredContent.query).toBe("where is the config resolved?");
  });

  it("routes q + resumeFromTurnId through the preview as well", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "gf_read",
      arguments: {
        q: "continue from that turn",
        resumeFromTurnId: "turn-does-not-exist",
        configPath,
        rootDir: dirname(configPath),
      },
    });
    expect(isV3Envelope(response)).toBe(false);
  });

  it("targets win: an explicit target list stays on the surgical path even with topicId", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "gf_read",
      arguments: { targets: ["src/v3/index.ts"], topicId: "topic-x", configPath },
    });
    expect(isV3Envelope(response)).toBe(true);
    expect(response.structuredContent.ok).toBe(true);
  });

  it("topicId without q explains the required argument", async () => {
    await expect(
      executeToolCall({ name: "gf_read", arguments: { topicId: "topic-x" } })
    ).rejects.toThrow(/requires 'q'/);
  });
});
