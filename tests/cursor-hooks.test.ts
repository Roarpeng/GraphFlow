import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_HOOK_SCRIPT,
  getCursorHooksStatus,
  installCursorHooks,
  uninstallCursorHooks,
} from "../src/integrations/cursor-hooks";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
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

describe("Cursor hooks status helper", () => {
  it("reports not detected when Cursor home is absent", () => {
    const dir = makeTempRoot("gf-cursor-hooks-status-");
    const status = getCursorHooksStatus({
      cursorHome: join(dir, "missing-cursor"),
      hooksPath: join(dir, "missing-cursor", "hooks.json"),
      hooksDir: join(dir, "missing-cursor", "graphflow-hooks"),
    });
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.agent).toBe("Cursor hooks");
  });

  it("installs the session script + hooks.json and reports installed", () => {
    const dir = makeTempRoot("gf-cursor-hooks-install-");
    const cursorHome = join(dir, ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    const hooksPath = join(cursorHome, "hooks.json");
    const hooksDir = join(cursorHome, "graphflow-hooks");

    const before = getCursorHooksStatus({ cursorHome, hooksPath, hooksDir });
    expect(before.detected).toBe(true);
    expect(before.installed).toBe(false);

    const result = installCursorHooks({ hooksPath, hooksDir });
    expect(result.status).toBe("created");

    const after = getCursorHooksStatus({ cursorHome, hooksPath, hooksDir });
    expect(after.installed).toBe(true);
    expect(after.scriptPath).toContain(CURSOR_HOOK_SCRIPT);

    const script = readFileSync(after.scriptPath, "utf8");
    expect(script).toContain("outcome report");
    expect(script).not.toContain('SUCCESS="${2:-true}"');
    expect(script).toContain('SUCCESS="${2:-}"');

    const json = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(json.version).toBe(1);
    expect(json.hooks.sessionStart[0]?.command).toContain(CURSOR_HOOK_SCRIPT);
    expect(json.hooks.sessionEnd[0]?.command).toContain(CURSOR_HOOK_SCRIPT);
    expect(json.hooks.stop[0]?.command).toContain(CURSOR_HOOK_SCRIPT);
  });

  it("merges without clobbering existing user hooks and is idempotent", () => {
    const dir = makeTempRoot("gf-cursor-hooks-merge-");
    const cursorHome = join(dir, ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    const hooksPath = join(cursorHome, "hooks.json");
    const hooksDir = join(cursorHome, "graphflow-hooks");

    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        { version: 1, hooks: { sessionStart: [{ command: "echo user" }] } },
        null,
        2
      )}\n`,
      "utf8"
    );

    installCursorHooks({ hooksPath, hooksDir });
    const json = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(json.hooks.sessionStart).toHaveLength(2);
    expect(json.hooks.sessionStart[0]?.command).toBe("echo user");

    const again = installCursorHooks({ hooksPath, hooksDir });
    expect(again.status).toBe("skipped");
  });

  it("refuses to overwrite malformed hooks.json", () => {
    const dir = makeTempRoot("gf-cursor-hooks-bad-");
    const cursorHome = join(dir, ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    const hooksPath = join(cursorHome, "hooks.json");
    const hooksDir = join(cursorHome, "graphflow-hooks");
    writeFileSync(hooksPath, "{not json", "utf8");

    const result = installCursorHooks({ hooksPath, hooksDir });
    expect(result.status).toBe("error");
    expect(readFileSync(hooksPath, "utf8")).toBe("{not json");
  });

  it("uninstall removes only GraphFlow entries and deletes the script", () => {
    const dir = makeTempRoot("gf-cursor-hooks-uninstall-");
    const cursorHome = join(dir, ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    const hooksPath = join(cursorHome, "hooks.json");
    const hooksDir = join(cursorHome, "graphflow-hooks");

    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        { version: 1, hooks: { sessionStart: [{ command: "echo user" }] } },
        null,
        2
      )}\n`,
      "utf8"
    );
    installCursorHooks({ hooksPath, hooksDir });

    const result = uninstallCursorHooks(hooksPath, hooksDir);
    expect(result.status).toBe("updated");

    const json = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(json.hooks.sessionStart).toHaveLength(1);
    expect(json.hooks.sessionStart[0]?.command).toBe("echo user");
    expect(json.hooks.sessionEnd).toBeUndefined();
    expect(existsSync(join(hooksDir, CURSOR_HOOK_SCRIPT))).toBe(false);
  });
});
