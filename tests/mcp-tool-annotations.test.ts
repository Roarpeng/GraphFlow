import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/surfaces/mcp/server";
import { getToolDefinitions } from "../src/surfaces/mcp/tool-definitions";

const READ_ONLY_TOOLS = ["graphflow_skill_insights", "graphflow_diagnose", "graphflow_skill_guide"];
const DESTRUCTIVE_TOOLS = ["graphflow_artifact"];
const OPEN_WORLD_TOOLS = ["graphflow_run", "graphflow_plan"];
const RISKS = ["R0", "R1", "R2", "R3", "R4", "R5"];

describe("MCP tool annotations (efficiency-agent spec §21)", () => {
  const tools = getToolDefinitions();

  it("declares title + all four behaviour hints as booleans on every tool", () => {
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      const a = tool.annotations;
      expect(a, tool.name).toBeDefined();
      expect(typeof a!.title, tool.name).toBe("string");
      expect(a!.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.title, tool.name).toBe(a!.title);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof a![hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("marks exactly the pure-read tools read-only and never destructive", () => {
    for (const tool of tools) {
      const readOnly = READ_ONLY_TOOLS.includes(tool.name);
      expect(tool.annotations!.readOnlyHint, tool.name).toBe(readOnly);
      if (readOnly) {
        expect(tool.annotations!.destructiveHint, tool.name).toBe(false);
        expect(tool.annotations!.idempotentHint, tool.name).toBe(true);
      }
    }
  });

  it("flags graph-state overwrite and provider-calling tools accurately", () => {
    for (const tool of tools) {
      expect(tool.annotations!.destructiveHint, tool.name).toBe(DESTRUCTIVE_TOOLS.includes(tool.name));
      expect(tool.annotations!.openWorldHint, tool.name).toBe(OPEN_WORLD_TOOLS.includes(tool.name));
    }
    // graphflow_context records a dialogue turn by default → not read-only.
    expect(tools.find((t) => t.name === "graphflow_context")!.annotations!.readOnlyHint).toBe(false);
    // Re-indexing rewrites derived graph artifacts to the same state.
    expect(tools.find((t) => t.name === "graphflow_index")!.annotations!.idempotentHint).toBe(true);
  });

  it("carries a GraphFlow risk class and capability list consistent with the hints", () => {
    for (const tool of tools) {
      const meta = tool._meta!;
      expect(meta, tool.name).toBeDefined();
      expect(RISKS, tool.name).toContain(meta["graphflow/risk"]);
      expect(Array.isArray(meta["graphflow/capabilities"]), tool.name).toBe(true);
      expect(meta["graphflow/risk"] === "R0", tool.name).toBe(tool.annotations!.readOnlyHint);
      const writes = meta["graphflow/capabilities"].includes("filesystem.write");
      expect(writes, tool.name).toBe(!tool.annotations!.readOnlyHint);
      expect(meta["graphflow/writeScope"] === "none", tool.name).toBe(tool.annotations!.readOnlyHint);
      const conditionalNetwork = meta["graphflow/conditionalCapabilities"]?.includes("network.connect") ?? false;
      expect(meta["graphflow/conditionalRisk"] === "R2", tool.name).toBe(conditionalNetwork);
      // Default configuration never opens the network: network.connect only appears conditionally.
      expect(meta["graphflow/capabilities"], tool.name).not.toContain("network.connect");
    }
    expect(tools.find((t) => t.name === "graphflow_artifact")!._meta!["graphflow/writeScope"]).toBe("caller-path");
  });

  it("returns fresh copies so callers cannot mutate the shared governance table", () => {
    const first = getToolDefinitions();
    first[0]!.annotations!.readOnlyHint = !first[0]!.annotations!.readOnlyHint;
    first[0]!._meta!["graphflow/capabilities"].push("tampered");
    const second = getToolDefinitions();
    expect(second[0]!.annotations!.readOnlyHint).not.toBe(first[0]!.annotations!.readOnlyHint);
    expect(second[0]!._meta!["graphflow/capabilities"]).not.toContain("tampered");
  });

  it("validates against the MCP SDK Tool schema and survives tools/list", async () => {
    for (const tool of tools) {
      const parsed = ToolSchema.safeParse(tool);
      expect(parsed.success, tool.name).toBe(true);
      if (parsed.success) {
        expect(parsed.data.annotations).toEqual(tool.annotations);
        expect(parsed.data._meta).toEqual(tool._meta);
      }
    }
    const server = createMcpServer();
    const listed = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = ListToolsResultSchema.parse(listed?.result);
    expect(result.tools).toHaveLength(10);
    for (const tool of result.tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_ONLY_TOOLS.includes(tool.name));
    }
  });

  it("reports a stable server identity: name graphflow, version from package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    const server = createMcpServer();
    expect(server.serverInfo).toEqual({ name: "graphflow", version: pkg.version });
    const initialized = await server.handleRequest({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(initialized?.result).toMatchObject({ serverInfo: { name: "graphflow", version: pkg.version } });
  });
});
