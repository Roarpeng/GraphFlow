import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RiskClass, TraceSecurityDecision } from "../trace.js";
import { classifyCommand, isRiskClass, maxRisk, RISK_CLASS_IDS, type RiskAction } from "./risk.js";

export interface SecurityBudgets {
  maxRounds: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallMs: number;
}

export interface SecurityPolicy {
  version: number;
  /** spec flag EFF_EXTERNAL_WRITE_APPROVAL (default true). */
  externalWriteApproval: boolean;
  /** spec flag EFF_NETWORK_DEFAULT (default false). */
  networkDefault: boolean;
  riskActions: Record<RiskClass, RiskAction>;
  /** Simple globs (`**`, `*`, `?`); a pattern without `/` also matches the basename at any depth. */
  protectedPaths: string[];
  /** spec EFF_SUBAGENT (default 0). The primary worker agent is not a sub-agent. */
  maxSubAgents: number;
  budgets: SecurityBudgets;
}

type Verdict = TraceSecurityDecision["verdict"];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Mirrors policies/default-policy-v1.json exactly. */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = deepFreeze({
  version: 1,
  externalWriteApproval: true,
  networkDefault: false,
  riskActions: {
    R0: "allow",
    R1: "allow-bounded",
    R2: "approval",
    R3: "deny",
    R4: "confirm",
    R5: "allow-bounded",
  },
  protectedPaths: [
    ".git/**",
    ".env",
    ".env.*",
    ".envrc",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/id_rsa*",
    "**/id_dsa*",
    "**/id_ecdsa*",
    "**/id_ed25519*",
    "**/.npmrc",
    "**/.pypirc",
    "**/.netrc",
    "**/.git-credentials",
    "**/.ssh/**",
    "**/.aws/**",
    "**/.gnupg/**",
    "**/credentials*",
  ],
  maxSubAgents: 0,
  budgets: {
    maxRounds: 8,
    maxToolCalls: 64,
    maxInputTokens: 400000,
    maxOutputTokens: 64000,
    maxWallMs: 1800000,
  },
} satisfies SecurityPolicy);

/** Fail-closed policy (spec §9): anything beyond bounded local work is denied. */
export const STRICT_SECURITY_POLICY: SecurityPolicy = deepFreeze({
  ...DEFAULT_SECURITY_POLICY,
  externalWriteApproval: true,
  networkDefault: false,
  riskActions: {
    R0: "allow",
    R1: "allow-bounded",
    R2: "deny",
    R3: "deny",
    R4: "deny",
    R5: "deny",
  },
  protectedPaths: [...DEFAULT_SECURITY_POLICY.protectedPaths],
  maxSubAgents: 0,
  budgets: { ...DEFAULT_SECURITY_POLICY.budgets },
} satisfies SecurityPolicy);

function clonePolicy(p: SecurityPolicy): SecurityPolicy {
  return {
    ...p,
    riskActions: { ...p.riskActions },
    protectedPaths: [...p.protectedPaths],
    budgets: { ...p.budgets },
  };
}

// ---------------------------------------------------------------------------
// Validation (TS twin of schemas/policy-v1.schema.json)
// ---------------------------------------------------------------------------

