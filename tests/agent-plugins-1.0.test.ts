import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const ALLOWED_PLUGIN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const PLUGIN_NAME_RE = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9]|-(?!-)|(?:\.(?!\.)))*[a-z0-9]$|^[a-z0-9]$/;

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

describe("Agent Plugins 1.0 packaging", () => {
  it("plugin.json matches the closed manifest schema contract", () => {
    const plugin = readJson("plugin.json") as Record<string, unknown>;

    expect(plugin.$schema).toBe(PLUGIN_SCHEMA);
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name).toMatch(PLUGIN_NAME_RE);

    for (const key of Object.keys(plugin)) {
      expect(ALLOWED_PLUGIN_KEYS.has(key)).toBe(true);
    }

    if (plugin.author !== undefined) {
      expect(plugin.author && typeof plugin.author === "object").toBe(true);
      const author = plugin.author as Record<string, unknown>;
      for (const key of Object.keys(author)) {
        expect(["name", "email", "url"].includes(key)).toBe(true);
        expect(typeof author[key]).toBe("string");
      }
    }

    if (plugin.keywords !== undefined) {
      expect(Array.isArray(plugin.keywords)).toBe(true);
      for (const keyword of plugin.keywords as unknown[]) {
        expect(typeof keyword).toBe("string");
      }
    }
  });

  it("plugin.json documents DeepSeek Harness usage and capabilities", () => {
    const plugin = readJson("plugin.json") as {
      description?: string;
      keywords?: string[];
      extensions?: {
        dsh?: {
          bundle?: string;
          install?: string;
          capabilities?: string[];
          usage?: string;
        };
      };
    };
    expect(plugin.description).toMatch(/MCP/);
    expect(plugin.keywords).toContain("dsh-plugin");
    expect(plugin.extensions?.dsh?.bundle).toBe("./cordis.patch.yml");
    expect(plugin.extensions?.dsh?.install).toContain("dsh plugin");
    expect(plugin.extensions?.dsh?.usage).toMatch(/graphflow_context/);
    expect(plugin.extensions?.dsh?.capabilities).toEqual(
      expect.arrayContaining([
        "graphflow_context",
        "graphflow_plan",
        "graphflow_index",
        "graphflow_report_outcome",
      ])
    );
    expect(plugin.extensions?.dsh?.capabilities).toHaveLength(10);
  });

  it("mcp.json declares stdio graphflow with matching schema version", () => {
    const mcp = readJson("mcp.json") as Record<string, unknown>;

    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    expect(mcp.$schema).toBe(MCP_SCHEMA);

    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers).toBeTruthy();
    expect(servers.graphflow).toBeTruthy();
    expect(servers.graphflow.type).toBe("stdio");
    expect(typeof servers.graphflow.command).toBe("string");
    expect((servers.graphflow.command as string).length).toBeGreaterThan(0);

    const command = servers.graphflow.command as string;
    expect(command.includes(" ") || command.startsWith("../")).toBe(false);
    expect(command === "npx" || command.startsWith("./")).toBe(true);

    if (servers.graphflow.args !== undefined) {
      expect(Array.isArray(servers.graphflow.args)).toBe(true);
    }
    if (servers.graphflow.env !== undefined) {
      expect(servers.graphflow.env && typeof servers.graphflow.env === "object").toBe(true);
      expect("PLUGIN_ROOT" in (servers.graphflow.env as object)).toBe(false);
      expect("PLUGIN_DATA" in (servers.graphflow.env as object)).toBe(false);
    }
  });

  it("skills/graphflow/SKILL.md exists with required frontmatter", () => {
    const skillPath = join(ROOT, "skills", "graphflow", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, "utf8");
    expect(content.startsWith("---")).toBe(true);

    const end = content.indexOf("\n---", 3);
    expect(end).toBeGreaterThan(0);
    const frontmatter = content.slice(3, end);

    expect(frontmatter).toMatch(/^name:\s*.+/m);
    expect(frontmatter).toMatch(/^description:\s*.+/m);
  });

  it("trae-skill copy stays in sync with the Agent Plugins skill source", () => {
    const canonical = readFileSync(join(ROOT, "skills", "graphflow", "SKILL.md"), "utf8");
    const copy = readFileSync(
      join(ROOT, "src", "surfaces", "trae-skill", "graphflow", "SKILL.md"),
      "utf8"
    );
    expect(copy).toBe(canonical);
  });
});
