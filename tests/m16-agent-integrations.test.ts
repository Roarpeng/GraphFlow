import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { getDefaultConfig } from "../src/config/defaults";

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
      "graphflow_context",
      "graphflow_plan",
      "graphflow_index",
      "graphflow_insight",
      "graphflow_skill_insights",
      "graphflow_diagnose",
      "graphflow_artifact",
      "graphflow_skill_guide",
    ]);
    const contextTool = getToolDefinitions().find((tool) => tool.name === "graphflow_context");
    expect(contextTool?.inputSchema.properties).toMatchObject({
      topicId: expect.any(Object),
      resumeFromTurnId: expect.any(Object),
      assistantReply: expect.any(Object),
      sessionId: expect.any(Object),
    });
    const planTool = getToolDefinitions().find((tool) => tool.name === "graphflow_plan");
    expect(planTool?.description).toContain("workbench.outline");
    const diagnoseTool = getToolDefinitions().find((tool) => tool.name === "graphflow_diagnose");
    expect(diagnoseTool?.description).toContain("workbenchOutline");
  });

  it("executes MCP tool calls and returns text content", async () => {
    // Isolate from ambient machine state: an explicit configPath is loaded
    // standalone (no global ~/.graphflow.config.json merge), so a config with
    // no provider credentials guarantees the agent-delegated bridge path on
    // any machine, regardless of locally installed API keys.
    const sandboxDir = mkdtempSync(join(tmpdir(), "graphflow-m16-"));
    const sandboxConfigPath = join(sandboxDir, "graphflow.config.json");
    writeFileSync(
      sandboxConfigPath,
      JSON.stringify({
        // 极简 config 过不了校验（budgetPolicy 缺失）会整体回退默认值，
        // 因此这里必须展开完整默认 config 再覆写。
        // A minimal config fails validation (missing budgetPolicy) and falls
        // back to defaults entirely, so spread the full default config first.
        ...getDefaultConfig(),
        providers: {},
        // 本用例断言 text 副本内容（工具链路），不关心序列化策略；
        // 关掉大响应桩化以保持原断言。序列化契约由 m106/mcp-structured 覆盖。
        // This case asserts text-copy content (tool flow), not serialization;
        // serialization contracts are covered by m106/mcp-structured tests.
        mcp: { textCopy: "full" },
        tiers: {
          smart: { provider: "openai", model: "gpt-4.1" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
      })
    );

    const response = await executeToolCall(
      {
        name: "graphflow_plan",
        arguments: {
          task: "refactor planner and add tests",
          configPath: sandboxConfigPath,
        },
      },
      createMcpServer()
    );

    expect(response.content[0]?.type).toBe("text");
    const text = response.content[0]?.text ?? "";
    // Default GraphFlow config has no usable LLM → simple plan bridges to the agent.
    // MCP 响应 text 副本是紧凑 JSON（无缩进空格），断言按紧凑格式写。
    expect(text).toContain('"mode":"agent-delegated"');
    expect(text).toContain('"triageMode":"complex"');
    expect(text).toContain('"requiresAgentBridge":true');
    expect(text).toContain("simple-plan-decomposition");
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
