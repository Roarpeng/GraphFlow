import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  closePendingEpisodeForCwd,
  isAutoCaptureEnabled,
  latestPendingEpisodeId,
  loadGraphFlowSkillRegistration,
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

  it("injects a short pre-step hint and closes pending episode on agent/disposed", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const injected: unknown[] = [];
    const spawned: Array<{ bin: string; args: string[]; cwd?: string }> = [];
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
    const next = (): { kind: string } => ({ kind: "enter" });
    const decision = handlers["agent/pre-step"]?.({ agent, cwd: workspace }, next);
    expect(decision).toEqual({ kind: "enter" });
    expect(injected).toHaveLength(1);
    const hint = injected[0] as { content: Array<{ text: string }> };
    expect(hint.content[0]?.text).toContain("mcp__graphflow__graphflow_context");
    expect(hint.content[0]?.text).toContain(`rootDir=${workspace}`);
    expect(hint.content[0]?.text.length).toBeLessThan(240);

    handlers["agent/disposed"]?.({ agent, cwd: workspace });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["graphflow", "outcome", "report", "ep-dsh-1", "true"])
    );
    expect(spawned[0]?.cwd).toBe(workspace);
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

  it("loadGraphFlowSkillRegistration and helpers are stable", () => {
    const skill = loadGraphFlowSkillRegistration(join(__dirname, ".."));
    expect(skill.name).toBe("graphflow");
    expect(skill.path).toContain("SKILL.md");
    expect(isAutoCaptureEnabled({})).toBe(true);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "false" })).toBe(false);
    expect(buildContextHint("/tmp/proj")).toContain("rootDir=/tmp/proj");
    const journal = join(makeTempRoot("gf-dsh-journal-"), "empty.jsonl");
    expect(latestPendingEpisodeId(journal)).toBeUndefined();
  });
});
