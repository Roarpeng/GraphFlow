import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config/defaults";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";

/**
 * Wave-2 fix: the preview read path's own small writes (dialogue turns,
 * workbench topics) used to null the file store's inverted index, so the
 * next keyword query re-tokenized the whole store after EVERY preview. The
 * delta path now patches the index in place (old tokens out, new in).
 */
function makeLargeStore(): { root: string; client: GraphifyFileClient } {
  const root = mkdtempSync(join(tmpdir(), "gf-idxpatch-"));
  const storePath = join(root, "graph.json");
  // Base store must exceed GRAPH_STORE_DELTA_MIN_BASE_BYTES so upserts take
  // the delta path (the fix only matters there).
  const filler = "lorem ipsum filler content ".repeat(200);
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    id: `file:src/mod${i}.ts`,
    type: "File" as const,
    content: `module${i} unique${i}token ${filler}`,
  }));
  writeFileSync(storePath, JSON.stringify({ nodes, edges: [] }), "utf8");
  return { root, client: new GraphifyFileClient(storePath) };
}

describe("file store inverted index survives small incremental writes", () => {
  it("keyword queries work after an upsert without a full rebuild (old tokens gone, new tokens hit)", async () => {
    const { root, client } = makeLargeStore();
    try {
      // Prime the inverted index.
      const before = await client.queryByKeyword("unique7token");
      expect(before.map((n) => n.id)).toContain("file:src/mod7.ts");

      // Small incremental write — the dialogue-turn shape: a NEW node.
      await client.upsertNodes([
        { id: "dialogue:s1:0001", type: "Decision", content: "how does unique42token routing work" },
      ]);
      const hitNew = await client.queryByKeyword("unique42token");
      expect(hitNew.map((n) => n.id)).toContain("dialogue:s1:0001");

      // ...and an UPSERT that rewrites an existing node's content: the old
      // token must stop matching, the new one must match.
      await client.upsertNodes([
        { id: "file:src/mod7.ts", type: "File", content: "renamed replacedtoken content" },
      ]);
      expect((await client.queryByKeyword("unique7token")).map((n) => n.id)).not.toContain("file:src/mod7.ts");
      expect((await client.queryByKeyword("replacedtoken")).map((n) => n.id)).toContain("file:src/mod7.ts");

      // Untouched nodes are still retrievable.
      expect((await client.queryByKeyword("unique8token")).map((n) => n.id)).toContain("file:src/mod8.ts");
    } finally {
      client.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deleted nodes stop matching keyword queries without rebuilding the index", async () => {
    const { root, client } = makeLargeStore();
    try {
      expect((await client.queryByKeyword("unique3token")).map((n) => n.id)).toContain("file:src/mod3.ts");
      await client.deleteNodes(["file:src/mod3.ts"]);
      expect(await client.queryByKeyword("unique3token")).toHaveLength(0);
      expect((await client.queryByKeyword("unique9token")).map((n) => n.id)).toContain("file:src/mod9.ts");
    } finally {
      client.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the patched index is equivalent to a full rebuild (createGraphClient parity)", async () => {
    const { root, client } = makeLargeStore();
    try {
      await client.upsertNodes([
        { id: "dialogue:s2:0001", type: "Decision", content: "alpha beta gamma question" },
        { id: "dialogue:s2:0002", type: "Decision", content: "delta epsilon zeta answer" },
      ]);
      const viaPatched = (await client.queryByKeyword("gamma")).map((n) => n.id).sort();
      // A fresh process resolves the store from disk (delta applied) and
      // builds its index from scratch — results must agree.
      const config = validateConfig({
        ...getDefaultConfig(),
        graphPolicy: {
          ...getDefaultConfig().graphPolicy,
          workspaceRoot: root,
          transport: "file" as const,
          graphStorePath: join(root, "graph.json"),
        },
      });
      const fresh = createGraphClient(config);
      const viaRebuild = (await fresh.queryByKeyword("gamma")).map((n) => n.id).sort();
      expect(viaPatched).toEqual(viaRebuild);
      fresh.close?.();
    } finally {
      client.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
