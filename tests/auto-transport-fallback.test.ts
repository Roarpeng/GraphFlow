import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";

// Simulate the optional better-sqlite3 dependency being missing (or its native
// module broken): constructing the sqlite backend always throws, so the `auto`
// transport must transparently fall back to the JSON file store instead of
// crashing the process.
vi.mock("../src/graph/sqlite-client", () => {
  class GraphifySqliteClient {
    constructor(_dbPath: string) {
      throw new Error("[test] better-sqlite3 optional dependency unavailable");
    }
  }
  return { GraphifySqliteClient };
});

const root = mkdtempSync(join(tmpdir(), "graphflow-auto-fallback-"));
const openClients: Array<{ close?: () => void }> = [];

afterAll(() => {
  for (const client of openClients) {
    client.close?.();
  }
  rmSync(root, { recursive: true, force: true });
});

function makeAutoConfig(storeFile: string) {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: "auto",
      workspaceRoot: root,
      graphStorePath: join(root, storeFile),
      maxContextTokens: 200,
    },
    learningPolicy: {
      enableFlywheel: false,
      trainingCadence: "nightly",
      exportPath: join(root, "learning.jsonl"),
    },
  });
}

function createTrackedClient(storeFile: string) {
  const client = createGraphClient(makeAutoConfig(storeFile));
  openClients.push(client as { close?: () => void });
  return client;
}

describe("auto graph transport with better-sqlite3 unavailable", () => {
  it("falls back to the JSON file store instead of throwing", async () => {
    const storeFile = `fallback-${Date.now()}.sqlite`;
    const client = createTrackedClient(storeFile);

    // Must not throw even though the sqlite backend cannot be constructed.
    await client.upsertNodes([
      { id: "f1", type: "File", content: "auto fallback when sqlite missing" },
    ]);
    const hits = await client.queryByKeyword("fallback");
    expect(hits.map((n) => n.id)).toEqual(["f1"]);

    const snapshot = client.readSnapshot?.();
    expect(snapshot?.nodes.map((n) => n.id)).toEqual(["f1"]);

    // The fallback is the JSON store next to the configured sqlite path.
    expect(existsSync(join(root, storeFile.replace(/\.sqlite$/i, ".json")))).toBe(true);
    expect(existsSync(join(root, storeFile))).toBe(false);
  });

  it("round-trips writes and deletes through the fallback file store", async () => {
    const storeFile = `fallback-rw-${Date.now()}.sqlite`;
    const client = createTrackedClient(storeFile);

    await client.upsertNodes([
      { id: "a1", type: "File", content: "alpha fallback node" },
      { id: "a2", type: "File", content: "beta fallback node" },
    ]);
    await client.upsertEdges([{ from: "a1", to: "a2", relation: "references" }]);
    await client.deleteNodes(["a2"]);

    const snapshot = client.readSnapshot?.();
    expect(snapshot?.nodes.map((n) => n.id)).toEqual(["a1"]);
    // Deleting a2 prunes the dangling edge too.
    expect(snapshot?.edges).toEqual([]);
  });
});
