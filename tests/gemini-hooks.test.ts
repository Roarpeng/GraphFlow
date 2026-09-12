import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_HOOK_SCRIPT,
  getGeminiHooksStatus,
  installGeminiHooks,
  uninstallGeminiHooks,
} from "../src/integrations/gemini-hooks";

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

describe("Gemini CLI hooks", () => {
  it("reports not detected when Gemini home is absent", () => {
    const dir = makeTempRoot("gf-gemini-hooks-status-");
    const status = getGeminiHooksStatus({
      geminiHome: join(dir, "missing-gemini"),
      settingsPath: join(dir, "missing-gemini", "settings.json"),
      hooksDir: join(dir, "missing-gemini", "graphflow-hooks"),
    });
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.agent).toBe("Gemini CLI hooks");
  });

  it("installs nested hooks + script and is idempotent", () => {
    const dir = makeTempRoot("gf-gemini-hooks-install-");
    const geminiHome = join(dir, ".gemini");
    mkdirSync(geminiHome, { recursive: true });
    const settingsPath = join(geminiHome, "settings.json");
    const hooksDir = join(geminiHome, "graphflow-hooks");

    const created = installGeminiHooks({ settingsPath, hooksDir });
    expect(created.status).toBe("created");
    const status = getGeminiHooksStatus({ geminiHome, settingsPath, hooksDir });
    expect(status.installed).toBe(true);
    expect(readFileSync(status.scriptPath, "utf8")).toContain("outcome report");

    const json = readHooks(settingsPath);
    expect(json.hooks?.SessionStart?.[0]?.hooks[0]?.command).toContain(GEMINI_HOOK_SCRIPT);
    expect(json.hooks?.SessionEnd?.[0]?.hooks[0]?.command).toContain(GEMINI_HOOK_SCRIPT);

    expect(installGeminiHooks({ settingsPath, hooksDir }).status).toBe("skipped");
  });

  it("preserves existing user hooks and uninstall removes only GraphFlow entries", () => {
    const dir = makeTempRoot("gf-gemini-hooks-merge-");
    const geminiHome = join(dir, ".gemini");
    mkdirSync(geminiHome, { recursive: true });
    const settingsPath = join(geminiHome, "settings.json");
    const hooksDir = join(geminiHome, "graphflow-hooks");

    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            SessionStart: [{ matcher: "startup", hooks: [{ name: "user", type: "command", command: "echo user" }] }],
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    installGeminiHooks({ settingsPath, hooksDir });
    const afterInstall = readHooks(settingsPath);
    expect(afterInstall.hooks?.SessionStart).toHaveLength(2);
    expect(afterInstall.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe("echo user");

    const removed = uninstallGeminiHooks(settingsPath, hooksDir);
    expect(removed.status).toBe("updated");
    const afterUninstall = readHooks(settingsPath);
    expect(afterUninstall.hooks?.SessionStart).toHaveLength(1);
    expect(afterUninstall.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe("echo user");
    expect(afterUninstall.hooks?.SessionEnd).toBeUndefined();
    expect(existsSync(join(hooksDir, GEMINI_HOOK_SCRIPT))).toBe(false);
  });

  it("refuses to overwrite malformed settings.json", () => {
    const dir = makeTempRoot("gf-gemini-hooks-bad-");
    const geminiHome = join(dir, ".gemini");
    mkdirSync(geminiHome, { recursive: true });
    const settingsPath = join(geminiHome, "settings.json");
    const hooksDir = join(geminiHome, "graphflow-hooks");
    writeFileSync(settingsPath, "{not json", "utf8");

    expect(installGeminiHooks({ settingsPath, hooksDir }).status).toBe("error");
    expect(readFileSync(settingsPath, "utf8")).toBe("{not json");
  });
});
