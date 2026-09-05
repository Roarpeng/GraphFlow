import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_GLUE_PACKAGE,
  DSH_GLUE_ROW_ID,
  DSH_MCP_ROW_ID,
  buildGraphFlowDshInsertPatch,
  getDshHarnessStatus,
  installDshHarness,
  uninstallDshHarness,
} from "../src/integrations/dsh-harness-installer";
import { getAgentSkillTargets, installAgentSkills } from "../src/integrations/skill-installer";
import { buildDoctorReport } from "../src/surfaces/cli/init";
import {
  apply,
  buildContextHint,
  buildHintMessage,
  closePendingEpisodeForCwd,
  isAutoCaptureEnabled,
  latestPendingEpisodeId,
  loadGraphFlowSkillRegistration,
  resolveConnectionService,
} from "../dsh/plugin.mjs";

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
      // ignore
    }
  }
});

/** Minimal fake child for capture tests: EventEmitter + PassThrough stdio. */
interface FakeSpawnChild {
  stdout: PassThrough;
  stderr: PassThrough;
  killed?: boolean;
  kill: () => void;
  emit: (event: string, ...args: unknown[]) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

function makeFakeSpawnChild(): FakeSpawnChild {
  const child = new EventEmitter() as unknown as FakeSpawnChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

/** Drive one fake child to a terminal state (streams end, exit/close fire). */
function settleFakeChild(child: FakeSpawnChild, exitCode: number | null, stdout = "", stderr = "") {
  child.stdout.end(stdout);
  child.stderr.end(stderr);
  child.emit("exit", exitCode, null);
  child.emit("close", exitCode, null);
}

describe("dsh insert layer includes cwd and glue", () => {
  it("buildGraphFlowDshInsertPatch matches root cordis.patch.yml including cwd", () => {
    const file = readFileSync(join(__dirname, "..", "cordis.patch.yml"), "utf8").replace(/\r\n/g, "\n");
    const insert = buildGraphFlowDshInsertPatch().trim();
    expect(insert).toContain("cwd: !!js process.cwd()");
    expect(insert).toContain(`id: ${DSH_GLUE_ROW_ID}`);
    expect(insert).toContain(`name: '${DSH_GLUE_PACKAGE}'`);
    expect(insert).not.toContain("GRAPHFLOW_WORKSPACE_ROOT");
    expect(file).toContain(insert);
    expect(file).toContain(`id: ${DSH_MCP_ROW_ID}`);
    expect(file).not.toMatch(/GRAPHFLOW_WORKSPACE_ROOT\s*:/);
  });

  it("package.json exports ./dsh to the ESM glue", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(pkg.exports?.["./dsh"]).toBe("./dsh/plugin.mjs");
    expect(pkg.files).toContain("dsh");
  });
});

describe("dsh installer overlay + skill path", () => {
  it("writes glue + cwd overlay and skill-installer writes $DSH_HOME/skills/graphflow/SKILL.md", () => {
    const dir = makeTempRoot("gf-dsh-skill-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const prev = process.env.GRAPHFLOW_DSH_HOME;
    process.env.GRAPHFLOW_DSH_HOME = dshHome;
    try {
      const created = installDshHarness({ dshHome });
      expect(created.status).toBe("created");
      const patch = readFileSync(join(dshHome, "cordis.patch.yml"), "utf8");
      expect(patch).toContain("cwd: !!js process.cwd()");
      expect(patch).toContain(`id: ${DSH_GLUE_ROW_ID}`);

      const skillTarget = getAgentSkillTargets().find((t) => t.agent === "DeepSeek Harness");
      expect(skillTarget?.skillsRoot).toBe(join(dshHome, "skills"));

      const skills = installAgentSkills();
      const dshSkill = skills.find((s) => s.target === "DeepSeek Harness");
      expect(dshSkill?.status).toMatch(/^(created|updated|skipped)$/);
      expect(dshSkill?.status).not.toBe("error");

      const status = getDshHarnessStatus({ dshHome });
      expect(status.installed).toBe(true);
      expect(status.glueInstalled).toBe(true);
      expect(status.skillInstalled).toBe(true);
      expect(status.skillPath).toBe(join(dshHome, "skills", "graphflow", "SKILL.md"));
      expect(readFileSync(status.skillPath, "utf8")).toContain("name: \"graphflow\"");

      const doctor = buildDoctorReport(process.cwd());
      expect(
        doctor.checks.some((c) => c.category === "mcp" && c.agent === "DeepSeek Harness" && c.status === "installed")
      ).toBe(true);
      expect(
        doctor.checks.some(
          (c) => c.category === "hooks" && c.agent === "DeepSeek Harness glue" && c.status === "installed"
        )
      ).toBe(true);
      expect(
        doctor.checks.some(
          (c) => c.category === "skill" && c.agent === "DeepSeek Harness skill" && c.status === "installed"
        )
      ).toBe(true);

      uninstallDshHarness({ dshHome });
      rmSync(join(dshHome, "skills", "graphflow"), { recursive: true, force: true });
      expect(getDshHarnessStatus({ dshHome }).installed).toBe(false);
      expect(getDshHarnessStatus({ dshHome }).glueInstalled).toBe(false);
      expect(getDshHarnessStatus({ dshHome }).skillInstalled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GRAPHFLOW_DSH_HOME;
      else process.env.GRAPHFLOW_DSH_HOME = prev;
    }
  });
});

describe("dsh ESM glue plugin", () => {
  it("apply does not throw when ctx.skills and events are missing", () => {
    expect(() => apply({})).not.toThrow();
    expect(() => apply({ skills: undefined, on: undefined })).not.toThrow();
  });

  it("apply does not throw when skills.register or ctx.on throw", () => {
    const ctx = {
      skills: {
        register() {
          throw new Error("skills service exploded");
        },
      },
      on() {
        throw new Error("no such event");
      },
    };
    expect(() => apply(ctx)).not.toThrow();
  });

  it("registers the GraphFlow skill body when ctx.skills exists", () => {
    const registered: unknown[] = [];
    const ctx = {
      skills: {
        register(skill: unknown) {
          registered.push(skill);
        },
      },
    };
    apply(ctx);
    expect(registered).toHaveLength(1);
    const skill = registered[0] as { name: string; description: string; content: string };
    expect(skill.name).toBe("graphflow");
    expect(skill.description.length).toBeGreaterThan(10);
    expect(skill.content).toContain("graphflow_context");
  });

  it("extends the enter decision with a same-step hint and closes pending episode on agent/disposed", async () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const injected: unknown[] = [];
    const spawned: Array<{ bin: string; args: string[]; cwd?: string }> = [];
    const userMessage = { role: "user", content: [{ type: "text", text: "hey" }] };
    const agent = {
      inject(message: unknown) {
        injected.push(message);
      },
    };
    const ctx = {
      skills: { register() {} },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers[event] = handler;
      },
    };
    const workspace = makeTempRoot("gf-dsh-glue-ep-");
    mkdirSync(join(workspace, ".graphflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({
        version: 1,
        kind: "pending-episode",
        episodeId: "ep-dsh-1",
        task: "demo",
        taskKey: "demo",
        createdAt: Date.now(),
      })}\n`,
      "utf8"
    );

    apply(ctx, {
      cwd: workspace,
      spawn: ((bin: string, args: string[], opts?: { cwd?: string }) => {
        spawned.push({ bin, args, cwd: opts?.cwd });
        return { unref() {} };
      }) as typeof import("node:child_process").spawn,
    });

    expect(typeof handlers["agent/pre-step"]).toBe("function");
    expect(typeof handlers["agent/disposed"]).toBe("function");
    expect(handlers["session/flush"]).toBeUndefined();
    const next = (): { kind: string; messages: unknown[] } => ({ kind: "enter", messages: [userMessage] });
    const decision = await handlers["agent/pre-step"]?.({ agent, cwd: workspace }, next);
    expect(injected).toHaveLength(0);
    expect(decision).toMatchObject({ kind: "enter" });
    const messages = (decision as { messages: Array<{ content?: Array<{ text?: string }>; source?: unknown }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(userMessage);
    expect(messages[1]?.content?.[0]?.text).toContain("mcp__graphflow__graphflow_context");
    expect(messages[1]?.content?.[0]?.text).toContain(`rootDir=${workspace}`);
    expect(messages[1]?.content?.[0]?.text?.length).toBeLessThan(240);
    expect(messages[1]?.source).toEqual({ kind: "plugin", plugin: "graphflow-dsh", form: "instructions" });

    handlers["agent/disposed"]?.({ agent, cwd: workspace });
    expect(spawned).toHaveLength(0);
  });

  it("does not attach a first-turn hint or consume WeakSet gating on a non-enter decision", async () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const injected: unknown[] = [];
    const agent = {
      inject(message: unknown) {
        injected.push(message);
      },
    };
    apply(
      {
        skills: { register() {} },
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers[event] = handler;
        },
      },
      { cwd: "/tmp/ws" }
    );

    const skip = await handlers["agent/pre-step"]?.(
      { agent, cwd: "/tmp/ws" },
      () => ({ kind: "skip", messages: [] })
    );
    expect(skip).toEqual({ kind: "skip", messages: [] });
    expect(injected).toHaveLength(0);

    const userMessage = { role: "user", content: [{ type: "text", text: "hey" }] };
    const enter = (await handlers["agent/pre-step"]?.(
      { agent, cwd: "/tmp/ws" },
      async () => ({ kind: "enter", messages: [userMessage] })
    )) as { kind: string; messages: Array<{ source?: unknown }> };
    expect(enter.kind).toBe("enter");
    expect(enter.messages).toHaveLength(2);
    expect(enter.messages[1]?.source).toEqual({ kind: "plugin", plugin: "graphflow-dsh", form: "instructions" });
    expect(injected).toHaveLength(0);

    const again = (await handlers["agent/pre-step"]?.(
      { agent, cwd: "/tmp/ws" },
      () => ({ kind: "enter", messages: [userMessage] })
    )) as { messages: unknown[] };
    expect(again.messages).toHaveLength(1);
    expect(injected).toHaveLength(0);
  });

  it("reports outcome on agent/disposed only when GRAPHFLOW_HOOK_SUCCESS is explicit", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const spawned: Array<{ args: string[] }> = [];
    const workspace = makeTempRoot("gf-dsh-glue-success-");
    mkdirSync(join(workspace, ".graphflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({ episodeId: "ep-dsh-1", task: "demo", createdAt: Date.now() })}\n`,
      "utf8"
    );
    apply(
      {
        skills: { register() {} },
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers[event] = handler;
        },
      },
      {
        cwd: workspace,
        env: { GRAPHFLOW_HOOK_SUCCESS: "true" },
        spawn: ((_bin: string, args: string[]) => {
          spawned.push({ args });
          return { unref() {} };
        }) as typeof import("node:child_process").spawn,
      }
    );
    handlers["agent/disposed"]?.({ cwd: workspace });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["graphflow", "outcome", "report", "ep-dsh-1", "true"])
    );
  });

  it("does not close pending episodes on session/flush", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const spawned: unknown[] = [];
    const workspace = makeTempRoot("gf-dsh-glue-flush-");
    mkdirSync(join(workspace, ".graphflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({ episodeId: "ep-flush", task: "still-working", createdAt: Date.now() })}\n`,
      "utf8"
    );
    apply(
      {
        skills: { register() {} },
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers[event] = handler;
        },
      },
      {
        cwd: workspace,
        spawn: ((..._args: unknown[]) => {
          spawned.push(_args);
          return { unref() {} };
        }) as typeof import("node:child_process").spawn,
      }
    );
    expect(handlers["session/flush"]).toBeUndefined();
    expect(spawned).toHaveLength(0);
  });

  it("skips outcome spawn when GRAPHFLOW_AUTO_CAPTURE is off", () => {
    const spawned: unknown[] = [];
    const workspace = makeTempRoot("gf-dsh-glue-off-");
    mkdirSync(join(workspace, ".graphflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({ episodeId: "ep-off", task: "x", createdAt: 1 })}\n`,
      "utf8"
    );
    const result = closePendingEpisodeForCwd(workspace, {
      env: { GRAPHFLOW_AUTO_CAPTURE: "0" },
      spawn: ((..._args: unknown[]) => {
        spawned.push(_args);
        return { unref() {} };
      }) as typeof import("node:child_process").spawn,
    });
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("auto-capture-off");
    expect(spawned).toHaveLength(0);
  });

  it("skips outcome spawn when GRAPHFLOW_HOOK_SUCCESS is unset", () => {
    const spawned: unknown[] = [];
    const workspace = makeTempRoot("gf-dsh-glue-pending-");
    mkdirSync(join(workspace, ".graphflow"), { recursive: true });
    writeFileSync(
      join(workspace, ".graphflow", "session-journal.jsonl"),
      `${JSON.stringify({ episodeId: "ep-pending", task: "x", createdAt: 1 })}\n`,
      "utf8"
    );
    const result = closePendingEpisodeForCwd(workspace, {
      env: {},
      spawn: ((..._args: unknown[]) => {
        spawned.push(_args);
        return { unref() {} };
      }) as typeof import("node:child_process").spawn,
    });
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("no-explicit-success");
    expect(result.episodeId).toBe("ep-pending");
    expect(spawned).toHaveLength(0);
  });

  it("loadGraphFlowSkillRegistration and helpers are stable", () => {
    const skill = loadGraphFlowSkillRegistration(join(__dirname, ".."));
    expect(skill.name).toBe("graphflow");
    expect(skill.path).toContain("SKILL.md");
    expect(isAutoCaptureEnabled({})).toBe(true);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "false" })).toBe(false);
    expect(buildContextHint("/tmp/proj")).toContain("rootDir=/tmp/proj");
    const hint = buildHintMessage("/tmp/proj");
    expect(hint.source).toEqual({ kind: "plugin", plugin: "graphflow-dsh", form: "instructions" });
    expect(hint.content[0]?.text).toContain("rootDir=/tmp/proj");
    expect(resolveConnectionService({ get: () => undefined, connection: { rpc: {} } })).toEqual({ rpc: {} });
    expect(resolveConnectionService({ get: () => ({ rpc: { handle() {} } }) })?.rpc).toBeDefined();
    const journal = join(makeTempRoot("gf-dsh-journal-"), "empty.jsonl");
    expect(latestPendingEpisodeId(journal)).toBeUndefined();
  });
});

