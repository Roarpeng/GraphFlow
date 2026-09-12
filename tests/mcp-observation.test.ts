import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolCall } from "../src/surfaces/mcp/tool-handlers";

const tempRoots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gf-mcp-observation-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("graphflow_context observation handles (GF-2 folded into graphflow_context)", () => {
  const content = [
    "INFO start",
    "noise one",
    "ERROR boom",
    "AssertionError: expected 1 actual 2",
    "noise two",
  ].join("\n");

  it("packs content into a handle, recalls exact bytes, and reduces to a verified receipt", async () => {
    const rootDir = makeRoot();

    const packed = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, content },
    });
    const pack = packed.structuredContent as { handle?: string; fallback?: boolean };
    expect(pack.fallback).toBe(false);
    expect(pack.handle).toMatch(/^gfo:[0-9a-f]{16}$/);

    const recalled = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, handle: pack.handle },
    });
    const recall = recalled.structuredContent as { expired?: boolean; content?: string };
    expect(recall.expired).toBe(false);
    expect(recall.content).toBe(content);

    const reduced = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, handle: pack.handle, reduce: true },
    });
    const reduce = reduced.structuredContent as {
      fallback?: boolean;
      verified?: boolean;
      receipt?: string;
    };
    expect(reduce.fallback).toBe(false);
    expect(reduce.verified).toBe(true);
    expect(reduce.receipt).toContain("ERROR boom");
  });

  it("supports range recall and reports expired for unknown handles", async () => {
    const rootDir = makeRoot();
    const packed = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, content },
    });
    const handle = (packed.structuredContent as { handle: string }).handle;

    const ranged = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, handle, range: [3, 4] },
    });
    const recall = ranged.structuredContent as { expired?: boolean; content?: string };
    expect(recall.expired).toBe(false);
    expect(recall.content).toBe("ERROR boom\nAssertionError: expected 1 actual 2");

    const missing = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, handle: "gfo:0000000000000000" },
    });
    expect((missing.structuredContent as { expired?: boolean }).expired).toBe(true);
  });

  it("reduces provided content directly without a pre-existing handle", async () => {
    const rootDir = makeRoot();
    const reduced = await executeToolCall({
      name: "graphflow_context",
      arguments: { rootDir, content, reduce: true },
    });
    const reduce = reduced.structuredContent as {
      fallback?: boolean;
      verified?: boolean;
      sourceHandle?: string;
    };
    expect(reduce.fallback).toBe(false);
    expect(reduce.verified).toBe(true);
    expect(reduce.sourceHandle).toMatch(/^gfo:/);
  });
});
