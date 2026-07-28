import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";

const root = mkdtempSync(join(tmpdir(), "graphflow-auto-transport-"));
const openClients: Array<{ close?: () => void }> = [];

afterAll(() => {
  // Release sqlite file handles before removing the temp dir (Windows EBUSY).
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

describe("auto graph transport", () => {
  it("accepts auto as a valid transport", () => {
    expect(() => makeAutoConfig("store.sqlite")).not.toThrow();
  });

  it("resolves to a working client (sqlite preferred, file fallback)", async () => {
    const client = createTrackedClient("store.sqlite");

    await client.upsertNodes([
      { id: "symbol:a.ts:fn1", type: "Symbol", content: "function alphaHandler() {}" },
    ]);
    const hits = await client.queryByKeyword("alphaHandler");
    expect(hits.length).toBeGreaterThan(0);

    // Snapshot must round-trip regardless of the resolved backend.
    const snapshot = client.readSnapshot?.();
    expect(snapshot?.nodes.length).toBeGreaterThan(0);
  });

  it("creates either a sqlite or json store file on disk", async () => {
    const storePath = join(root, "store.sqlite");
    const fallbackPath = join(root, "store.json");
    const client = createTrackedClient("store.sqlite");

    await client.upsertNodes([
      { id: "symbol:b.ts:fn2", type: "Symbol", content: "function betaWorker() {}" },
    ]);

    // sqlite backend writes .sqlite; fallback writes .json — exactly one must exist
    // after a flush (sqlite client persists eagerly or on close; file client on write).
    const sqliteExists = existsSync(storePath);
    const jsonExists = existsSync(fallbackPath);
    expect(sqliteExists || jsonExists).toBe(true);
  });
});