describe("inbox auto-record (dialogue turn capture)", () => {
  it("isUserOriginatedMessage filters harness/system injections", async () => {
    const { isUserOriginatedMessage } = await import("../dsh/plugin.mjs");
    // Whitelist: only genuine human input records.
    expect(isUserOriginatedMessage({ source: { kind: "user" }, content: [] })).toBe(true);
    // Base harness kinds.
    expect(isUserOriginatedMessage({ source: { kind: "plugin", plugin: "x" }, content: [] })).toBe(false);
    expect(isUserOriginatedMessage({ source: { kind: "tool", callId: "c" }, content: [] })).toBe(false);
    expect(isUserOriginatedMessage({ source: { kind: "model" }, content: [] })).toBe(false);
    // Plugin-added harness kinds (verified against dsh 1.9.16 sources).
    expect(
      isUserOriginatedMessage({
        source: { kind: "subagent-settled", form: "notice", summary: "x", senderSessionId: "s" },
        content: [{ type: "text", text: "Background subagent c-1 finished and will do no further work." }],
      })
    ).toBe(false);
    expect(
      isUserOriginatedMessage({
        source: { kind: "subagent-report", form: "relay", senderSessionId: "s" },
        content: [{ type: "text", text: "Background subagent c-1 reported:" }],
      })
    ).toBe(false);
    expect(
      isUserOriginatedMessage({
        source: { kind: "agent-instructions", form: "instructions", changes: [] },
        content: [{ type: "text", text: "Instructions from AGENTS.md" }],
      })
    ).toBe(false);
    expect(
      isUserOriginatedMessage({
        source: { kind: "session-reference", form: "recall", version: 1, references: [] },
        content: [{ type: "text", text: "Material lifted out of another session's log." }],
      })
    ).toBe(false);
    expect(
      isUserOriginatedMessage({
        source: { kind: "goal", goalId: "g", revision: 1, round: 2 },
        content: [{ type: "text", text: "Goal round 2: continue the objective" }],
      })
    ).toBe(false);
    expect(
      isUserOriginatedMessage({
        source: { kind: "skill-catalog", form: "catalog", entries: [] },
        content: [{ type: "text", text: "<system-reminder> available skills" }],
      })
    ).toBe(false);
    // The glue's own hint carries source.kind "plugin" (form: instructions).
    expect(
      isUserOriginatedMessage({
        source: { kind: "plugin", plugin: "graphflow-dsh", form: "instructions" },
        content: [{ type: "text", text: "GraphFlow: before large code reads, call mcp__graphflow__graphflow_context" }],
      })
    ).toBe(false);
    // unknown/missing source falls back to role
    expect(isUserOriginatedMessage({ role: "user", content: [] })).toBe(true);
    expect(isUserOriginatedMessage({ role: "system", content: [] })).toBe(false);
    expect(isUserOriginatedMessage(undefined)).toBe(false);
  });

  it("recordDialogueFromInbox skips non-user messages without spawning", async () => {
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return { unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const { recordDialogueFromInbox } = await import("../dsh/plugin.mjs");

    const injected = recordDialogueFromInbox(
      { source: { kind: "plugin", plugin: "harness" }, content: [{ type: "text", text: "background job bash-1 finished" }] },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(injected.attempted).toBe(false);
    expect(injected.reason).toBe("not-user-message");

    const tool = recordDialogueFromInbox(
      { source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "tool result text" }] },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(tool.attempted).toBe(false);
    expect(tool.reason).toBe("not-user-message");

    const settled = recordDialogueFromInbox(
      {
        source: { kind: "subagent-settled", form: "notice", summary: "x", senderSessionId: "c2" },
        content: [{ type: "text", text: "Background subagent c2 finished and will do no further work unless you send it more." }],
      },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(settled.attempted).toBe(false);
    expect(settled.reason).toBe("not-user-message");

    const report = recordDialogueFromInbox(
      {
        source: { kind: "subagent-report", form: "relay", senderSessionId: "c2" },
        content: [{ type: "text", text: "Background subagent c2 reported:" }],
      },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(report.attempted).toBe(false);
    expect(report.reason).toBe("not-user-message");

    const runtimeContext = recordDialogueFromInbox(
      {
        source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot", sections: [] },
        content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }],
      },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(runtimeContext.attempted).toBe(false);
    expect(runtimeContext.reason).toBe("not-user-message");

    expect(spawned).toHaveLength(0);
  });
  it("recordDialogueFromInbox still records a real user question (source.kind user)", async () => {
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return { unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const { recordDialogueFromInbox, resolveCliCommand } = await import("../dsh/plugin.mjs");

    const ok = recordDialogueFromInbox(
      { source: { kind: "user" }, content: [{ type: "text", text: "这个功能怎么实现" }] },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(ok.attempted).toBe(true);
    expect(ok.workspace).toBe("/tmp/ws");
    expect(spawned).toHaveLength(1);
    const [bin, args, opts] = spawned[0] as [string, string[], { cwd: string }];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual([
      resolveCliCommand(join(__dirname, "..")),
      "dialogue",
      "record",
      "--query",
      "这个功能怎么实现",
    ]);
    expect(opts.cwd).toBe("/tmp/ws");
  });
  it("extractMessageText pulls text blocks and skips non-text", async () => {
    const { extractMessageText } = await import("../dsh/plugin.mjs");
    expect(
      extractMessageText({
        content: [
          { type: "text", text: "你好" },
          { type: "tool", tool: "x" },
          { type: "text", text: "世界" },
        ],
      })
    ).toBe("你好\n世界");
    expect(extractMessageText({ content: [{ type: "image" }] })).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText({ content: "nope" })).toBe("");
  });

  it("recordDialogueFromInbox spawns the local CLI with --query and skips short/disabled input", async () => {
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return { unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const { recordDialogueFromInbox, resolveCliCommand } = await import("../dsh/plugin.mjs");

    const ok = recordDialogueFromInbox(
      { content: [{ type: "text", text: "这个功能怎么实现" }] },
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(ok.attempted).toBe(true);
    expect(ok.workspace).toBe("/tmp/ws");
    expect(spawned).toHaveLength(1);
    const [bin, args, opts] = spawned[0] as [string, string[], { cwd: string }];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual([
      resolveCliCommand(join(__dirname, "..")),
      "dialogue",
      "record",
      "--query",
      "这个功能怎么实现",
    ]);
    expect(opts.cwd).toBe("/tmp/ws");

    const short = recordDialogueFromInbox({ content: [{ type: "text", text: "hi" }] }, "/tmp/ws", {
      spawn: fakeSpawn,
      env: {},
    });
    expect(short.attempted).toBe(false);
    expect(short.reason).toBe("query-too-short");

    const off = recordDialogueFromInbox({ content: [{ type: "text", text: "xxxxx" }] }, "/tmp/ws", {
      spawn: fakeSpawn,
      env: { GRAPHFLOW_AUTO_CAPTURE: "0" },
    });
    expect(off.attempted).toBe(false);
    expect(off.reason).toBe("auto-capture-off");
    expect(spawned).toHaveLength(1);
  });
});

describe("assistant reply auto-fill (dialogue turn close loop)", () => {
  it("recordReplyFromTurn queues the fill; CLI fallback spawns both idempotent tip fills", async () => {
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return { unref() {}, on() {}, once() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const { recordReplyFromTurn, resolveCliForCapture } = await import("../dsh/plugin.mjs");
    // Empty packageRoot → co-located runtime unavailable → CLI fallback path.
    const packageRoot = makeTempRoot("gf-glue-empty-pkg-");

    const result = recordReplyFromTurn(
      { type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "这样实现即可" }] } },
      "sess-123",
      "/tmp/ws",
      { spawn: fakeSpawn, env: {}, packageRoot }
    );
    expect(result.attempted).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.key).toBe("sess-123");
    expect(result.workspace).toBe("/tmp/ws");

    // The fill itself runs asynchronously in the background queue.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(spawned).toHaveLength(2);

    const cli = resolveCliForCapture(packageRoot);
    const expectedBin = cli === "graphflow" ? "npx" : process.execPath;
    const expectedPrefix = cli === "graphflow" ? ["-y", "--package=@roarpeng/graphflow", "graphflow"] : [cli];
    const [bin1, args1, opts1] = spawned[0] as [string, string[], { cwd: string }];
    expect(bin1).toBe(expectedBin);
    expect(args1).toEqual([
      ...expectedPrefix,
      "context",
      "preview",
      "--reply",
      "这样实现即可",
      "--session",
      "sess-123",
    ]);
    expect(opts1.cwd).toBe("/tmp/ws");
    const [bin2, args2, opts2] = spawned[1] as [string, string[], { cwd: string }];
    expect(bin2).toBe(expectedBin);
    expect(args2).toEqual([
      ...expectedPrefix,
      "dialogue",
      "record",
      "--reply",
      "这样实现即可",
      "--session",
      "sess-123",
    ]);
    expect(opts2.cwd).toBe("/tmp/ws");
  });

  it("recordReplyFromTurn skips interrupted, empty, and disabled input without spawning", async () => {
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return { unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const { recordReplyFromTurn } = await import("../dsh/plugin.mjs");

    const interrupted = recordReplyFromTurn(
      { type: "assistant/message", interrupted: true, message: { content: [{ type: "text", text: "半截回复" }] } },
      "sess-1",
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(interrupted.attempted).toBe(false);
    expect(interrupted.reason).toBe("interrupted");

    const empty = recordReplyFromTurn(
      { type: "assistant/message", message: { content: [{ type: "image" }] } },
      "sess-1",
      "/tmp/ws",
      { spawn: fakeSpawn, env: {} }
    );
    expect(empty.attempted).toBe(false);
    expect(empty.reason).toBe("no-text");

    const off = recordReplyFromTurn(
      { type: "assistant/message", message: { content: [{ type: "text", text: "完整回复" }] } },
      "sess-1",
      "/tmp/ws",
      { spawn: fakeSpawn, env: { GRAPHFLOW_AUTO_CAPTURE: "0" } }
    );
    expect(off.attempted).toBe(false);
    expect(off.reason).toBe("auto-capture-off");

    expect(spawned).toHaveLength(0);
  });

  it("fills assistant replies on turn/end (durable envelope), dedupes per turn, skips interrupted/aborted", async () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const spawned: Array<{ bin: string; args: string[]; cwd?: string }> = [];
    const workspace = makeTempRoot("gf-dsh-glue-reply-");
    // Empty packageRoot → co-located runtime unavailable → deterministic CLI fallback.
    const packageRoot = makeTempRoot("gf-dsh-glue-empty-pkg-");
    const ctx = {
      skills: { register() {} },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers[event] = handler;
      },
    };
    apply(ctx, {
      cwd: workspace,
      packageRoot,
      spawn: ((bin: string, args: string[], opts?: { cwd?: string }) => {
        spawned.push({ bin, args, cwd: opts?.cwd });
        return { unref() {}, on() {}, once() {} };
      }) as typeof import("node:child_process").spawn,
    });

    expect(typeof handlers["session/event"]).toBe("function");
    const session = { id: "sess-9", header: { cwd: workspace } };
    const message = { role: "assistant", content: [{ type: "text", text: "好，这样" }] };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

    // Durable session-event envelope: the assistant message lives at
    // `event.data.message` (NOT `event.message`), and steps carry `data.turn`.
    // `assistant/message` fires per step and must NOT fill by itself.
    handlers["session/event"]?.(session, { type: "assistant/message", seq: 1, time: 1, data: { turn: 3, message } });
    handlers["session/event"]?.(session, { type: "assistant/message", seq: 2, time: 2, data: { turn: 3, message } });
    await tick();
    expect(spawned).toHaveLength(0);

    // `turn/end` is the commit point: one fill per (session, turn).
    handlers["session/event"]?.(session, {
      type: "turn/end",
      seq: 3,
      time: 3,
      data: { turn: 3, reason: { kind: "completed" } },
    });
    await tick();
    expect(spawned.length).toBe(2);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["context", "preview", "--reply", "好，这样", "--session", "sess-9"])
    );
    expect(spawned[1]?.args).toEqual(
      expect.arrayContaining(["dialogue", "record", "--reply", "好，这样", "--session", "sess-9"])
    );
    for (const entry of spawned) {
      expect(entry.cwd).toBe(workspace);
    }

    // Replay of the same turn must not fill twice.
    handlers["session/event"]?.(session, {
      type: "turn/end",
      seq: 4,
      time: 4,
      data: { turn: 3, reason: { kind: "completed" } },
    });
    await tick();
    expect(spawned.length).toBe(2);

    // Aborted/interrupted turns never fill.
    handlers["session/event"]?.(session, { type: "assistant/message", seq: 5, time: 5, data: { turn: 4, message } });
    handlers["session/event"]?.(session, {
      type: "turn/end",
      seq: 6,
      time: 6,
      data: { turn: 4, reason: { kind: "aborted" } },
    });
    handlers["session/event"]?.(session, {
      type: "turn/end",
      seq: 7,
      time: 7,
      data: { turn: 5, reason: { kind: "interrupted" } },
    });
    await tick();
    expect(spawned.length).toBe(2);
  });
});

