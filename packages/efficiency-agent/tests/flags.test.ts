import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  benchArmFlags,
  DEFAULT_FLAGS,
  effectiveMode,
  FLAG_NAMES,
  isFlagName,
  parseFlagValue,
  readFlagsFile,
  resolveFlags,
  writeFlagsFile,
  type EffFlags,
} from "../src/flags.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eff-flags-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SPEC_22_DEFAULTS: Record<string, 0 | 1> = {
  EFF_AGENT_ENABLED: 0,
  EFF_SHADOW_MODE: 1,
  EFF_CONTEXT_REUSE: 1,
  EFF_PLAN_REUSE: 0,
  EFF_RESULT_REUSE: 0,
  EFF_TOOL_ROUTING: 1,
  EFF_MODEL_ROUTING: 1,
  EFF_SUBAGENT: 0,
  EFF_SELF_LEARNING: 0,
  EFF_DYNAMIC_HARNESS: 0,
  EFF_EXTERNAL_WRITE_APPROVAL: 1,
  EFF_NETWORK_DEFAULT: 0,
};

const asBits = (flags: EffFlags): Record<string, 0 | 1> =>
  Object.fromEntries(FLAG_NAMES.map((n) => [n, flags[n] ? 1 : 0])) as Record<string, 0 | 1>;

