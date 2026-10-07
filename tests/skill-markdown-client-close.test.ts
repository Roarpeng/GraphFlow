import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as factory from "../src/graph/client-factory";
import { skillToSkillMarkdown } from "../src/learning/skill-markdown";
import type { SkillState } from "../src/learning/skill-types";
import {
  exportSkillsToMarkdownRuntime,
  extractDialogueKnowledgeRuntime,
  importSkillsFromMarkdownRuntime,
} from "../src/surfaces/cli/runtime/knowledge";

const skill = (guidance: string): SkillState =>
  ({
    id: "s1",
    name: "Prefer Targeted Reads",
    score: 1,
    uses: 2,
    lastOutcome: "pass",
    updatedAt: 100,
    outcomeKind: "proven",
    guidance,
  }) as SkillState;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}),
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "gf-skill-close-"));
  dirs.push(dir);
  return dir;
}

/**
 * Wrap every client this process creates and record whether `close()` ran.
 * Default transport is sqlite when better-sqlite3 is present; either way the
 * runtime must release the handle before returning, or Windows `rmSync` of
 * graphflow-graph.sqlite fails with EBUSY.
 */
function trackCloses(options?: { failUpsert?: boolean }): { closed: boolean }[] {
  const records: { closed: boolean }[] = [];
  const original = factory.createGraphClient;
  vi.spyOn(factory, "createGraphClient").mockImplementation((config) => {
    const client = original(config);
    const innerClose = client.close?.bind(client);
    const record = { closed: false };
    client.close = () => {
      record.closed = true;
      return innerClose?.();
    };
    if (options?.failUpsert) {
      client.upsertNodes = () => Promise.reject(new Error("disk full"));
    }
    records.push(record);
    return client;
  });
  return records;
}

describe("skill markdown runtimes close the graph client", () => {
  it("closes after export, import, and dialogue-knowledge extract", async () => {
    const records = trackCloses();
    const ws = newWorkspace();
    const inDir = join(ws, "in");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "prefer-targeted-reads.md"), skillToSkillMarkdown(skill("- a")));

    await exportSkillsToMarkdownRuntime(undefined, { rootDir: ws, outputDir: join(ws, "out") });
    await importSkillsFromMarkdownRuntime(undefined, { rootDir: ws, inputPath: inDir });
    await extractDialogueKnowledgeRuntime(undefined, { rootDir: ws, apply: false });

    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.every((record) => record.closed)).toBe(true);
  });

  it("closes when a write fails after the client is open", async () => {
    const records = trackCloses({ failUpsert: true });
    const ws = newWorkspace();
    const inDir = join(ws, "in");
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, "prefer-targeted-reads.md"), skillToSkillMarkdown(skill("- a")));

    await expect(
      importSkillsFromMarkdownRuntime(undefined, { rootDir: ws, inputPath: inDir })
    ).rejects.toThrow(/disk full/);
    expect(records).toHaveLength(1);
    expect(records[0]?.closed).toBe(true);
  });
});
