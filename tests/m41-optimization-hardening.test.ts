import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigSafe } from "../src/config/loader";
import { hasPendingGraphIndexWork } from "../src/graph/file-indexer";
import { resolveRuntimeCwd, requireWorkspaceFolder } from "../vscode-extension/src/workspace";
import { assertGraphFlowRuntime } from "../src/surfaces/cli/runtime/facade";
import * as runtime from "../src/surfaces/cli/runtime";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    const configPath = join(root, "graphflow.config.json");
    writeFileSync(configPath, "{ not-json", "utf8");

    const result = loadConfigSafe(configPath);
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.config.tiers.smart.provider).toBeTruthy();
  });

  it("hasPendingGraphIndexWork detects new files", () => {
    const root = createTempRoot("graphflow-pending-index");
    writeFileSync(join(root, "sample.ts"), "export const x = 1;\n", "utf8");
    expect(hasPendingGraphIndexWork(root)).toBe(true);
  });

  it("resolveRuntimeCwd prefers workspace over home", () => {
    expect(resolveRuntimeCwd("/repo", "/home/user")).toBe("/repo");
    expect(resolveRuntimeCwd(undefined, "/home/user")).toBe("/home/user");
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
});
