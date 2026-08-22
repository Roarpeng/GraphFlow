import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { getDefaultConfig } from "../src/config/defaults";
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

function makeAutoConfig(storeFile: string, transport: "auto" | "file" = "auto") {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport,
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

function createTrackedClient(storeFile: string, transport: "auto" | "file" = "auto") {
  const client = createGraphClient(makeAutoConfig(storeFile, transport));
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

  it("defaults to the auto transport when nothing is configured", () => {
    expect(getDefaultConfig().graphPolicy.transport).toBe("auto");
  });

  it("an explicitly configured transport always wins over the auto default", async () => {
    // User explicitly picks the file backend: auto must not be re-selected.
    const storeFile = `explicit-file-${Date.now()}.json`;
    const client = createTrackedClient(storeFile, "file");

    await client.upsertNodes([
      { id: "f1", type: "File", content: "explicit file transport" },
    ]);
    expect(existsSync(join(root, storeFile))).toBe(true);
    // No sqlite store may be created alongside the explicit file store.
    expect(existsSync(join(root, storeFile.replace(/\.json$/i, ".sqlite")))).toBe(false);
  });

  it("auto falls back to the file store when sqlite initialization fails", async () => {
    // A directory parked at the .sqlite path makes `new Database()` throw
    // (SQLITE_CANTOPEN), exercising the "sqlite present but unusable" branch
    // of the auto resolution.
    const storeFile = `init-fail-${Date.now()}.sqlite`;
    mkdirSync(join(root, storeFile), { recursive: true });
    const client = createTrackedClient(storeFile);

    await client.upsertNodes([
      { id: "i1", type: "File", content: "init failure fallback" },
    ]);
    const hits = await client.queryByKeyword("fallback");
    expect(hits.map((n) => n.id)).toEqual(["i1"]);

    expect(existsSync(join(root, storeFile.replace(/\.sqlite$/i, ".json")))).toBe(true);
  });
});