const POLICY_KEYS = [
  "version",
  "externalWriteApproval",
  "networkDefault",
  "riskActions",
  "protectedPaths",
  "maxSubAgents",
  "budgets",
] as const;
const BUDGET_KEYS = ["maxRounds", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxWallMs"] as const;
const RISK_ACTIONS: readonly RiskAction[] = ["allow", "allow-bounded", "approval", "deny", "confirm"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns schema violations of a complete policy document (empty = valid). */
export function validateSecurityPolicy(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["policy must be an object"];
  for (const key of Object.keys(value)) {
    if (key !== "$schema" && !(POLICY_KEYS as readonly string[]).includes(key)) errors.push(`unknown key: ${key}`);
  }
  for (const key of POLICY_KEYS) if (!(key in value)) errors.push(`missing key: ${key}`);
  if ("$schema" in value && typeof value.$schema !== "string") errors.push("$schema must be a string");
  if ("version" in value && value.version !== 1) errors.push("version must be 1");
  for (const key of ["externalWriteApproval", "networkDefault"] as const) {
    if (key in value && typeof value[key] !== "boolean") errors.push(`${key} must be a boolean`);
  }
  if ("riskActions" in value) {
    const ra = value.riskActions;
    if (!isPlainObject(ra)) errors.push("riskActions must be an object");
    else {
      for (const key of Object.keys(ra)) if (!isRiskClass(key)) errors.push(`riskActions: unknown risk class ${key}`);
      for (const r of RISK_CLASS_IDS) {
        if (!(r in ra)) errors.push(`riskActions: missing ${r}`);
        else if (!RISK_ACTIONS.includes(ra[r] as RiskAction)) errors.push(`riskActions.${r}: invalid action`);
      }
    }
  }
  if ("protectedPaths" in value) {
    const pp = value.protectedPaths;
    if (!Array.isArray(pp)) errors.push("protectedPaths must be an array");
    else {
      if (pp.some((p) => typeof p !== "string" || p.length === 0)) errors.push("protectedPaths must be non-empty strings");
      if (new Set(pp).size !== pp.length) errors.push("protectedPaths must be unique");
    }
  }
  if ("maxSubAgents" in value) {
    const m = value.maxSubAgents;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0) errors.push("maxSubAgents must be an integer >= 0");
  }
  if ("budgets" in value) {
    const b = value.budgets;
    if (!isPlainObject(b)) errors.push("budgets must be an object");
    else {
      for (const key of Object.keys(b)) {
        if (!(BUDGET_KEYS as readonly string[]).includes(key)) errors.push(`budgets: unknown key ${key}`);
      }
      for (const key of BUDGET_KEYS) {
        const n = b[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) errors.push(`budgets.${key} must be an integer >= 1`);
      }
    }
  }
  return errors;
}

/**
 * Load a policy file (spec §9). Missing path/file -> default; valid file -> merged over the default
 * (protectedPaths are additive); corrupt or invalid file -> strict fail-closed policy with `error`.
 */
export function loadSecurityPolicy(filePath?: string): {
  policy: SecurityPolicy;
  source: "default" | "file" | "fail-closed";
  error?: string;
} {
  if (!filePath || !existsSync(filePath)) return { policy: clonePolicy(DEFAULT_SECURITY_POLICY), source: "default" };
  const failClosed = (error: string) => ({
    policy: clonePolicy(STRICT_SECURITY_POLICY),
    source: "fail-closed" as const,
    error,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    return failClosed(`policy file unreadable or not JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) return failClosed("policy file must contain a JSON object");
  const shapeErrors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== "$schema" && !(POLICY_KEYS as readonly string[]).includes(key)) shapeErrors.push(`unknown key: ${key}`);
  }
  for (const key of ["riskActions", "budgets"] as const) {
    if (key in raw && !isPlainObject(raw[key])) shapeErrors.push(`${key} must be an object`);
  }
  if ("protectedPaths" in raw && !Array.isArray(raw.protectedPaths)) shapeErrors.push("protectedPaths must be an array");
  if (shapeErrors.length) return failClosed(`invalid policy: ${shapeErrors.join("; ")}`);

  const base = clonePolicy(DEFAULT_SECURITY_POLICY);
  const { $schema: _schema, ...override } = raw;
  void _schema;
  const merged: Record<string, unknown> = {
    ...base,
    ...override,
    riskActions: { ...base.riskActions, ...((override.riskActions as Record<string, unknown> | undefined) ?? {}) },
    budgets: { ...base.budgets, ...((override.budgets as Record<string, unknown> | undefined) ?? {}) },
    protectedPaths: [
      ...new Set([...base.protectedPaths, ...((override.protectedPaths as unknown[] | undefined) ?? [])]),
    ],
  };
  const errors = validateSecurityPolicy(merged);
  if (errors.length) return failClosed(`invalid policy: ${errors.join("; ")}`);
  return { policy: merged as unknown as SecurityPolicy, source: "file" };
}

/**
 * Apply the spec feature flags EFF_EXTERNAL_WRITE_APPROVAL / EFF_NETWORK_DEFAULT / EFF_SUBAGENT.
 * Unparseable values keep the safer setting and are reported in `errors`.
 */
export function applySecurityEnvFlags(
  policy: SecurityPolicy,
  env: Record<string, string | undefined> = process.env
): { policy: SecurityPolicy; errors: string[] } {
  const out = clonePolicy(policy);
  const errors: string[] = [];
  const bool = (name: string, safe: boolean): boolean | undefined => {
    const v = env[name];
    if (v === undefined || v === "") return undefined;
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    errors.push(`${name}: expected a boolean, got ${JSON.stringify(v)}; using ${safe}`);
    return safe;
  };
  const approval = bool("EFF_EXTERNAL_WRITE_APPROVAL", true);
  if (approval !== undefined) out.externalWriteApproval = approval;
  const network = bool("EFF_NETWORK_DEFAULT", false);
  if (network !== undefined) out.networkDefault = network;
  const sub = env.EFF_SUBAGENT;
  if (sub !== undefined && sub !== "") {
    if (/^\d+$/.test(sub)) out.maxSubAgents = Number(sub);
    else {
      errors.push(`EFF_SUBAGENT: expected an integer >= 0, got ${JSON.stringify(sub)}; using 0`);
      out.maxSubAgents = 0;
    }
  }
  return { policy: out, errors };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      re += "(?:/.*)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else {
      const c = pattern[i] as string;
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** Returns the first protected pattern matching a repo-relative path, or null. Matching is case-insensitive. */
export function matchProtectedPath(relativePath: string, patterns: readonly string[]): string | null {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = rel.endsWith("/") ? [rel.slice(0, -1), `${rel}_`] : [rel];
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    const re = globToRegExp(p);
    for (const c of candidates) {
      if (re.test(c)) return pattern;
      if (!p.includes("/")) {
        const base = c.split("/").pop() ?? c;
        if (re.test(base)) return pattern;
      }
    }
  }
  return null;
}

function realpathOfNearestExisting(target: string): string {
  let cur = target;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return target;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync.native(cur);
  } catch {
    try {
      real = realpathSync(cur);
    } catch {
      real = cur;
    }
  }
  return rest.length ? path.join(real, ...rest) : real;
}

function insideRelative(root: string, target: string): string | null {
  const norm = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (norm(target) === norm(root)) return "";
  if (!norm(target).startsWith(norm(rootWithSep))) return null;
  return target.slice(rootWithSep.length).split(path.sep).join("/");
}

export type WritePathCheck = { ok: true; relative: string } | { ok: false; reason: string };

/** Resolve a write target against the workspace and enforce containment + protected paths (hard invariants). */
export function checkWritePath(workspaceRoot: string, p: string, policy: SecurityPolicy): WritePathCheck {
  if (typeof p !== "string" || !p.trim()) return { ok: false, reason: "empty write path" };
  if (p.includes("\0")) return { ok: false, reason: `write path contains a NUL byte (${JSON.stringify(p)})` };
  if (/^~/.test(p) || /\$|%[A-Za-z_][A-Za-z0-9_]*%/.test(p)) {
    return { ok: false, reason: `write path uses shell expansion and cannot be resolved safely (${p})` };
  }
  const q = p.replace(/\\/g, "/");
  const winAbs = /^[a-zA-Z]:\//.test(q);
  if (q.startsWith("//")) return { ok: false, reason: `UNC/network write path denied (${p})` };
  if (q.replace(/^[a-zA-Z]:\//, "").includes(":")) {
    return { ok: false, reason: `write path contains ':' (drive-relative path or alternate data stream) (${p})` };
  }
  if (winAbs && process.platform !== "win32") return { ok: false, reason: `absolute path outside the workspace (${p})` };
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, q);
  const rel = insideRelative(root, target);
  if (rel === null) return { ok: false, reason: `write outside the workspace root (${p})` };
  const realRel = insideRelative(realpathOfNearestExisting(root), realpathOfNearestExisting(target));
  if (realRel === null) return { ok: false, reason: `write path escapes the workspace via a symlink/junction (${p})` };
  if (rel === "") return { ok: false, reason: "write targets the workspace root itself" };
  const hit = matchProtectedPath(rel, policy.protectedPaths);
  if (hit) return { ok: false, reason: `write to a protected path (${rel} matches ${hit})` };
  return { ok: true, relative: rel };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface ActionRequest {
  kind: "exec" | "write" | "spawn-agent";
  /** For exec / spawn-agent. */
  command?: string;
  /** For write (repo-relative or absolute). */
  paths?: string[];
  workspaceRoot: string;
  /** Read-only task category (query / deliberate-failure): any write is out of scope. */
  readOnly?: boolean;
  /** An operator can approve; default false (approval-required then blocks). */
  interactive?: boolean;
  subAgentsInUse?: number;
}

const VERDICT_RANK: Record<Verdict, number> = { allow: 0, "approval-required": 1, deny: 2 };

function stricter(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

function riskVerdict(risk: RiskClass, policy: SecurityPolicy, interactive: boolean, reasons: string[]): Verdict {
  const action = policy.riskActions[risk];
  const blocked = (): void => {
    if (!interactive) reasons.push("non-interactive session: no operator can approve, so the action is blocked");
  };
  switch (action) {
    case "allow":
      return "allow";
    case "allow-bounded":
      reasons.push(`${risk}: allowed within the configured budgets`);
      return "allow";
    case "approval":
      if (risk === "R2" && !policy.externalWriteApproval) {
        reasons.push("R2: external-write approval disabled by policy (externalWriteApproval=false)");
        return "allow";
      }
      reasons.push(`${risk}: requires operator approval`);
      blocked();
      return "approval-required";
    case "confirm":
      reasons.push(`${risk}: destructive action requires explicit operator confirmation`);
      blocked();
      return "approval-required";
    case "deny":
    default:
      reasons.push(`${risk}: denied by policy`);
      return "deny";
  }
}

function dedupe(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function failClosed(reason: string): TraceSecurityDecision {
  return { verdict: "deny", risk: "R3", reasons: [reason, "security evaluation is fail-closed"] };
}

/** Gate an action eff-agent is about to perform (spec §7-§9). */
export function evaluateAction(req: ActionRequest, policy: SecurityPolicy): TraceSecurityDecision {
  try {
    const policyErrors = validateSecurityPolicy(policy);
    if (policyErrors.length) return failClosed(`invalid security policy: ${policyErrors.join("; ")}`);
    if (!req || typeof req.workspaceRoot !== "string" || !req.workspaceRoot.trim()) {
      return failClosed("action request without a workspace root");
    }
    switch (req.kind) {
      case "exec":
        return evaluateExec(req, policy);
      case "write":
        return evaluateWrite(req, policy);
      case "spawn-agent":
        return evaluateSpawn(req, policy);
      default:
        return failClosed(`unknown action kind: ${String((req as { kind?: unknown }).kind)}`);
    }
  } catch (e) {
    return failClosed(`security evaluation error: ${(e as Error).message}`);
  }
}

function evaluateExec(req: ActionRequest, policy: SecurityPolicy): TraceSecurityDecision {
  const command = req.command ?? "";
  if (!command.trim()) return failClosed("exec request without a command");
  const c = classifyCommand(command);
  const reasons = [...c.reasons];
  const interactive = req.interactive === true;
  let verdict: Verdict = "allow";
  for (const r of c.riskSet) verdict = stricter(verdict, riskVerdict(r, policy, interactive, reasons));
  if (c.capabilities.includes("network.connect") && !policy.networkDefault) {
    verdict = "deny";
    reasons.push("network access is disabled by default (networkDefault=false)");
  }
  if (c.riskSet.includes("R5")) {
    const inUse = req.subAgentsInUse ?? 0;
    if (inUse >= policy.maxSubAgents) {
      verdict = "deny";
      reasons.push(`sub-agent budget exhausted (${inUse}/${policy.maxSubAgents} in use)`);
    }
  }
  if (req.readOnly && c.capabilities.some((cap) => cap === "filesystem.write" || cap === "git.write" || cap === "package.install")) {
    verdict = "deny";
    reasons.push("write in a read-only task: the task category forbids workspace mutations");
  }
  let risk = c.risk;
  for (const target of c.writeTargets) {
    const check = checkWritePath(req.workspaceRoot, target, policy);
    if (!check.ok) {
      verdict = "deny";
      risk = maxRisk(risk, "R3");
      reasons.push(check.reason);
    }
  }
  return { verdict, risk, reasons: dedupe(reasons) };
}

function evaluateWrite(req: ActionRequest, policy: SecurityPolicy): TraceSecurityDecision {
  const reasons: string[] = [];
  let verdict: Verdict = "allow";
  let risk: RiskClass = "R1";
  if (req.readOnly) {
    verdict = "deny";
    reasons.push("write in a read-only task: any workspace write is out of scope");
  }
  const paths = req.paths ?? [];
  if (!paths.length) {
    verdict = "deny";
    reasons.push("write request without paths (fail-closed)");
  }
  for (const p of paths) {
    const check = checkWritePath(req.workspaceRoot, p, policy);
    if (!check.ok) {
      verdict = "deny";
      risk = "R3";
      reasons.push(check.reason);
    }
  }
  if (verdict !== "deny") verdict = stricter(verdict, riskVerdict("R1", policy, req.interactive === true, reasons));
  if (verdict === "allow") reasons.unshift(`workspace write of ${paths.length} path(s) inside the root`);
  return { verdict, risk, reasons: dedupe(reasons) };
}

function evaluateSpawn(req: ActionRequest, policy: SecurityPolicy): TraceSecurityDecision {
  const reasons: string[] = ["spawns a sub-agent"];
  let verdict: Verdict = "allow";
  let risk: RiskClass = "R5";
  if (req.command?.trim()) {
    const c = classifyCommand(req.command);
    if (c.riskSet.includes("R3") || c.riskSet.includes("R4")) {
      verdict = "deny";
      risk = c.risk;
      reasons.push(...c.reasons, "sub-agent command line contains secret-access or destructive parts");
    }
  }
  const inUse = req.subAgentsInUse ?? 0;
  if (inUse >= policy.maxSubAgents) {
    verdict = "deny";
    reasons.push(`sub-agent budget exhausted (${inUse}/${policy.maxSubAgents} in use; spec EFF_SUBAGENT)`);
  }
  verdict = stricter(verdict, riskVerdict("R5", policy, req.interactive === true, reasons));
  return { verdict, risk, reasons: dedupe(reasons) };
}

/**
 * Gate the user-configured primary worker agent CLI. It is not a sub-agent and runs with its own
 * permission model; only its launch command line is inspected here.
 */
export function evaluateWorkerLaunch(command: string, policy: SecurityPolicy): TraceSecurityDecision {
  try {
    const policyErrors = validateSecurityPolicy(policy);
    if (policyErrors.length) return failClosed(`invalid security policy: ${policyErrors.join("; ")}`);
    if (typeof command !== "string" || !command.trim()) return failClosed("worker launch without a command");
    const c = classifyCommand(command);
    if (c.riskSet.includes("R3") || c.riskSet.includes("R4")) {
      return {
        verdict: "deny",
        risk: c.risk,
        reasons: dedupe([...c.reasons, "worker launch command contains secret-access or destructive parts"]),
      };
    }
    const reasons = [
      "user-configured primary worker agent: not counted as a sub-agent",
      "the worker CLI runs with its own permission model; eff-agent gates the launch and audits workspace writes afterwards",
    ];
    let verdict: Verdict = "allow";
    if (c.riskSet.includes("R2")) {
      reasons.push(...c.reasons);
      verdict = riskVerdict("R2", policy, false, reasons);
      if (c.capabilities.includes("network.connect") && !policy.networkDefault) {
        verdict = "deny";
        reasons.push("network access is disabled by default (networkDefault=false)");
      }
    }
    return { verdict, risk: verdict === "allow" ? "R1" : c.risk, reasons: dedupe(reasons) };
  } catch (e) {
    return failClosed(`security evaluation error: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Post-run audit
// ---------------------------------------------------------------------------

function decodeQuoted(s: string, start: number): { path: string; end: number } {
  const bytes: number[] = [];
  let i = start + 1;
  for (; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '"') return { path: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1] as string;
      const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))?.[0] ?? n;
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length;
        continue;
      }
      if (simple[n] !== undefined) {
        bytes.push(simple[n] as number);
        i++;
        continue;
      }
    }
    bytes.push(...Buffer.from(c, "utf8"));
  }
  return { path: Buffer.from(bytes).toString("utf8"), end: s.length };
}

