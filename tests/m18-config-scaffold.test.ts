import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGlobalGraphFlowConfig,
  ensureWorkspaceGraphFlowConfig,
  resolveGlobalConfigPath,
} from "../src/config/scaffold";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

describe("M18 config scaffold", () => {
  it("creates global config when missing", () => {
    const fakeHome = createTempRoot("graphflow-global-home");
    mkdirSync(fakeHome, { recursive: true });
    const globalPath = join(fakeHome, ".graphflow.config.json");

    expect(resolveGlobalConfigPath().endsWith(".graphflow.config.json")).toBe(true);
    expect(existsSync(globalPath)).toBe(false);

    const created = ensureGlobalGraphFlowConfig({ configPath: globalPath });
    expect(created.status).toBe("created");
    expect(existsSync(globalPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(globalPath, "utf8")) as { tiers?: { smart?: { model?: string } } };
    expect(parsed.tiers?.smart?.model).toBeTruthy();

    const skipped = ensureGlobalGraphFlowConfig({ configPath: globalPath });
    expect(skipped.status).toBe("skipped");
  });

  it("creates workspace overlay config when missing", () => {
    const workspaceRoot = createTempRoot("graphflow-workspace");
    const created = ensureWorkspaceGraphFlowConfig(workspaceRoot);
    expect(created.status).toBe("created");
    expect(existsSync(join(workspaceRoot, ".graphflow", "config.json"))).toBe(true);

    const skipped = ensureWorkspaceGraphFlowConfig(workspaceRoot);
    expect(skipped.status).toBe("skipped");
  });
});
