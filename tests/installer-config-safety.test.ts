/**
 * GraphFlow — host config write safety.
 *
 * `installHostHook`/`writeMcpTarget` merge GraphFlow's entry into a config the user owns.
 * Reading that file through `readJsonSafe` (which degrades to `{}`) and then writing the
 * merge back replaces the whole file with GraphFlow's entry alone, so anything the user
 * had — other MCP servers, hooks, settings — disappears without a word. These tests pin
 * the three properties that prevent it:
 *
 *  1. an unparsable config is never overwritten, and a `.graphflow-bak` copy is left next
 *     to it so the user can fix instead of reinstall,
 *  2. JSONC configs (comments, trailing commas — VS Code `settings.json` is one) are still
 *     merged into rather than discarded,
 *  3. writes go through temp-file + rename, so the directory never keeps a stray `.tmp`
 *     and the file is never observed half-written.
 *
 * Standalone: `npx tsx tests/installer-config-safety.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostHook, removeHostHook } from "../src/agent-installer.js";

const failures: string[] = [];
let checks = 0;

function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

/** Fresh sandbox dir; removed at the end of the run. */
const sandboxes: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "gf-config-safety-"));
  sandboxes.push(dir);
  return dir;
}

function hookFile(dir: string, contents: string): string {
  const filePath = join(dir, "settings.json");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

check("an unparsable config is not overwritten and gets a .graphflow-bak copy", () => {
  const dir = sandbox();
  const broken = '{ "hooks": { "PreToolUse": [ {"matcher": "Bash"} ] },\n';
  const configPath = hookFile(dir, broken);

  assert.throws(
    () => installHostHook("claude", configPath),
    /refusing to overwrite .*not valid JSON/,
    "a config that cannot be parsed must abort the write"
  );

  assert.equal(readFileSync(configPath, "utf8"), broken, "the original file must be untouched");
  const backupPath = `${configPath}.graphflow-bak`;
  assert.ok(existsSync(backupPath), "a backup must be written next to the config");
  assert.equal(readFileSync(backupPath, "utf8"), broken, "the backup must match the original");
});

check("a valid config is merged into, keeping unrelated keys and user hooks", () => {
  const dir = sandbox();
  const configPath = hookFile(
    dir,
    JSON.stringify({
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }],
      },
    })
  );

  assert.equal(installHostHook("claude", configPath), "updated");

  const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(written.theme, "dark", "unrelated settings must survive");
  const text = JSON.stringify(written);
  assert.ok(text.includes("my-guard"), "the user's own hook must survive");
  assert.ok(text.includes("graphflow"), "the graphflow hook must be registered");
});

check("a commented JSONC config is merged into, not discarded", () => {
  const dir = sandbox();
  const configPath = hookFile(
    dir,
    [
      "{",
      "  // user settings, hand-edited",
      '  "editor.fontSize": 13,',
      '  "hooks": {',
      '    "PreToolUse": [ { "matcher": "Bash" } ],',
      "  },",
      "}",
      "",
    ].join("\n")
  );

  installHostHook("claude", configPath);

  const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(written["editor.fontSize"], 13, "a JSONC setting must not be dropped");
  assert.ok(JSON.stringify(written).includes("graphflow"), "the graphflow hook must be registered");
});

check("writes leave no temp file behind", () => {
  const dir = sandbox();
  const configPath = hookFile(dir, "{}\n");
  installHostHook("claude", configPath);
  const strays = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(strays, [], `stray temp files: ${strays.join(", ")}`);
});

check("removing hooks from an unparsable config also refuses", () => {
  const dir = sandbox();
  const broken = "{ hooks: comments-not-allowed-here }\n";
  const configPath = hookFile(dir, broken);

  assert.throws(() => removeHostHook("claude", configPath), /refusing to overwrite/);
  assert.equal(readFileSync(configPath, "utf8"), broken, "the original file must be untouched");
});

check("a missing config is still created from scratch", () => {
  const dir = sandbox();
  const configPath = join(dir, "nested", "settings.json");
  assert.equal(installHostHook("claude", configPath), "installed");
  const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.ok(JSON.stringify(written).includes("graphflow"));
});

for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });

console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