describe("feature flags (spec section 22 / 24)", () => {
  it("defaults equal spec section 22", () => {
    expect(asBits(DEFAULT_FLAGS)).toEqual(SPEC_22_DEFAULTS);
    expect([...FLAG_NAMES].sort()).toEqual(Object.keys(SPEC_22_DEFAULTS).sort());
    expect(Object.isFrozen(DEFAULT_FLAGS)).toBe(true);
    const resolved = resolveFlags();
    expect(asBits(resolved.flags)).toEqual(SPEC_22_DEFAULTS);
    expect(new Set(Object.values(resolved.sources))).toEqual(new Set(["default"]));
    expect(resolved.warnings).toEqual([]);
  });

  it("parseFlagValue / isFlagName", () => {
    for (const t of ["1", "true", "ON", " yes "]) expect(parseFlagValue(t)).toBe(true);
    for (const f of ["0", "false", "Off", "no"]) expect(parseFlagValue(f)).toBe(false);
    for (const bad of ["", "2", "maybe", "enabled"]) expect(parseFlagValue(bad)).toBeUndefined();
    expect(isFlagName("EFF_AGENT_ENABLED")).toBe(true);
    expect(isFlagName("EFF_NOPE")).toBe(false);
  });

  it("precedence default < file < env, with sources", () => {
    const file = join(tmp(), "flags.json");
    writeFileSync(file, JSON.stringify({ EFF_AGENT_ENABLED: true, EFF_PLAN_REUSE: "1", EFF_TOOL_ROUTING: 0 }));
    const resolved = resolveFlags({ file, env: { EFF_AGENT_ENABLED: "0", EFF_SHADOW_MODE: "off", EFF_SUBAGENT: "" } });
    expect(resolved.warnings).toEqual([]);
    expect(resolved.flags.EFF_AGENT_ENABLED).toBe(false);
    expect(resolved.sources.EFF_AGENT_ENABLED).toBe("env");
    expect(resolved.flags.EFF_SHADOW_MODE).toBe(false);
    expect(resolved.sources.EFF_SHADOW_MODE).toBe("env");
    expect(resolved.flags.EFF_PLAN_REUSE).toBe(true);
    expect(resolved.sources.EFF_PLAN_REUSE).toBe("file");
    expect(resolved.flags.EFF_TOOL_ROUTING).toBe(false);
    expect(resolved.sources.EFF_TOOL_ROUTING).toBe("file");
    // Empty env value is "unset", not a value.
    expect(resolved.flags.EFF_SUBAGENT).toBe(false);
    expect(resolved.sources.EFF_SUBAGENT).toBe("default");
    expect(resolved.sources.EFF_CONTEXT_REUSE).toBe("default");
  });

  it("bad values produce warnings and keep the lower layer", () => {
    const file = join(tmp(), "flags.json");
    writeFileSync(file, JSON.stringify({ EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: "sometimes", EFF_BOGUS: 1, EFF_SUBAGENT: [1] }));
    const resolved = resolveFlags({ file, env: { EFF_PLAN_REUSE: "perhaps", EFF_NETWORK_DEFAULT: "2" } });
    // env bad -> file value kept
    expect(resolved.flags.EFF_PLAN_REUSE).toBe(true);
    expect(resolved.sources.EFF_PLAN_REUSE).toBe("file");
    // env bad -> default kept
    expect(resolved.flags.EFF_NETWORK_DEFAULT).toBe(false);
    expect(resolved.sources.EFF_NETWORK_DEFAULT).toBe("default");
    // file bad -> default kept
    expect(resolved.flags.EFF_RESULT_REUSE).toBe(false);
    expect(resolved.sources.EFF_RESULT_REUSE).toBe("default");
    expect(resolved.sources.EFF_SUBAGENT).toBe("default");
    const w = resolved.warnings.join("\n");
    expect(w).toContain("EFF_RESULT_REUSE has a non-boolean value");
    expect(w).toContain("EFF_SUBAGENT has a non-boolean value");
    expect(w).toContain("unknown flag EFF_BOGUS ignored");
    expect(w).toContain("env EFF_PLAN_REUSE=perhaps is not a boolean");
    expect(w).toContain("env EFF_NETWORK_DEFAULT=2 is not a boolean");
    expect(resolved.warnings).toHaveLength(5);
  });

  it("corrupt or non-object flags file -> warning + defaults", () => {
    const dir = tmp();
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    const r1 = resolveFlags({ file: corrupt });
    expect(asBits(r1.flags)).toEqual(SPEC_22_DEFAULTS);
    expect(r1.warnings).toHaveLength(1);
    expect(r1.warnings[0]).toMatch(/flags file unreadable .*defaults kept/);

    const arr = join(dir, "array.json");
    writeFileSync(arr, "[1,2]");
    const r2 = resolveFlags({ file: arr });
    expect(asBits(r2.flags)).toEqual(SPEC_22_DEFAULTS);
    expect(r2.warnings).toEqual(["flags file is not an object; defaults kept"]);

    // Missing file is not a problem.
    expect(readFlagsFile(join(dir, "missing.json"))).toEqual({ values: {}, warnings: [] });
  });

  it("writeFlagsFile merges with the existing file and creates parent dirs", () => {
    const file = join(tmp(), "nested", "state", "flags.json");
    const first = writeFlagsFile(file, { EFF_AGENT_ENABLED: true });
    expect(first.EFF_AGENT_ENABLED).toBe(true);
    expect(first.EFF_SHADOW_MODE).toBe(true);
    const second = writeFlagsFile(file, { EFF_SHADOW_MODE: false });
    expect(second.EFF_AGENT_ENABLED).toBe(true);
    expect(second.EFF_SHADOW_MODE).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false });
    const third = writeFlagsFile(file, { EFF_AGENT_ENABLED: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ EFF_AGENT_ENABLED: false, EFF_SHADOW_MODE: false });
    expect(third.EFF_AGENT_ENABLED).toBe(false);
    expect(resolveFlags({ file }).sources.EFF_AGENT_ENABLED).toBe("file");
  });

  describe("effectiveMode caps", () => {
    const enabled: EffFlags = { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false };

    it("advisory, shadow and baseline are never capped", () => {
      for (const mode of ["advisory", "shadow", "baseline"] as const) {
        expect(effectiveMode(mode, DEFAULT_FLAGS)).toEqual({ mode, capped: false });
      }
    });

    it("defaults cap broker policies to shadow (EFF_AGENT_ENABLED=0 reason first)", () => {
      for (const mode of ["conservative", "adaptive"] as const) {
        const r = effectiveMode(mode, DEFAULT_FLAGS);
        expect(r.mode).toBe("shadow");
        expect(r.capped).toBe(true);
        expect(r.reason).toContain("EFF_AGENT_ENABLED=0");
      }
    });

    it("EFF_SHADOW_MODE=1 caps even when the agent is enabled", () => {
      const r = effectiveMode("adaptive", { ...enabled, EFF_SHADOW_MODE: true });
      expect(r).toMatchObject({ mode: "shadow", capped: true });
      expect(r.reason).toContain("EFF_SHADOW_MODE=1");
    });

    it("enabled + shadow off runs as requested", () => {
      expect(effectiveMode("conservative", enabled)).toEqual({ mode: "conservative", capped: false });
      expect(effectiveMode("adaptive", enabled)).toEqual({ mode: "adaptive", capped: false });
    });
  });

  describe("benchArmFlags", () => {
    it("baseline: agent off, no reuse/routing", () => {
      const f = benchArmFlags("baseline");
      expect(f).toMatchObject({
        EFF_AGENT_ENABLED: false,
        EFF_SHADOW_MODE: true,
        EFF_CONTEXT_REUSE: false,
        EFF_TOOL_ROUTING: false,
        EFF_MODEL_ROUTING: false,
      });
    });

    it("graphflow: agent enabled, shadow off, no context reuse, no routing", () => {
      const f = benchArmFlags("graphflow");
      expect(f).toEqual({
        ...DEFAULT_FLAGS,
        EFF_AGENT_ENABLED: true,
        EFF_SHADOW_MODE: false,
        EFF_CONTEXT_REUSE: false,
        EFF_TOOL_ROUTING: false,
        EFF_MODEL_ROUTING: false,
      });
      expect(effectiveMode("conservative", f).capped).toBe(false);
    });

    it("shadow: exactly the defaults (capped)", () => {
      const f = benchArmFlags("shadow");
      expect(f).toEqual({ ...DEFAULT_FLAGS });
      expect(effectiveMode("conservative", f).mode).toBe("shadow");
    });

    it("conservative: acting + plan reuse, no result reuse", () => {
      const f = benchArmFlags("conservative");
      expect(f).toMatchObject({ EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: false });
      expect(effectiveMode("conservative", f).capped).toBe(false);
    });

    it("adaptive: full agent (result reuse, dynamic harness, self-learning)", () => {
      const f = benchArmFlags("adaptive");
      expect(f).toMatchObject({
        EFF_AGENT_ENABLED: true,
        EFF_SHADOW_MODE: false,
        EFF_PLAN_REUSE: true,
        EFF_RESULT_REUSE: true,
        EFF_DYNAMIC_HARNESS: true,
        EFF_SELF_LEARNING: true,
      });
      // Safety flags never loosen in any arm.
      for (const arm of ["baseline", "graphflow", "shadow", "conservative", "adaptive"] as const) {
        const a = benchArmFlags(arm);
        expect(a.EFF_EXTERNAL_WRITE_APPROVAL).toBe(true);
        expect(a.EFF_NETWORK_DEFAULT).toBe(false);
        expect(a.EFF_SUBAGENT).toBe(false);
      }
    });

    it("returns a fresh object each call (no shared mutation)", () => {
      const a = benchArmFlags("shadow");
      a.EFF_AGENT_ENABLED = true;
      expect(benchArmFlags("shadow").EFF_AGENT_ENABLED).toBe(false);
      expect(DEFAULT_FLAGS.EFF_AGENT_ENABLED).toBe(false);
    });
  });
});