function readPorcelainPath(s: string, start: number, stopAtArrow: boolean): { path: string; end: number } {
  if (s[start] === '"') return decodeQuoted(s, start);
  if (stopAtArrow) {
    const idx = s.indexOf(" -> ", start);
    if (idx >= 0) return { path: s.slice(start, idx), end: idx };
  }
  return { path: s.slice(start), end: s.length };
}

function porcelainEntry(line: string): { status: string; paths: string[] } | null {
  const l = line.replace(/\r$/, "");
  if (l.length < 4) return null;
  const status = l.slice(0, 2);
  const rest = l.slice(3);
  if (/[RC]/.test(status)) {
    const first = readPorcelainPath(rest, 0, true);
    if (rest.startsWith(" -> ", first.end)) {
      const second = readPorcelainPath(rest, first.end + 4, false);
      return { status, paths: status.includes("R") ? [first.path, second.path] : [second.path] };
    }
    return { status, paths: [first.path] };
  }
  return { status, paths: [readPorcelainPath(rest, 0, false).path] };
}

/**
 * `git status --porcelain` (v1) lines -> repo-relative paths. Renames yield both the old and the
 * new path (the old one was deleted); copies yield only the new path. Quoted paths are decoded.
 */
export function parsePorcelain(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const entry = porcelainEntry(line);
    if (!entry) continue;
    for (const p of entry.paths) if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** `git status --porcelain` (v1) lines -> repo-relative path => two-letter status (renames map both paths). */
export function porcelainStatusMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const entry = porcelainEntry(line);
    if (!entry) continue;
    for (const p of entry.paths) if (p) map.set(p, entry.status);
  }
  return map;
}

