import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileParsePool,
  defaultWorkerCount,
  resolveParseWorkerEntry,
  shouldUseWorkerPool,
  type FileParseOutcome,
  type FileParseTask,
  type WorkerLike,
} from "../src/graph/file-parse-pool";
import { parseFileForIndex } from "../src/graph/file-parse-core";

/**
 * M84 — index worker pool.
 *
 * Parsing is the dominant index cost on large workspaces (≈19 s of a 35 s
 * ragflow index before the reference-edge pruning). The pool fans it out over
 * worker threads while everything else (cache, pruning, writes) stays on the
 * main thread. It must be fail-open: any worker problem downgrades that task to
 * in-process parsing instead of failing the index.
 *
 * Worker dispatch is unit-tested with an injected fake worker; real worker
 * threads are additionally exercised when the built entry exists.
 */

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

interface FakeWorker extends WorkerLike {
  readonly posted: Array<{ id: number; task: FileParseTask }>;
  readonly terminated: boolean;
  respond(outcome: FileParseOutcome | Error): void;
}

function makeFakeWorker(): FakeWorker {
  const listeners = {
    message: [] as Array<(value: unknown) => void>,
    error: [] as Array<(error: Error) => void>,
    exit: [] as Array<(code: number) => void>,
  };
  const posted: Array<{ id: number; task: FileParseTask }> = [];
  const worker: FakeWorker = {
    posted,
    get terminated() {
      return terminated;
    },
    postMessage(message: unknown) {
      posted.push(message as { id: number; task: FileParseTask });
    },
    on(event: "message" | "error" | "exit", listener: never) {
      (listeners[event] as unknown[]).push(listener);
      return worker;
    },
    terminate() {
      terminated = true;
    },
    respond(outcome) {
      const last = posted[posted.length - 1];
      if (!last) throw new Error("no task posted");
      if (outcome instanceof Error) {
        for (const listener of listeners.error) listener(outcome);
        return;
      }
      for (const listener of listeners.message) listener({ id: last.id, ok: true, outcome });
    },
  };
  let terminated = false;
  return worker;
}

describe("M84 index worker pool", () => {
  it("reports the default worker count for this machine", () => {
    const count = defaultWorkerCount();
    expect(count === 0 || count >= 2).toBe(true);
  });

  it("only threads workspaces big enough, and honours the off switch", () => {
    expect(shouldUseWorkerPool(1000)).toBe(true);
    expect(shouldUseWorkerPool(3)).toBe(false);
    expect(shouldUseWorkerPool(1000, { indexWorkers: 0 })).toBe(false);
    expect(shouldUseWorkerPool(2, { indexWorkers: 4 })).toBe(false);
    expect(shouldUseWorkerPool(50, { indexWorkers: 4 })).toBe(true);
  });

  it("resolves the worker entry next to the running module", () => {
    const dir = makeTempDir("gf-m84-entry-");
    const modulePath = join(dir, "file-parse-pool.ts");
    writeFileSync(join(dir, "file-parse-worker.ts"), "export {};\n");

    expect(resolveParseWorkerEntry(modulePath)).toEqual({
      path: join(dir, "file-parse-worker.ts"),
      execArgv: ["--import", "tsx"],
    });
    // No sibling worker entry in this directory → pool must not be created.
    const emptyDir = makeTempDir("gf-m84-empty-");
    expect(resolveParseWorkerEntry(join(emptyDir, "file-parse-pool.ts"))).toBeUndefined();
  });

  it("dispatches tasks round-robin and resolves with the worker outcome", async () => {
    const workers = [makeFakeWorker(), makeFakeWorker()];
    let index = 0;
    const pool = createFileParsePool({
      workerCount: 2,
      workerEntry: { path: "/fake/worker.js", execArgv: [] },
      workerFactory: () => workers[index++]!,
    });
    expect(pool).toBeDefined();
    expect(pool!.size).toBe(2);

    const task = (relPath: string): FileParseTask => ({ relPath, absPath: `/tmp/${relPath}`, size: 10 });
    const first = pool!.run(task("a.ts"));
    const second = pool!.run(task("b.ts"));
    // Both slots are busy: the third task waits for a free worker.
    const third = pool!.run(task("c.ts"));
    expect(workers[0]!.posted).toHaveLength(1);
    expect(workers[1]!.posted).toHaveLength(1);

    workers[0]!.respond({ unchanged: true, currentHash: "h1" });
    workers[1]!.respond({ unchanged: false, currentHash: "h2", fileNodes: [], fileEdges: [], parsedEntry: undefined as never });

    await expect(first).resolves.toMatchObject({ unchanged: true, currentHash: "h1" });
    await expect(second).resolves.toMatchObject({ currentHash: "h2" });
    // The queued task now runs on the freed slot.
    expect(workers[0]!.posted.length + workers[1]!.posted.length).toBe(3);
    workers[0]!.respond({ unchanged: true, currentHash: "h3" });
    await expect(third).resolves.toMatchObject({ currentHash: "h3" });

    pool!.close();
  });

  it("rejects the failed task (caller falls back) and keeps serving later tasks", async () => {
    const workers = [makeFakeWorker(), makeFakeWorker(), makeFakeWorker()];
    let index = 0;
    const pool = createFileParsePool({
      workerCount: 2,
      workerEntry: { path: "/fake/worker.js", execArgv: [] },
      workerFactory: () => workers[Math.min(index++, workers.length - 1)]!,
    });

    const failing = pool!.run({ relPath: "boom.ts", absPath: "/tmp/boom.ts", size: 1 });
    workers[0]!.respond(new Error("worker exploded"));
    await expect(failing).rejects.toThrow(/worker exploded/);

    // The replacement worker (third fake) serves the next task.
    const next = pool!.run({ relPath: "ok.ts", absPath: "/tmp/ok.ts", size: 1 });
    workers[2]!.respond({ unchanged: true, currentHash: "ok" });
    await expect(next).resolves.toMatchObject({ currentHash: "ok" });
    pool!.close();
  });

  it("parses files identically in-process (shared parse core)", async () => {
    const result = await parseFileForIndex({
      relPath: "src/sample.ts",
      content: [
        "export function alpha(x: number): number { return x + 1; }",
        "export class Beta { gamma(): number { return alpha(1); } }",
      ].join("\n"),
      size: 128,
    });

    const fileNode = result.fileNodes.find((node) => node.id === "file:src/sample.ts");
    expect(fileNode).toBeDefined();
    const symbolNames = result.parsedEntry.declared.map((symbol) => symbol.name).sort();
    expect(symbolNames).toContain("alpha");
    expect(symbolNames).toContain("Beta");
    expect(result.fileEdges.some((edge) => edge.relation === "defines")).toBe(true);
  });
});
