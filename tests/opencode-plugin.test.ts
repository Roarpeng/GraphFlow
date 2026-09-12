import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENCODE_PLUGIN_FILE,
  getOpenCodePluginStatus,
  installOpenCodePlugin,
  opencodePluginPath,
  resolveOpenCodePluginSourcePath,
  uninstallOpenCodePlugin,
} from "../src/integrations/opencode-plugin";
import {
  clipReplyText,
  createGraphFlowPlugin,
  extractTextPart,
  isEnabled,
  resolveWorkspaceDirectory,
} from "../opencode/plugin.mjs";

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

function makeFakeSpawn(): {
  calls: Array<{ bin: string; args: string[]; cwd?: string }>;
  spawnFn: (
    bin: string,
    args: string[],
    options?: { cwd?: string }
  ) => { on: (evt: string, cb: () => void) => void; kill: () => void };
} {
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  const spawnFn = (bin: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ bin, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    return {
      on(evt: string, cb: () => void) {
        if (evt === "close") cb();
      },
      kill() {
        // no-op
      },
    };
  };
  return { calls, spawnFn };
}

describe("opencode plugin installer", () => {
  it("finds the bundled plugin source in the repo", () => {
    const source = resolveOpenCodePluginSourcePath();
    expect(source).toBeTruthy();
    expect(existsSync(source as string)).toBe(true);
  });

  it("installs, is idempotent, and uninstalls the plugin", () => {
    const home = join(makeTempRoot("gf-opencode-plugin-"), "opencode");
    mkdirSync(home, { recursive: true });
    const dest = opencodePluginPath(home);

    const before = getOpenCodePluginStatus({ home });
    expect(before.detected).toBe(true);
    expect(before.installed).toBe(false);

    const created = installOpenCodePlugin({ home });
    expect(created.status).toBe("created");
    expect(existsSync(join(home, "plugins", OPENCODE_PLUGIN_FILE))).toBe(true);
    expect(getOpenCodePluginStatus({ home }).installed).toBe(true);

    const source = resolveOpenCodePluginSourcePath() as string;
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(source, "utf8"));

    const again = installOpenCodePlugin({ home });
    expect(again.status).toBe("skipped");

    const removed = uninstallOpenCodePlugin({ home });
    expect(removed.status).toBe("updated");
    expect(existsSync(dest)).toBe(false);
    expect(uninstallOpenCodePlugin({ home }).status).toBe("skipped");
  });
});

describe("opencode plugin glue", () => {
  it("honors the enable switch", () => {
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ GRAPHFLOW_OPENCODE_PLUGIN: "0" })).toBe(false);
    expect(isEnabled({ GRAPHFLOW_OPENCODE_PLUGIN: "false" })).toBe(false);
    expect(isEnabled({ GRAPHFLOW_OPENCODE_PLUGIN: "YES" })).toBe(true);
  });

  it("clips and normalizes reply text", () => {
    expect(clipReplyText("  hello\n\nworld  ")).toBe("hello world");
    expect(clipReplyText("abc\0def")).toBe("abcdef");
    expect(clipReplyText("x".repeat(10), 5)).toBe("xxxx…");
    expect(clipReplyText(undefined)).toBe("");
  });

  it("extracts text parts from message.part.updated events", () => {
    expect(
      extractTextPart({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "hi" } },
      })
    ).toEqual({ sessionID: "s1", text: "hi" });
    expect(
      extractTextPart({
        type: "message.part.updated",
        properties: { part: { type: "tool", sessionID: "s1" } },
      })
    ).toBeUndefined();
    expect(extractTextPart({ type: "session.idle" })).toBeUndefined();
  });

  it("captures the last reply and backfills on session.idle", async () => {
    const { calls, spawnFn } = makeFakeSpawn();
    const plugin = createGraphFlowPlugin({ spawn: spawnFn, env: {}, log: {} });
    const hooks = await plugin({});

    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "final  answer" } },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "context preview --reply final answer",
      "dialogue record --reply final answer",
    ]);
    expect(calls.every((call) => call.bin === "graphflow")).toBe(true);
  });

  it("resolves the session workspace from the opencode plugin context", () => {
    expect(
      resolveWorkspaceDirectory({ directory: "/proj/sub", worktree: "/proj", project: { worktree: "/p2" } })
    ).toBe("/proj");
    expect(resolveWorkspaceDirectory({ directory: "/proj/sub" })).toBe("/proj/sub");
    expect(resolveWorkspaceDirectory({ project: { worktree: "/p2" } })).toBe("/p2");
    expect(resolveWorkspaceDirectory({}, "/fallback")).toBe("/fallback");
    expect(resolveWorkspaceDirectory({ directory: "   " })).toBeUndefined();
    expect(resolveWorkspaceDirectory(undefined)).toBeUndefined();
  });

  it("runs CLI fills inside the session workspace instead of the host process cwd", async () => {
    const { calls, spawnFn } = makeFakeSpawn();
    const plugin = createGraphFlowPlugin({ spawn: spawnFn, env: {}, log: {} });
    const workspace = makeTempRoot("gf-opencode-workspace-");
    // opencode hands `directory`/`worktree` to the plugin function; the glue used
    // to drop them, so the child inherited the host cwd ($HOME when opencode was
    // started outside the project) and GraphFlow refused/recorded elsewhere.
    const hooks = await plugin({ directory: workspace, worktree: workspace });

    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "hello" } },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.cwd === workspace)).toBe(true);
  });

  it("falls back to config.cwd when the host context carries no directory", async () => {
    const { calls, spawnFn } = makeFakeSpawn();
    const workspace = makeTempRoot("gf-opencode-fallback-");
    const plugin = createGraphFlowPlugin({ spawn: spawnFn, env: {}, log: {}, cwd: workspace });
    const hooks = await plugin({});

    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "hi" } },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    expect(calls.every((call) => call.cwd === workspace)).toBe(true);
  });

  it("does nothing when disabled and never throws on unknown events", async () => {
    const disabled = makeFakeSpawn();
    const disabledPlugin = createGraphFlowPlugin({
      spawn: disabled.spawnFn,
      env: { GRAPHFLOW_OPENCODE_PLUGIN: "0" },
      log: {},
    });
    const disabledHooks = await disabledPlugin({});
    await disabledHooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "x" } },
      },
    });
    await disabledHooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(disabled.calls).toHaveLength(0);

    const enabled = makeFakeSpawn();
    const hooks = await createGraphFlowPlugin({ spawn: enabled.spawnFn, env: {}, log: {} })({});
    await expect(hooks.event({ event: { type: "file.edited" } })).resolves.toBeUndefined();
    await expect(hooks.event({})).resolves.toBeUndefined();
    expect(enabled.calls).toHaveLength(0);
  });
});