describe("static panel data channel (/gf nodes)", () => {
  it("collectNodesData spawns both CLIs with --json / --limit 50 in the workspace and unwraps data", async () => {
    const { collectNodesData } = await import("../dsh/plugin.mjs");
    const spawned: Array<{ bin: string; args: string[]; cwd?: string }> = [];
    const children: FakeSpawnChild[] = [];
    const fakeSpawn = ((bin: string, args: string[], opts?: { cwd?: string }) => {
      const child = makeFakeSpawnChild();
      spawned.push({ bin, args, cwd: opts?.cwd });
      children.push(child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Empty packageRoot + empty home → npx fallback
    // (`-y --package=@roarpeng/graphflow graphflow`).
    const promise = collectNodesData("/tmp/ws", {
      spawn: fakeSpawn,
      env: {},
      packageRoot: makeTempRoot("gf-nodes-empty-pkg-"),
      home: makeTempRoot("gf-nodes-home-"),
    });

    expect(spawned).toHaveLength(3);
    expect(children).toHaveLength(3);
    expect(spawned[0]?.bin).toBe("npx");
    expect(spawned[0]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "workbench",
      "tree",
      "--json",
    ]);
    expect(spawned[1]?.bin).toBe("npx");
    expect(spawned[1]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "dialogue",
      "list",
      "--json",
      "--limit",
      "50",
    ]);
    expect(spawned[2]?.bin).toBe("npx");
    expect(spawned[2]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "dialogue",
      "traces",
      "--json",
      "--limit",
      "50",
    ]);
    expect(spawned[0]?.cwd).toBe("/tmp/ws");
    expect(spawned[1]?.cwd).toBe("/tmp/ws");
    expect(spawned[2]?.cwd).toBe("/tmp/ws");

    // workbench stdout is a wrapping `{ data }` object (unwrapped); dialogue
    // stdout is a bare array (passed through).
    settleFakeChild(children[0] as FakeSpawnChild, 0, JSON.stringify({ data: { outlines: [{ rootId: "r1", task: "t1", nodes: [] }] } }));
    settleFakeChild(children[1] as FakeSpawnChild, 0, JSON.stringify([{ id: "d1", seq: 1, userQuery: "q1" }]));
    settleFakeChild(children[2] as FakeSpawnChild, 0, JSON.stringify([{ id: "tr1", agentKind: "subagent", status: "start" }]));

    await expect(promise).resolves.toEqual({
      ok: true,
      workbench: { outlines: [{ rootId: "r1", task: "t1", nodes: [] }] },
      dialogues: [{ id: "d1", seq: 1, userQuery: "q1" }],
      traces: [{ id: "tr1", agentKind: "subagent", status: "start" }],
    });
  });

  it("collectNodesData uses the co-located dist CLI and maps CLI/parse failures to null fields", async () => {
    const { collectNodesData, resolveCliForCapture } = await import("../dsh/plugin.mjs");
    const spawned: Array<{ bin: string; args: string[] }> = [];
    const children: FakeSpawnChild[] = [];
    const fakeSpawn = ((bin: string, args: string[]) => {
      const child = makeFakeSpawnChild();
      spawned.push({ bin, args });
      children.push(child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    // Real package root: the repo's dist CLI exists → node bin + dist argv.
    const packageRoot = join(__dirname, "..");
    const promise = collectNodesData("/tmp/ws", { spawn: fakeSpawn, env: {}, packageRoot });
    const cli = resolveCliForCapture(packageRoot);
    expect(spawned[0]?.bin).toBe(process.execPath);
    expect(spawned[0]?.args).toEqual([cli, "workbench", "tree", "--json"]);
    expect(spawned[1]?.args).toEqual([cli, "dialogue", "list", "--json", "--limit", "50"]);
    expect(spawned[2]?.args).toEqual([cli, "dialogue", "traces", "--json", "--limit", "50"]);

    // workbench exits 1 (stderr noise) → null; dialogue exits 0 but stdout is
    // not JSON → null. Overall ok stays true so the panel shows an empty state.
    settleFakeChild(children[0] as FakeSpawnChild, 1, "", "boom: workbench failed");
    settleFakeChild(children[1] as FakeSpawnChild, 0, "definitely not json");
    settleFakeChild(children[2] as FakeSpawnChild, 0, "");

    await expect(promise).resolves.toEqual({ ok: true, workbench: null, dialogues: null, traces: null });
  });

  it("collectNodesData returns no-workspace for a missing workspaceRoot without spawning", async () => {
    const { collectNodesData } = await import("../dsh/plugin.mjs");
    const spawned: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      spawned.push(args);
      return makeFakeSpawnChild();
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(collectNodesData("", { spawn: fakeSpawn, env: {} })).resolves.toEqual({
      ok: false,
      error: "no-workspace",
    });
    await expect(collectNodesData("   ", { spawn: fakeSpawn, env: {} })).resolves.toEqual({
      ok: false,
      error: "no-workspace",
    });
    await expect(collectNodesData(undefined as unknown as string, { spawn: fakeSpawn, env: {} })).resolves.toEqual({
      ok: false,
      error: "no-workspace",
    });
    expect(spawned).toHaveLength(0);
  });

  it("collectNodesData reports ok:false when spawn itself throws (infrastructure error)", async () => {
    const { collectNodesData } = await import("../dsh/plugin.mjs");
    const fakeSpawn = (() => {
      throw new Error("spawn ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await collectNodesData("/tmp/ws", {
      spawn: fakeSpawn,
      env: {},
      packageRoot: makeTempRoot("gf-nodes-empty-pkg-"),
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("ENOENT");
  });

  it("apply wires /gf nodes RPC: RpcResult envelope, idempotent registration, clean disposer", async () => {
    const registrations: Array<{ channel: string; handler: (...args: unknown[]) => unknown; options: unknown }> = [];
    const spawned: Array<{ bin: string; args: string[]; cwd?: string }> = [];
    const children: FakeSpawnChild[] = [];
    const fakeSpawn = ((bin: string, args: string[], opts?: { cwd?: string }) => {
      const child = makeFakeSpawnChild();
      spawned.push({ bin, args, cwd: opts?.cwd });
      children.push(child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const connection = {
      rpc: {
        handle(channel: string, handler: (...args: unknown[]) => unknown, options: unknown) {
          registrations.push({ channel, handler, options });
          return () => {
            // disposer is a plain function; calling it must not throw
          };
        },
      },
    };
    const ctx = {
      skills: { register() {} },
      on() {},
      connection,
    };
    const emptyPkg = makeTempRoot("gf-nodes-empty-pkg-");
    const cfg = { spawn: fakeSpawn, env: {}, packageRoot: emptyPkg, home: makeTempRoot("gf-nodes-home-") };
    const cleanup = apply(ctx, cfg) as (() => void) | undefined;

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.channel).toBe("/gf");
    expect(registrations[0]?.options).toEqual({ authority: "trusted-host" });
    const handler = registrations[0]?.handler as (...args: unknown[]) => unknown;

    // Success: the handler wraps collectNodesData into the RpcResult envelope.
    const okPromise = handler("nodes", { workspaceRoot: "/tmp/ws" }, undefined) as Promise<unknown>;
    expect(spawned).toHaveLength(3);
    expect(spawned[0]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "workbench",
      "tree",
      "--json",
    ]);
    expect(spawned[1]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "dialogue",
      "list",
      "--json",
      "--limit",
      "50",
    ]);
    expect(spawned[2]?.args).toEqual([
      "-y",
      "--package=@roarpeng/graphflow",
      "graphflow",
      "dialogue",
      "traces",
      "--json",
      "--limit",
      "50",
    ]);
    expect(spawned[0]?.cwd).toBe("/tmp/ws");
    settleFakeChild(children[0] as FakeSpawnChild, 0, JSON.stringify({ data: { outlines: [] } }));
    settleFakeChild(children[1] as FakeSpawnChild, 0, JSON.stringify([]));
    settleFakeChild(children[2] as FakeSpawnChild, 0, JSON.stringify([]));
    await expect(okPromise).resolves.toEqual({
      ok: true,
      value: { workbench: { outlines: [] }, dialogues: [], traces: [] },
    });

    // Missing workspace → bad-request envelope with the required issues field.
    await expect(handler("nodes", {}, undefined)).resolves.toEqual({
      ok: false,
      error: { code: "bad-request", message: "no-workspace", details: { issues: [] } },
    });

    // Unknown endpoint → bad-request too.
    const unknown = (await handler("other", {}, undefined)) as { ok: boolean };
    expect(unknown.ok).toBe(false);

    // Idempotent: a second apply without cleanup must not double-register.
    apply(ctx, cfg);
    expect(registrations).toHaveLength(1);

    // The apply return value is a disposer; after it runs, re-apply re-wires.
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup?.()).not.toThrow();
    apply(ctx, cfg);
    expect(registrations).toHaveLength(2);
  });

  it("registers /gf when connection arrives later via ctx.inject", async () => {
    const registrations: Array<{ channel: string }> = [];
    const logs: string[] = [];
    let injectCallback: ((injected: unknown) => void) | undefined;
    const connection = {
      rpc: {
        handle(channel: string) {
          registrations.push({ channel });
          return () => {};
        },
      },
    };
    const ctx = {
      skills: { register() {} },
      on() {},
      get() {
        return undefined;
      },
      inject(deps: unknown, callback: (injected: unknown) => void) {
        expect(deps).toEqual(["connection"]);
        injectCallback = callback;
      },
    };
    const cfg = {
      env: {},
      log: {
        warn(message: string) {
          logs.push(message);
        },
        error(message: string) {
          logs.push(message);
        },
      },
    };
    const cleanup = apply(ctx, cfg) as (() => void) | undefined;

    expect(registrations).toHaveLength(0);
    expect(typeof injectCallback).toBe("function");
    expect(logs.some((line) => line.includes("waiting via ctx.inject"))).toBe(true);

    injectCallback?.({ connection });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.channel).toBe("/gf");

    expect(typeof cleanup).toBe("function");
    expect(() => cleanup?.()).not.toThrow();
    injectCallback?.({ connection });
    expect(registrations).toHaveLength(1);

    apply(ctx, cfg);
    injectCallback?.({ connection });
    expect(registrations).toHaveLength(2);
  });

  it("logs when rpc.handle throws and does not stay wired", () => {
    const logs: string[] = [];
    let handleCalls = 0;
    const connection = {
      rpc: {
        handle() {
          handleCalls += 1;
          throw new Error("duplicate /gf route");
        },
      },
    };
    const ctx = {
      skills: { register() {} },
      on() {},
      connection,
    };
    const cfg = {
      log: {
        warn(message: string) {
          logs.push(message);
        },
        error(message: string) {
          logs.push(message);
        },
      },
    };
    expect(() => apply(ctx, cfg)).not.toThrow();
    expect(handleCalls).toBe(1);
    expect(logs.some((line) => line.includes('rpc.handle("/gf") failed') && line.includes("duplicate"))).toBe(true);

    apply(ctx, cfg);
    expect(handleCalls).toBe(2);
  });

  it("logs when inject fires but the connection still cannot register /gf", () => {
    const logs: string[] = [];
    let injectCallback: ((injected: unknown) => void) | undefined;
    apply(
      {
        skills: { register() {} },
        on() {},
        get() {
          return undefined;
        },
        inject(_deps: unknown, callback: (injected: unknown) => void) {
          injectCallback = callback;
        },
      },
      {
        log: {
          warn(message: string) {
            logs.push(message);
          },
          error(message: string) {
            logs.push(message);
          },
        },
      }
    );
    injectCallback?.({ connection: {} });
    expect(logs.some((line) => line.includes("connection.rpc.handle is missing"))).toBe(true);
    expect(logs.some((line) => line.includes("was not registered"))).toBe(true);
  });
});

describe("multi-agent trajectory capture (Conversation Graph W3a)", () => {
  it("normalizeSubagentTrace maps start/end identities into trace records", async () => {
    const { normalizeSubagentTrace } = await import("../dsh/plugin.mjs");
    const parent = { session: { id: "sess-1", header: { cwd: "/tmp/ws" } } };

    const start = normalizeSubagentTrace(
      { runId: "run-1", provider: "in-process", id: "child-1", local: true },
      parent
    );
    expect(start).toEqual({
      sessionId: "sess-1",
      turnSeq: 0,
      agentKind: "subagent",
      label: "in-process:child-1",
      status: "start",
    });

    const end = normalizeSubagentTrace(
      { runId: "run-1", provider: "in-process", id: "child-1", local: true, stopReason: "completed" },
      parent
    );
    expect(end?.status).toBe("settled");

    const failed = normalizeSubagentTrace(
      { runId: "run-2", provider: "in-process", id: "child-2", local: true, stopReason: "error" },
      parent
    );
    expect(failed?.status).toBe("failed");

    // Unknown shapes are skipped, never recorded.
    expect(normalizeSubagentTrace(undefined, parent)).toBeUndefined();
    expect(normalizeSubagentTrace({}, parent)).toBeUndefined();
    expect(normalizeSubagentTrace({ id: "child-3" }, undefined)?.sessionId).toBeUndefined();
  });

  it("isTraceCaptureEnabled obeys GRAPHFLOW_CAPTURE_TRACE", async () => {
    const { isTraceCaptureEnabled } = await import("../dsh/plugin.mjs");
    expect(isTraceCaptureEnabled({})).toBe(true);
    expect(isTraceCaptureEnabled({ GRAPHFLOW_CAPTURE_TRACE: "0" })).toBe(false);
    expect(isTraceCaptureEnabled({ GRAPHFLOW_CAPTURE_TRACE: "off" })).toBe(false);
    expect(isTraceCaptureEnabled({ GRAPHFLOW_CAPTURE_TRACE: "yes" })).toBe(true);
  });

  it("apply listens to subagent/start and subagent/end without throwing on a bare ctx", async () => {
    const listened: string[] = [];
    const ctx = {
      skills: { register() {} },
      on(event: string) {
        listened.push(event);
      },
    };
    const cfg = { spawn: (() => makeFakeSpawnChild()) as never, env: {}, packageRoot: makeTempRoot("gf-trace-pkg-") };
    expect(() => apply(ctx as never, cfg as never)).not.toThrow();
    expect(listened).toContain("subagent/start");
    expect(listened).toContain("subagent/end");
  });

  it("subagent events never throw when the runtime write path is absent", async () => {
    const { normalizeSubagentTrace } = await import("../dsh/plugin.mjs");
    const handlers: Record<string, (payload: unknown, parent: unknown) => void> = {};
    const ctx = {
      skills: { register() {} },
      on(event: string, handler: (payload: unknown, parent: unknown) => void) {
        handlers[event] = handler;
      },
    };
    const cfg = { env: {}, packageRoot: makeTempRoot("gf-trace-noruntime-") };
    apply(ctx as never, cfg as never);

    // fire the handlers — packageRoot has no dist runtime, so the write is a
    // silent no-op and nothing may throw into the harness loop.
    expect(() =>
      handlers["subagent/start"]?.(
        { runId: "r", provider: "in-process", id: "c", local: true },
        { session: { id: "s", header: { cwd: "/tmp/ws" } } }
      )
    ).not.toThrow();
    expect(() =>
      handlers["subagent/end"]?.(
        { runId: "r", provider: "in-process", id: "c", local: true, stopReason: "error" },
        { session: { id: "s", header: { cwd: "/tmp/ws" } } }
      )
    ).not.toThrow();
    // disabled switch short-circuits before any write
    expect(normalizeSubagentTrace({ id: "x" }, undefined)).toBeDefined();
  });
});
