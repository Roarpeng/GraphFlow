import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { getIndexerForFile } from "../src/graph/language-indexers";

function makeClient(): { wrapper: GraphClient; inner: GraphifyClient } {
  const inner = new GraphifyClient();
  const wrapper: GraphClient = {
    async upsertNodes(nodes) {
      await inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      await inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
  };
  return { wrapper, inner };
}

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `graphflow-m59-${label}-`));
}

describe("M59 Kotlin and Swift indexers", () => {
  it("indexes Kotlin fun and class symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("kotlin");
    try {
      writeFileSync(
        join(root, "App.kt"),
        [
          "import com.example.Util",
          "class App {",
          "    fun greet() {}",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".kt"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("App");
      expect(symbolNames).toContain("greet");

      const greet = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "greet"
      );
      expect(greet?.metadata?.kind).toBe("function");

      const app = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "App"
      );
      expect(app?.metadata?.kind).toBe("class");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes Swift func and class symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("swift");
    try {
      writeFileSync(
        join(root, "App.swift"),
        [
          "import Foundation",
          "class App {",
          "    func greet() {}",
          "}",
        ].join("\n"),
        "utf8"
      );

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".swift"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("App");
      expect(symbolNames).toContain("greet");

      const greet = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "greet"
      );
      expect(greet?.metadata?.kind).toBe("function");

      const app = snap.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "App"
      );
      expect(app?.metadata?.kind).toBe("class");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves indexers for .kt and .swift extensions", () => {
    expect(getIndexerForFile("App.kt")).toBeDefined();
    expect(getIndexerForFile("App.kt")?.language).toBe("kotlin");
    expect(getIndexerForFile("build.gradle.kts")).toBeDefined();
    expect(getIndexerForFile("build.gradle.kts")?.language).toBe("kotlin");

    expect(getIndexerForFile("App.swift")).toBeDefined();
    expect(getIndexerForFile("App.swift")?.language).toBe("swift");
  });
});
