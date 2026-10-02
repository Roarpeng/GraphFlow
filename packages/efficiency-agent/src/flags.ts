/**
 * Feature flags (spec §22) with a single rollback switch (§24).
 *
 * Precedence: built-in defaults < flags file (`eff-agent flags set`) < env.
 * The effective run mode is the requested mode capped by the flags:
 * EFF_AGENT_ENABLED=0 or EFF_SHADOW_MODE=1 means the agent may at most
 * observe (shadow) — the worker runs natively and no reuse is acted on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FLAG_NAMES = [
  "EFF_AGENT_ENABLED",
  "EFF_SHADOW_MODE",
  "EFF_CONTEXT_REUSE",
  "EFF_PLAN_REUSE",
  "EFF_RESULT_REUSE",
  "EFF_TOOL_ROUTING",
  "EFF_MODEL_ROUTING",
  "EFF_SUBAGENT",
  "EFF_SELF_LEARNING",
  "EFF_DYNAMIC_HARNESS",
  "EFF_EXTERNAL_WRITE_APPROVAL",
  "EFF_NETWORK_DEFAULT",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type EffFlags = Record<FlagName, boolean>;
export type FlagSource = "default" | "file" | "env";

export const DEFAULT_FLAGS: Readonly<EffFlags> = Object.freeze({
  EFF_AGENT_ENABLED: false,
  EFF_SHADOW_MODE: true,
  EFF_CONTEXT_REUSE: true,
  EFF_PLAN_REUSE: false,
  EFF_RESULT_REUSE: false,
  EFF_TOOL_ROUTING: true,
  EFF_MODEL_ROUTING: true,
  EFF_SUBAGENT: false,
  EFF_SELF_LEARNING: false,
  EFF_DYNAMIC_HARNESS: false,
  EFF_EXTERNAL_WRITE_APPROVAL: true,
  EFF_NETWORK_DEFAULT: false,
});

export interface ResolvedFlags {
  flags: EffFlags;
  sources: Record<FlagName, FlagSource>;
  /** Problems reading the flags file or env values; the default is kept for those. */
  warnings: string[];
}

export function isFlagName(value: string): value is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(value);
}

export function parseFlagValue(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return undefined;
}

export function readFlagsFile(path: string): { values: Partial<EffFlags>; warnings: string[] } {
  if (!existsSync(path)) return { values: {}, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { values: {}, warnings: [`flags file unreadable (${(error as Error).message}); defaults kept`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { values: {}, warnings: ["flags file is not an object; defaults kept"] };
  }
  const values: Partial<EffFlags> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isFlagName(key)) {
      warnings.push(`flags file: unknown flag ${key} ignored`);
      continue;
    }
    const v = typeof value === "boolean" ? value : typeof value === "string" || typeof value === "number" ? parseFlagValue(String(value)) : undefined;
    if (v === undefined) warnings.push(`flags file: ${key} has a non-boolean value; ignored`);
    else values[key] = v;
  }
  return { values, warnings };
}

export function resolveFlags(options: { file?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedFlags {
  const flags: EffFlags = { ...DEFAULT_FLAGS };
  const sources = Object.fromEntries(FLAG_NAMES.map((n) => [n, "default"])) as Record<FlagName, FlagSource>;
  const warnings: string[] = [];
  if (options.file) {
    const fromFile = readFlagsFile(options.file);
    warnings.push(...fromFile.warnings);
    for (const [key, value] of Object.entries(fromFile.values) as Array<[FlagName, boolean]>) {
      flags[key] = value;
      sources[key] = "file";
    }
  }
  const env = options.env ?? {};
  for (const name of FLAG_NAMES) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const v = parseFlagValue(raw);
    if (v === undefined) {
      warnings.push(`env ${name}=${raw} is not a boolean; ignored`);
      continue;
    }
    flags[name] = v;
    sources[name] = "env";
  }
  return { flags, sources, warnings };
}

export function writeFlagsFile(path: string, updates: Partial<EffFlags>): EffFlags {
  const current = readFlagsFile(path).values;
  const next = { ...current, ...updates };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { ...DEFAULT_FLAGS, ...next };
}

export type RequestedMode = "advisory" | "shadow" | "baseline" | "conservative" | "adaptive";

export interface EffectiveMode {
  mode: RequestedMode;
  capped: boolean;
  reason?: string;
}

/** Cap the requested mode by the flags. Advisory and baseline are never capped. */
export function effectiveMode(requested: RequestedMode, flags: EffFlags): EffectiveMode {
  if (requested !== "conservative" && requested !== "adaptive") return { mode: requested, capped: false };
  if (!flags.EFF_AGENT_ENABLED) {
    return { mode: "shadow", capped: true, reason: "EFF_AGENT_ENABLED=0: agent decisions are observed only (native worker path)" };
  }
  if (flags.EFF_SHADOW_MODE) {
    return { mode: "shadow", capped: true, reason: "EFF_SHADOW_MODE=1: decisions are recorded but not acted on" };
  }
  return { mode: requested, capped: false };
}

/** Flags a benchmark arm forces inside its isolated worktree, independent of the operator's file/env. */
export function benchArmFlags(arm: "baseline" | "graphflow" | "shadow" | "conservative" | "adaptive"): EffFlags {
  const base: EffFlags = { ...DEFAULT_FLAGS };
  switch (arm) {
    case "baseline":
      return { ...base, EFF_CONTEXT_REUSE: false, EFF_TOOL_ROUTING: false, EFF_MODEL_ROUTING: false };
    case "graphflow":
      // GraphFlow context in the prompt, but no efficiency decisions: no
      // cache reuse, no routing, fixed harness.
      return {
        ...base,
        EFF_AGENT_ENABLED: true,
        EFF_SHADOW_MODE: false,
        EFF_CONTEXT_REUSE: false,
        EFF_TOOL_ROUTING: false,
        EFF_MODEL_ROUTING: false,
      };
    case "shadow":
      return base;
    case "conservative":
      return { ...base, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false, EFF_PLAN_REUSE: true };
    case "adaptive":
      return {
        ...base,
        EFF_AGENT_ENABLED: true,
        EFF_SHADOW_MODE: false,
        EFF_PLAN_REUSE: true,
        EFF_RESULT_REUSE: true,
        EFF_DYNAMIC_HARNESS: true,
        EFF_SELF_LEARNING: true,
      };
  }
}