/**
 * Compare porcelain snapshots taken before/after a worker run and evaluate the delta as a write.
 * Paths that appeared, changed status, or disappeared (reverted/committed) count as newly changed.
 */
export function auditWorkspaceWrites(input: {
  before: string[];
  after: string[];
  workspaceRoot: string;
  readOnly: boolean;
  policy: SecurityPolicy;
  /** Globs for paths eff-agent itself writes (e.g. trace output) that the audit should ignore. */
  ignorePaths?: string[];
}): { decision: TraceSecurityDecision; newlyChanged: string[] } {
  const before = porcelainStatusMap(input.before);
  const after = porcelainStatusMap(input.after);
  const changed: string[] = [];
  for (const [p, st] of after) if (before.get(p) !== st) changed.push(p);
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  const ignore = input.ignorePaths ?? [];
  const newlyChanged = changed.filter((p) => !ignore.length || matchProtectedPath(p, ignore) === null);
  if (!newlyChanged.length) {
    return { decision: { verdict: "allow", risk: "R0", reasons: ["no new workspace writes detected"] }, newlyChanged };
  }
  const decision = evaluateAction(
    { kind: "write", paths: newlyChanged, workspaceRoot: input.workspaceRoot, readOnly: input.readOnly },
    input.policy
  );
  return {
    decision: { ...decision, reasons: [`audit: ${newlyChanged.length} path(s) changed during the run`, ...decision.reasons] },
    newlyChanged,
  };
}

/** Cache-poisoning guard: only validated, evidenced, injection-free, secret-free results are reusable. */
export function cacheAdmission(input: {
  validationPassed: boolean;
  evidence: string[];
  injectionSuspected: boolean;
  secretsRedacted: number;
}): { admit: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.validationPassed !== true) reasons.push("result did not pass validation");
  const evidence = Array.isArray(input.evidence) ? input.evidence.filter((e) => typeof e === "string" && e.trim()) : [];
  if (!evidence.length) reasons.push("no validation evidence recorded");
  if (input.injectionSuspected !== false) reasons.push("prompt-injection suspected in the inputs or output");
  if (!(typeof input.secretsRedacted === "number" && input.secretsRedacted === 0)) {
    reasons.push("secrets were redacted from the output; refusing to cache sensitive material");
  }
  if (reasons.length) return { admit: false, reasons };
  return { admit: true, reasons: ["validated result with evidence, no injection signals, no redactions"] };
}
