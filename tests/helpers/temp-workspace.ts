import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolated temp project under os.tmpdir() — never process.cwd() or $HOME.
 * Track roots and pass them to `rmTrackedRoots` in afterEach.
 */
export function createTempProjectRoot(prefix: string, tracker: string[]): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: prefix }), "utf8");
  mkdirSync(join(root, ".git"));
  tracker.push(root);
  return root;
}

export function createTempDir(prefix: string, tracker: string[]): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tracker.push(root);
  return root;
}

export function rmTrackedRoots(tracker: string[]): void {
  while (tracker.length > 0) {
    const root = tracker.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
