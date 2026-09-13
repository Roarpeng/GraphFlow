/**
 * file-parse-worker.ts — index worker thread entry.
 *
 * Receives one file task, reads + hashes it, and (when it actually changed)
 * runs the shared parse core. Only serializable data crosses the thread
 * boundary; the graph client, cache decisions, pruning and writes stay on the
 * main thread.
 *
 * Loaded by `file-parse-pool.ts`. Never throws into the parent: every failure is
 * reported as `{ ok: false, error }` so the pool can fall back to in-process
 * parsing.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { parseFileForIndex } from "./file-parse-core.js";
import type { FileParseTask, FileParseOutcome } from "./file-parse-pool.js";

async function handleTask(task: FileParseTask): Promise<FileParseOutcome> {
  let size = task.size;
  if (!Number.isFinite(size) || size <= 0) {
    try {
      size = statSync(task.absPath).size;
    } catch {
      size = 0;
    }
  }
  const content = readFileSync(task.absPath, "utf8");
  const currentHash = createHash("md5").update(content).digest("hex");

  if (!task.forceReindex && typeof task.prevHash === "string" && task.prevHash === currentHash) {
    return { unchanged: true, currentHash };
  }

  const parsed = await parseFileForIndex({ relPath: task.relPath, content, size });
  return {
    unchanged: false,
    currentHash,
    fileNodes: parsed.fileNodes,
    fileEdges: parsed.fileEdges,
    parsedEntry: parsed.parsedEntry,
  };
}

parentPort?.on("message", (message: { id: number; task: FileParseTask }) => {
  void (async () => {
    try {
      const outcome = await handleTask(message.task);
      parentPort?.postMessage({ id: message.id, ok: true, outcome });
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

export { handleTask };
