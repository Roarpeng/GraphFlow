import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { getIndexerForFile } from "../src/graph/language-indexers";
import { dartIndexer } from "../src/graph/language-indexers/dart";

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
  return mkdtempSync(join(tmpdir(), `graphflow-m60-${label}-`));
}

const SAMPLE_DART = [
  "import 'package:flutter/material.dart';",
  "import '../models/game_models.dart';",
  "typedef DamageCallback = void Function(int);",
  "enum GameStatus { playing, won }",
  "mixin LoggerMixin {}",
  "extension StringX on String { int get len => length; }",
  "class BattlePage extends StatefulWidget {",
  "  const BattlePage({super.key});",
  "  void _onGameStateChange() {}",
  "  Widget build(BuildContext context) => Container();",
  "}",
  "void main() {}",
  "class _PrivateHelper {}",
].join("\n");

describe("M60 Dart indexer", () => {
  it("resolves indexer for .dart extension", () => {
    expect(getIndexerForFile("lib/main.dart")).toBeDefined();
    expect(getIndexerForFile("lib/main.dart")?.language).toBe("dart");
  });

  it("extracts classes, functions, imports, and private export flags", async () => {
    const result = await dartIndexer.extract("lib/pages/battle_page.dart", SAMPLE_DART);
    const names = result.symbols.map((s) => s.name);

    expect(names).toContain("BattlePage");
    expect(names).toContain("main");
    expect(names).toContain("build");
    expect(names).toContain("_onGameStateChange");
    expect(names).toContain("_PrivateHelper");
    expect(names).toContain("GameStatus");
    expect(names).toContain("LoggerMixin");
    expect(names).toContain("StringX");
    expect(names).toContain("DamageCallback");

    const battle = result.symbols.find((s) => s.name === "BattlePage");
    expect(battle?.kind).toBe("class");
    expect(battle?.exported).toBe(true);

    const priv = result.symbols.find((s) => s.name === "_PrivateHelper");
    expect(priv?.exported).toBe(false);
    expect(priv?.visibility).toBe("private");

    const modules = result.imports.map((i) => i.module);
    expect(modules).toContain("flutter/material");
    expect(modules.some((m) => m.includes("game_models"))).toBe(true);
  });

  it("indexes Dart symbols via indexWorkspaceFiles", async () => {
    const root = tmpRoot("dart");
    try {
      writeFileSync(join(root, "app.dart"), SAMPLE_DART, "utf8");

      const { wrapper, inner } = makeClient();
      await indexWorkspaceFiles(wrapper, root, { includeExtensions: [".dart"] });
      const snap = inner.snapshot();
      const symbolNames = snap.nodes
        .filter((n) => n.type === "Symbol")
        .map((n) => (n.metadata?.name as string) ?? "");

      expect(symbolNames).toContain("BattlePage");
      expect(symbolNames).toContain("main");
      expect(symbolNames).toContain("build");

      const battle = snap.nodes.find(
        (n) =>
          n.type === "Symbol" &&
          n.metadata?.name === "BattlePage" &&
          n.metadata?.kind === "class"
      );
      expect(battle).toBeDefined();
      expect(battle?.metadata?.kind).toBe("class");

      const fileNode = snap.nodes.find((n) => n.type === "File" && n.id.includes("app.dart"));
      expect(fileNode).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
