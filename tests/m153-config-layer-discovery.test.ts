import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { resolveConfig } from "../src/config/resolve";

const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeProjectConfig(root: string, patch: (cfg: ReturnType<typeof getDefaultConfig>) => void): void {
  const cfg = getDefaultConfig();
  delete (cfg.graphPolicy as { workspaceRoot?: string }).workspaceRoot;
  patch(cfg);
  writeFileSync(join(root, "graphflow.config.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "m153", version: "1.0.0" }));
}

beforeEach(() => {
  for (const key of ["GRAPHFLOW_CONFIG_HOME", "GRAPHFLOW_WORKSPACE_ROOT"]) saved[key] = process.env[key];
  process.env.GRAPHFLOW_CONFIG_HOME = tempDir("m153-home-");
  delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M153 project config layers follow the served workspace, not process.cwd()", () => {
  it("reads graphflow.config.json from rootDir when cwd is another directory", () => {
    const project = tempDir("m153-proj-");
    writeProjectConfig(project, (cfg) => {
      cfg.graphPolicy.transport = "file";
      cfg.graphPolicy.maxContextTokens = 1234;
    });
    const config = resolveConfig(undefined, { rootDir: project });
    expect(config.graphPolicy.maxContextTokens).toBe(1234);
    expect(config.graphPolicy.transport).toBe("file");
  });

  it("applies the rootDir overlay on top of its project config", () => {
    const project = tempDir("m153-proj-");
    writeProjectConfig(project, (cfg) => {
      cfg.graphPolicy.maxContextTokens = 1234;
    });
    mkdirSync(join(project, ".graphflow"));
    const overlay = getDefaultConfig();
    overlay.graphPolicy.maxContextTokens = 4321;
    writeFileSync(join(project, ".graphflow", "config.json"), JSON.stringify(overlay));
    expect(resolveConfig(undefined, { rootDir: project }).graphPolicy.maxContextTokens).toBe(4321);
  });

  it("keeps the project workerPolicy when merging over the global layer", () => {
    const global = getDefaultConfig();
    writeFileSync(join(process.env.GRAPHFLOW_CONFIG_HOME!, ".graphflow.config.json"), JSON.stringify(global));
    const project = tempDir("m153-proj-");
    writeProjectConfig(project, (cfg) => {
      cfg.workerPolicy = {
        workerType: "typesafe-jev",
        workerConfig: { provider: "openai", baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "TYPESAFE_API_KEY" },
      } as typeof cfg.workerPolicy;
    });
    const merged = resolveConfig(undefined, { rootDir: project });
    expect(merged.workerPolicy?.workerType).toBe("typesafe-jev");
    expect(merged.workerPolicy?.workerConfig?.baseUrl).toBe("https://api.typesafe.ai");
  });

  it("falls back to GRAPHFLOW_WORKSPACE_ROOT, ignoring unexpanded placeholders", () => {
    const project = tempDir("m153-proj-");
    writeProjectConfig(project, (cfg) => {
      cfg.graphPolicy.maxContextTokens = 2468;
    });
    process.env.GRAPHFLOW_WORKSPACE_ROOT = project;
    expect(resolveConfig().graphPolicy.maxContextTokens).toBe(2468);

    process.env.GRAPHFLOW_WORKSPACE_ROOT = "${workspaceFolder}";
    expect(() => resolveConfig(undefined, { rootDir: project })).not.toThrow();
    expect(resolveConfig(undefined, { rootDir: project }).graphPolicy.maxContextTokens).toBe(2468);
  });
});

describe("M153 project and overlay layers are partial overrides of the global config", () => {
  function writeGlobal(patch: (cfg: ReturnType<typeof getDefaultConfig>) => void): void {
    const global = getDefaultConfig();
    delete (global.graphPolicy as { workspaceRoot?: string }).workspaceRoot;
    patch(global);
    writeFileSync(join(process.env.GRAPHFLOW_CONFIG_HOME!, ".graphflow.config.json"), JSON.stringify(global));
  }

  it("a project file naming one field inherits every other field from global", () => {
    writeGlobal((cfg) => {
      cfg.graphPolicy.maxContextTokens = 3000;
      cfg.tiers.smart = { provider: "deepseek", model: "deepseek-v4-pro" };
    });
    const project = tempDir("m153-proj-");
    writeFileSync(join(project, "graphflow.config.json"), JSON.stringify({ graphPolicy: { transport: "file" } }));
    const config = resolveConfig(undefined, { rootDir: project });
    expect(config.graphPolicy.transport).toBe("file");
    expect(config.graphPolicy.maxContextTokens).toBe(3000);
    expect(config.tiers.smart).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("a partial overlay applies over a partial project file", () => {
    writeGlobal((cfg) => {
      cfg.graphPolicy.maxContextTokens = 3000;
    });
    const project = tempDir("m153-proj-");
    writeFileSync(join(project, "graphflow.config.json"), JSON.stringify({ graphPolicy: { transport: "file" } }));
    mkdirSync(join(project, ".graphflow"));
    writeFileSync(join(project, ".graphflow", "config.json"), JSON.stringify({ tiers: { economy: { model: "m-x" } } }));
    const config = resolveConfig(undefined, { rootDir: project });
    expect(config.graphPolicy.transport).toBe("file");
    expect(config.graphPolicy.maxContextTokens).toBe(3000);
    expect(config.tiers.economy.model).toBe("m-x");
  });

  it("a broken project file still fails fast; a broken overlay is ignored", () => {
    const project = tempDir("m153-proj-");
    writeFileSync(join(project, "graphflow.config.json"), "{ not json");
    expect(() => resolveConfig(undefined, { rootDir: project })).toThrow(/Failed to load project config/);

    writeFileSync(join(project, "graphflow.config.json"), JSON.stringify({ graphPolicy: { maxContextTokens: 1500 } }));
    mkdirSync(join(project, ".graphflow"));
    writeFileSync(join(project, ".graphflow", "config.json"), "{ not json");
    expect(resolveConfig(undefined, { rootDir: project }).graphPolicy.maxContextTokens).toBe(1500);
  });
});
