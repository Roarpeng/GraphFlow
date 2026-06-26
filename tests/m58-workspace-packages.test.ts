import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverWorkspacePackages,
  packageLabelForPath,
  workspacePackageForPath,
} from "../src/config/workspace-packages.js";
import { enrichNodeForSnapshot, folderGroupFromPath } from "../src/graph/snapshot-view.js";
import type { GraphNode } from "../src/core/types.js";

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

describe("M58 workspace packages", () => {
  it("discovers monorepo workspace package roots", () => {
    const root = createTempRoot("graphflow-workspace-packages");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root-app", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages", "foo"), { recursive: true });
    writeFileSync(join(root, "packages", "foo", "package.json"), JSON.stringify({ name: "@scope/foo" }));

    expect(discoverWorkspacePackages(root)).toEqual([".", "packages/foo"]);
  });

  it("labels files under a workspace package", () => {
    const root = createTempRoot("graphflow-workspace-labels");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root-app", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages", "foo"), { recursive: true });
    writeFileSync(join(root, "packages", "foo", "package.json"), JSON.stringify({ name: "@scope/foo" }));

    const workspace = { rootDir: root, packageRoots: discoverWorkspacePackages(root) };
    const relPath = "packages/foo/src/index.ts";

    expect(packageLabelForPath(root, relPath)).toBe("@scope/foo");
    expect(folderGroupFromPath(relPath, workspace)).toBe("@scope/foo");
    expect(workspacePackageForPath(root, relPath, workspace.packageRoots)).toBe("@scope/foo");
  });

  it("adds workspacePackage metadata in snapshot enrichment", () => {
    const root = createTempRoot("graphflow-workspace-snapshot");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root-app", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages", "foo"), { recursive: true });
    writeFileSync(join(root, "packages", "foo", "package.json"), JSON.stringify({ name: "@scope/foo" }));

    const workspace = { rootDir: root, packageRoots: discoverWorkspacePackages(root) };
    const fileNode: GraphNode = {
      id: "file:packages/foo/src/index.ts",
      type: "File",
      content: "packages/foo/src/index.ts",
      metadata: { path: "packages/foo/src/index.ts", language: "typescript" },
    };

    const enriched = enrichNodeForSnapshot(fileNode, 160, workspace);
    expect(enriched.folderGroup).toBe("@scope/foo");
    expect(enriched.workspacePackage).toBe("@scope/foo");
  });
});
