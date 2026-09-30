#!/usr/bin/env node
/**
 * `prepare` lifecycle hook (runs on npm install AND npm pack).
 *
 * Git-hook wiring is a dev-only nicety: it must NEVER fail install or pack.
 * The previous `"husky || true"` was POSIX-only — on Windows cmd, `true` does
 * not exist, so a missing-husky checkout failed `npm pack` outright (live
 * report from a Windows tester). Run husky best-effort through the shell
 * (resolves husky.cmd on Windows) and always exit 0.
 */
const { spawnSync } = require("node:child_process");

try {
  spawnSync("husky", { shell: true, stdio: "ignore" });
} catch {
  // never fatal
}
process.exit(0);
