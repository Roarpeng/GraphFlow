import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigSafe, validateConfig } from "../src/config/loader";
import { getDefaultConfig, LEGACY_MAX_CONTEXT_TOKENS, resolveMaxContextTokens } from "../src/config/defaults";
import { hasPendingGraphIndexWork } from "../src/graph/file-indexer";
import { resolveRuntimeCwd, requireWorkspaceFolder } from "../vscode-extension/src/workspace";
import { assertGraphFlowRuntime } from "../src/surfaces/cli/runtime/facade";
import * as runtime from "../src/surfaces/cli/runtime";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M41 optimization hardening", () => {
  it("loadConfigSafe falls back when JSON is invalid", () => {
    const root = createTempRoot("graphflow-bad-config");
    const configPath = path.join(root, "graphflow.config.json");
    writeFileSync(configPath, "{ not-json", "utf8");

    const result = loadConfigSafe(configPath);
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.config.tiers.smart.provider).toBeTruthy();
  });

  it("hasPendingGraphIndexWork detects new files", () => {
    const root = createTempRoot("graphflow-pending-index");
    writeFileSync(path.join(root, "sample.ts"), "export const x = 1;\n", "utf8");
    expect(hasPendingGraphIndexWork(root)).toBe(true);
  });

  it("resolveRuntimeCwd prefers workspace over home", () => {
    const repo = path.join("/", "repo");
    const homeUser = path.join("/", "home", "user");
    expect(resolveRuntimeCwd(repo, homeUser)).toBe(path.resolve(repo));
    expect(resolveRuntimeCwd(undefined, homeUser)).toBe(path.resolve(homeUser));
  });

  it("requireWorkspaceFolder guards graph-only actions", () => {
    expect(requireWorkspaceFolder(undefined)).toBe(false);
    expect(requireWorkspaceFolder("/repo")).toBe(true);
  });

  it("assertGraphFlowRuntime validates bundled module exports", () => {
    const validated = assertGraphFlowRuntime(runtime);
    expect(typeof validated.runTask).toBe("function");
    expect(typeof validated.previewContext).toBe("function");
  });

  it("assertGraphFlowRuntime rejects incomplete modules", () => {
    expect(() => assertGraphFlowRuntime({ runTask: () => Promise.resolve("") })).toThrow(
      /missing required exports/i
    );
  });

  it("defaults enable continuous graph sync and 1500 token budget", () => {
    const config = getDefaultConfig();
    expect(config.graphPolicy.autoIndexOnSave).toBe(true);
    expect(config.graphPolicy.maxContextTokens).toBe(1500);
  });

  it("defaults graph transport to auto (sqlite preferred, file fallback)", () => {
    const config = getDefaultConfig();
    expect(config.graphPolicy.transport).toBe("auto");
    // auto 的默认存储路径为 .sqlite；sqlite 不可用时 client-factory 降级为同名 .json
    expect(config.graphPolicy.graphStorePath).toMatch(/graphflow-graph\.sqlite$/);
  });

  it("keeps an explicitly configured file transport (no migration)", () => {
    const root = createTempRoot("graphflow-explicit-file");
    const storePath = path.join(root, "graphflow-out", "graphflow-graph.json");
    const config = validateConfig({
      ...getDefaultConfig(),
      graphPolicy: {
        ...getDefaultConfig().graphPolicy,
        transport: "file",
        graphStorePath: storePath,
      },
    });
    expect(config.graphPolicy.transport).toBe("file");
    expect(config.graphPolicy.graphStorePath).toBe(storePath);

    // 磁盘上的用户配置显式写 "file" 时，loadConfigSafe 不得改写为 auto
    const configPath = path.join(root, "graphflow.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...getDefaultConfig(),
        graphPolicy: {
          ...getDefaultConfig().graphPolicy,
          transport: "file",
          graphStorePath: storePath,
        },
      }),
      "utf8"
    );
    const loaded = loadConfigSafe(configPath);
    expect(loaded.usedFallback).toBe(false);
    expect(loaded.config.graphPolicy.transport).toBe("file");
  });

  it("upgrades legacy maxContextTokens 400 to 1500", () => {
    expect(resolveMaxContextTokens(LEGACY_MAX_CONTEXT_TOKENS)).toBe(1500);
    const config = validateConfig({
      ...getDefaultConfig(),
      graphPolicy: {
        ...getDefaultConfig().graphPolicy,
        maxContextTokens: LEGACY_MAX_CONTEXT_TOKENS,
      },
    });
    expect(config.graphPolicy.maxContextTokens).toBe(1500);
  });
});
