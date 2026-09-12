import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_HOOK_SCRIPT,
  getCodexHooksStatus,
  installCodexHooks,
  uninstallCodexHooks,
} from "../src/integrations/codex-hooks";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

interface NestedHooksFile {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
}

function readHooks(path: string): NestedHooksFile {
  return JSON.parse(readFileSync(path, "utf8")) as NestedHooksFile;
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

describe("Codex CLI hooks", () => {
  it("reports not detected when Codex home is absent", () => {
    const dir = makeTempRoot("gf-codex-hooks-status-");
    const status = getCodexHooksStatus({
      codexHome: join(dir, "missing-codex"),
      hooksPath: join(dir, "missing-codex", "hooks.json"),
      hooksDir: join(dir, "missing-codex", "graphflow-hooks"),
    });
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.agent).toBe("Codex CLI hooks");
  });

  it("installs nested hooks + script and is idempotent", () => {
    const dir = makeTempRoot("gf-codex-hooks-install-");
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    const hooksDir = join(codexHome, "graphflow-hooks");

    const created = installCodexHooks({ hooksPath, hooksDir });
    expect(created.status).toBe("created");
    const status = getCodexHooksStatus({ codexHome, hooksPath, hooksDir });
    expect(status.installed).toBe(true);
    expect(readFileSync(status.scriptPath, "utf8")).toContain("outcome report");

    const json = readHooks(hooksPath);
    expect(json.hooks?.SessionStart?.[0]?.hooks[0]?.command).toContain(CODEX_HOOK_SCRIPT);
    expect(json.hooks?.SessionEnd?.[0]?.hooks[0]?.command).toContain(CODEX_HOOK_SCRIPT);

    expect(installCodexHooks({ hooksPath, hooksDir }).status).toBe("skipped");
  });

  it("preserves existing user hooks and uninstall removes only GraphFlow entries", () => {
    const dir = makeTempRoot("gf-codex-hooks-merge-");
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    const hooksDir = join(codexHome, "graphflow-hooks");

    writeFileSync(
      hooksPath,
      `${JSON.stringify(
        {
          description: "user hooks",
          hooks: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo user" }] }],
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    installCodexHooks({ hooksPath, hooksDir });
    const afterInstall = readHooks(hooksPath);
    expect(afterInstall.hooks?.SessionStart).toHaveLength(2);
    expect(afterInstall.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe("echo user");

    const removed = uninstallCodexHooks(hooksPath, hooksDir);
    expect(removed.status).toBe("updated");
    const afterUninstall = readHooks(hooksPath);
    expect(afterUninstall.hooks?.SessionStart).toHaveLength(1);
    expect(afterUninstall.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe("echo user");
    expect(afterUninstall.hooks?.SessionEnd).toBeUndefined();
    expect(existsSync(join(hooksDir, CODEX_HOOK_SCRIPT))).toBe(false);
  });

  it("refuses to overwrite malformed hooks.json", () => {
    const dir = makeTempRoot("gf-codex-hooks-bad-");
    const codexHome = join(dir, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    const hooksDir = join(codexHome, "graphflow-hooks");
    writeFileSync(hooksPath, "{not json", "utf8");

    expect(installCodexHooks({ hooksPath, hooksDir }).status).toBe("error");
    expect(readFileSync(hooksPath, "utf8")).toBe("{not json");
  });
});
