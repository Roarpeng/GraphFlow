import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import { searchDialogueTurns } from "../src/graph/graph-search";
import {
  dialogueSessionIdFor,
  recordDialogueTurn,
} from "../src/learning/dialogue-thread";
import {
  loadActiveTopic,
  seedWorkbenchFromPlan,
  workbenchRootIdFor,
} from "../src/learning/workbench-topic";
import { previewContext } from "../src/surfaces/cli/runtime";

/**
 * P0 isolation gate: one graph store shared by two workspaces (the legacy
 * mixed-store shape) must never echo another project's dialogue turns or
 * workbench into this workspace's context. Reproduces the live defect where a
 * GraphFlow-rooted query attached a copper-tube-FOC workbench because
 * `loadActiveTopic` picked the store-wide most-recent root, and
 * `searchDialogueTurns` recalled turns regardless of session ownership.
 */
describe("cross-project recall isolation (P0 gate)", () => {
  const rootA = mkdtempSync(join(tmpdir(), "graphflow-iso-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "graphflow-iso-b-"));
  // Both configs point at ONE store file: the mixed-store deployment shape.
  const sharedStore = join(rootA, "graphflow-out", "graphflow-graph.json");
  const configA = join(rootA, "graphflow.config.json");

  const writeConfig = (path: string, workspaceRoot: string, storePath: string): void => {
    writeFileSync(
      path,
      JSON.stringify(
        {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-5.3-codex" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          graphPolicy: {
            enableAutoBuild: true,
            autoIndexOnPreview: false,
            autoIndexOnRun: false,
            workspaceRoot,
            includeExtensions: [".ts"],
            transport: "file",
            graphStorePath: storePath,
            maxContextTokens: 400,
          },
          learningPolicy: {
            enableFlywheel: true,
            trainingCadence: "nightly",
            exportPath: join(workspaceRoot, "learning.jsonl"),
          },
        },
        null,
        2
      ),
      "utf8"
    );
  };

  writeConfig(configA, rootA, sharedStore);

  afterAll(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  const sessionA = dialogueSessionIdFor("main", rootA);
  const sessionB = dialogueSessionIdFor("main", rootB);

  it("scoped dialogue recall excludes foreign-workspace turns even on full token overlap", async () => {
    const client = createGraphClient(resolveConfig(configA));
    // Identical vocabulary on both sides: only attribution can separate them.
    await recordDialogueTurn(client, {
      userQuery: "homing axis zero drift calibration steps",
      assistantReply: "project A: recalibrate after warmup.",
      workspaceRoot: rootA,
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "homing axis zero drift calibration limits",
      assistantReply: "project B: check soft limits table.",
      workspaceRoot: rootB,
      now: 2_000,
    });

    const fromA = await searchDialogueTurns(client, "homing axis zero drift calibration", {
      workspaceRoot: rootA,
    });
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromA.every((hit) => hit.sessionId === sessionA)).toBe(true);

    const fromB = await searchDialogueTurns(client, "homing axis zero drift calibration", {
      workspaceRoot: rootB,
    });
    expect(fromB.length).toBeGreaterThan(0);
    expect(fromB.every((hit) => hit.sessionId === sessionB)).toBe(true);

    // Unscoped recall keeps the legacy union for callers that pass no root.
    const unscoped = await searchDialogueTurns(client, "homing axis zero drift calibration");
    expect(unscoped.length).toBeGreaterThan(fromA.length);
  });

  it("loadActiveTopic never attaches a foreign workbench root, even a newer one", async () => {
    const client = createGraphClient(resolveConfig(configA));
    const task = "stabilize the axis controller";
    const seededA = await seedWorkbenchFromPlan(client, {
      task,
      steps: [{ id: "s1", description: "inspect the axis controller", dependencies: [] }],
      workspaceRoot: rootA,
      now: 1_000,
    });
    // B's root is NEWER: the pre-fix code attached the store-wide latest root.
    const seededB = await seedWorkbenchFromPlan(client, {
      task,
      steps: [{ id: "s1", description: "inspect the axis controller", dependencies: [] }],
      workspaceRoot: rootB,
      now: 9_000,
    });
    expect(seededA.root.id).not.toBe(seededB.root.id);

    const active = await loadActiveTopic(client, rootA);
    expect(active).toBeDefined();
    expect(active!.rootId).toBe(seededA.root.id);

    const foreign = await loadActiveTopic(client, rootB);
    expect(foreign).toBeDefined();
    expect(foreign!.rootId).toBe(seededB.root.id);

    // Without a root the legacy behavior (store-wide latest) is preserved.
    const unscoped = await loadActiveTopic(client);
    expect(unscoped?.rootId).toBe(seededB.root.id);
  });

  it("previewContext echoes only this workspace's workbench and dialogueHits", async () => {
    const preview = await previewContext(
      "inspect the axis controller homing drift",
      configA,
      rootA,
      undefined,
      { recordDialogue: false }
    );
    if (preview.workbench) {
      const ownedRootId = workbenchRootIdFor("stabilize the axis controller", rootA);
      expect(preview.workbench.rootId).toBe(ownedRootId);
    }
    for (const hit of preview.dialogueHits ?? []) {
      expect(hit.sessionId).toBe(sessionA);
    }
  });
});
