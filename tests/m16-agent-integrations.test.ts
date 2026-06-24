import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCliResult,
  parseCliOptions,
  type CliCommandResult,
} from "../src/surfaces/cli/output";
import {
  createMcpServer,
  executeToolCall,
  getToolDefinitions,
} from "../src/surfaces/mcp/server";

describe("M16 agent integrations", () => {
  it("parses json and config flags for CLI surfaces", () => {
    const options = parseCliOptions(["run", "ship", "feature", "--json", "--config", "custom.json"]);

    expect(options.command).toBe("run");
    expect(options.args).toEqual(["ship", "feature"]);
    expect(options.json).toBe(true);
    expect(options.configPath).toBe("custom.json");
  });

  it("formats plan results as JSON for agent consumers", () => {
    const result: CliCommandResult = {
      command: "plan",
      data: {
        mode: "complex",
        ideas: ["split work"],
        nodes: [{ id: "task-1", description: "ship feature", dependencies: [] }],
      },
    };

    expect(formatCliResult(result, true)).toBe(JSON.stringify(result.data, null, 2));
  });

  it("defines MCP tools for external agent clients", () => {
    const toolNames = getToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toEqual([
      "graphflow_run",
      "graphflow_report_outcome",
      "graphflow_plan",
      "graphflow_preview_context",
      "graphflow_expand_anchor",
      "graphflow_index",
      "graphflow_index_file",
      "graphflow_rebuild",
      "graphflow_enrich_graph",
      "graphflow_model_download",
      "graphflow_inspect_graph",
      "graphflow_skill_insights",
      "graphflow_diagnose",
      "graphflow_export_artifact",
      "graphflow_import_artifact",
      "graphflow_stats",
      "graphflow_plan_insight",
      "graphflow_metrics",
    ]);
  });

  it("executes MCP tool calls and returns text content", async () => {
    const response = await executeToolCall(
      {
        name: "graphflow_plan",
        arguments: {
          task: "refactor planner and add tests",
        },
      },
      createMcpServer()
    );

    expect(response.content[0]?.type).toBe("text");
    expect(response.content[0]?.text).toContain('"mode": "complex"');
  });

  it("publishes Apache-2.0 metadata and agent binaries", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      license?: string;
      bin?: Record<string, string>;
    };

    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.bin).toEqual({
      graphflow: "dist/surfaces/cli/index.js",
      "graphflow-mcp": "dist/surfaces/mcp/server.js",
    });
  });
});