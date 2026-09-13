import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGlobalGraphFlowConfig, writeConfigSecure } from "../src/config/scaffold";

/**
 * M86 — the global config can hold `providers.<name>.apiKey`, so it is written
 * owner-only (0600) and an existing file is tightened on save. This is what the
 * dsh-plugin disclosure declares (`api_keys[].storage: "file-0600"`).
 *
 * POSIX-only assertions (mode bits); Windows has no equivalent.
 */

const tempRoots: string[] = [];
const modesSupported = process.platform !== "win32";

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

describe("M86 owner-only config writes", () => {
  it("writes a new config file 0600 and keeps the contents intact", () => {
    const dir = makeTempDir("gf-m86-new-");
    const path = join(dir, "graphflow.config.json");
    writeConfigSecure(path, '{ "providers": { "deepseek": { "apiKey": "sk-test" } } }\n');

    expect(readFileSync(path, "utf8")).toContain("sk-test");
    if (modesSupported) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("tightens a pre-existing world-readable config on save", () => {
    const dir = makeTempDir("gf-m86-tighten-");
    const path = join(dir, "graphflow.config.json");
    writeFileSync(path, "{}\n", "utf8");
    if (modesSupported) chmodSync(path, 0o644);

    writeConfigSecure(path, '{ "providers": {} }\n');

    if (modesSupported) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("creates the global config 0600 through ensureGlobalGraphFlowConfig", () => {
    const dir = makeTempDir("gf-m86-global-");
    const path = join(dir, "nested", "graphflow.config.json");

    const result = ensureGlobalGraphFlowConfig({ configPath: path });

    expect(result.status).toBe("created");
    expect(readFileSync(path, "utf8")).toContain("graphPolicy");
    if (modesSupported) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
