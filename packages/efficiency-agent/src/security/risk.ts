import type { RiskClass } from "../trace.js";
import { sortCapabilities, type Capability } from "./capabilities.js";

/** Policy reaction per risk class (spec §8). */
export type RiskAction = "allow" | "allow-bounded" | "approval" | "deny" | "confirm";

export interface RiskClassInfo {
  id: RiskClass;
  name: string;
  /** Strictness rank used to combine parts of a chained command (higher = stricter default handling). */
  severity: number;
  description: string;
  defaultAction: RiskAction;
}

/** Mirrors policies/risk-classes-v1.json. */
export const RISK_CLASSES: readonly RiskClassInfo[] = Object.freeze([
  {
    id: "R0",
    name: "read-only",
    severity: 0,
    description: "Read-only inspection with no side effects (git status, ls, reading non-secret files).",
    defaultAction: "allow",
  },
  {
    id: "R1",
    name: "bounded-local",
    severity: 1,
    description:
      "Bounded local execution or workspace-contained writes (tests, builds, edits inside the workspace).",
    defaultAction: "allow-bounded",
  },
  {
    id: "R2",
    name: "external-side-effect",
    severity: 3,
    description:
      "External or shared-state side effects: network access, package installs, publishing, pushing, git state changes.",
    defaultAction: "approval",
  },
  {
    id: "R3",
    name: "secret-or-escape",
    severity: 5,
    description:
      "Secret or credential access, privilege escalation, or commands that cannot be inspected safely.",
    defaultAction: "deny",
  },
  {
    id: "R4",
    name: "destructive",
    severity: 4,
    description:
      "Destructive or irreversible operations (recursive deletes, hard resets, force pushes, dropping databases, disk formatting).",
    defaultAction: "confirm",
  },
  {
    id: "R5",
    name: "agent-spawn",
    severity: 2,
    description:
      "Spawning additional AI agents (unbounded consumption risk); bounded by maxSubAgents and budgets.",
    defaultAction: "allow-bounded",
  },
].map((entry) => Object.freeze(entry as RiskClassInfo)));

export const RISK_CLASS_IDS: readonly RiskClass[] = Object.freeze(["R0", "R1", "R2", "R3", "R4", "R5"]);

export const RISK_SEVERITY: Readonly<Record<RiskClass, number>> = Object.freeze(
  Object.fromEntries(RISK_CLASSES.map((c) => [c.id, c.severity])) as Record<RiskClass, number>
);

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_CLASS_IDS as readonly string[]).includes(value);
}

/** Most severe risk class by {@link RISK_SEVERITY} (R0 < R1 < R5 < R2 < R4 < R3). */
export function maxRisk(...risks: RiskClass[]): RiskClass {
  let best: RiskClass = "R0";
  for (const r of risks) if (RISK_SEVERITY[r] > RISK_SEVERITY[best]) best = r;
  return best;
}

export interface CommandClassification {
  capabilities: Capability[];
  /** Most severe risk class among all parts of the command. */
  risk: RiskClass;
  reasons: string[];
  /** Every risk class detected in any part (policies may rank classes differently than the default severity). */
  riskSet: RiskClass[];
  /** Paths the command visibly writes (redirect targets, write-command operands); checked against the workspace. */
  writeTargets: string[];
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface Segment {
  tokens: string[];
  /** stdin of this segment is the previous segment's stdout. */
  piped: boolean;
}

interface Lexed {
  segments: Segment[];
  substitutions: string[];
  redirects: string[];
  unbalanced: boolean;
}

function readBalancedParen(input: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = open; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: input.slice(open + 1, i), end: i };
    }
  }
  return null;
}

function lex(input: string): Lexed {
  const segments: Segment[] = [];
  const substitutions: string[] = [];
  const redirects: string[] = [];
  let unbalanced = false;
  let tokens: string[] = [];
  let piped = false;
  let buf = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  let redirectNext = false;

  const flush = (): void => {
    if (has) {
      if (redirectNext) {
        redirects.push(buf);
        redirectNext = false;
      } else tokens.push(buf);
    }
    buf = "";
    has = false;
  };
  const endSegment = (nextPiped: boolean): void => {
    flush();
    redirectNext = false;
    if (tokens.length) segments.push({ tokens, piped });
    tokens = [];
    piped = nextPiped;
  };
  const substitution = (i: number): number => {
    if (input[i] === "`") {
      const close = input.indexOf("`", i + 1);
      if (close < 0) {
        unbalanced = true;
        return input.length;
      }
      substitutions.push(input.slice(i + 1, close));
      return close;
    }
    const bal = readBalancedParen(input, i + 1);
    if (!bal) {
      unbalanced = true;
      return input.length;
    }
    substitutions.push(bal.inner);
    return bal.end;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string;
    const next = input[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else buf += c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && (next === '"' || next === "$" || next === "`")) {
        buf += next;
        i++;
      } else if (c === '"') quote = null;
      else if ((c === "$" && next === "(") || c === "`") {
        i = substitution(i);
        has = true;
      } else buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    if (c === ";" || c === "\n" || c === "\r") {
      endSegment(false);
      continue;
    }
    if (c === "&") {
      if (next === "&") i++;
      endSegment(false);
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        i++;
        endSegment(false);
      } else endSegment(true);
      continue;
    }
    if (c === ">") {
      // `2>`, `*>`: the file-descriptor prefix is not a token.
      if (has && /^(\d+|\*)$/.test(buf)) {
        buf = "";
        has = false;
      }
      flush();
      if (input[i + 1] === ">") i++;
      if (input[i + 1] === "&") {
        i++;
        while (i + 1 < input.length && /[\d-]/.test(input[i + 1] as string)) i++;
        continue;
      }
      redirectNext = true;
      continue;
    }
    if (c === "<") {
      flush();
      continue;
    }
    if ((c === "$" && next === "(") || c === "`") {
      flush();
      i = substitution(i);
      continue;
    }
    buf += c;
    has = true;
  }
  if (quote) unbalanced = true;
  endSegment(false);
  return { segments, substitutions, redirects, unbalanced };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const AGENT_NAMES = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor-agent",
  "opencode",
  "dsh",
  "aider",
  "kimi",
  "qwen",
]);
const AGENT_PACKAGES: Record<string, string> = {
  "@anthropic-ai/claude-code": "claude",
  "@openai/codex": "codex",
  "@google/gemini-cli": "gemini",
  "opencode-ai": "opencode",
};

const READ_ONLY_NAMES = new Set([
  "ls", "dir", "pwd", "echo", "cat", "type", "more", "less", "head", "tail", "wc", "rg", "grep", "egrep",
  "fgrep", "findstr", "which", "where", "whoami", "tree", "stat", "file", "du", "df", "date", "sort", "uniq",
  "cut", "tr", "diff", "cmp", "jq", "basename", "dirname", "realpath", "true", "false", "test", "[", "cd",
  "get-childitem", "gci", "get-content", "gc", "get-item", "gi", "select-string", "sls", "test-path",
  "resolve-path", "get-location", "gl", "write-output", "write-host", "set-location", "sl", "measure-object",
  "select-object", "select", "sort-object", "format-table", "ft", "format-list", "fl", "out-string",
  "get-command", "gcm", "get-filehash", "printf", "column", "nl", "od", "xxd", "hexdump", "md5sum",
  "sha256sum", "shasum", "certutil-hash",
]);

const WRITE_LAST_OPERAND = new Set([
  "cp", "copy", "copy-item", "cpi", "xcopy", "mv", "move", "move-item", "mi", "ln", "rename", "ren",
  "rename-item", "rni",
]);
const WRITE_ALL_OPERANDS = new Set([
  "mkdir", "md", "new-item", "ni", "touch", "set-content", "add-content", "ac", "out-file", "tee",
  "tee-object", "chmod", "chown", "attrib", "icacls", "truncate", "clear-content", "clc",
]);
/** PowerShell parameters whose value is data, not a path. */
const VALUE_FLAGS = new Set(["-value", "-encoding", "-itemtype", "-inputobject", "-type", "-mode"]);

const NETWORK_NAMES = new Set([
  "curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "nc", "ncat", "netcat", "telnet",
  "ssh", "scp", "sftp", "ftp", "tftp", "rsync", "socat", "bitsadmin", "start-bitstransfer", "aria2c",
  "http", "https", "xh",
]);

const CLOUD_NAMES = new Set([
  "aws", "gcloud", "gsutil", "az", "kubectl", "helm", "terraform", "pulumi", "vercel", "netlify",
  "firebase", "flyctl", "fly", "heroku", "wrangler",
]);

const SECRET_TOOL_NAMES = new Set([
  "printenv", "security", "cmdkey", "vaultcmd", "get-secret", "get-storedcredential", "op", "bw", "pass",
  "keyring", "vault", "lpass",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const PIPE_INTERPRETERS = new Set([
  ...SHELLS, "pwsh", "powershell", "cmd", "python", "python3", "py", "node", "perl", "ruby", "php",
]);
const GENERIC_WRAPPERS = new Set([
  "xargs", "nohup", "time", "nice", "timeout", "watch", "start", "start-process", "saps", "foreach-object",
  "%", "foreach", "where-object", "?", "invoke-command", "icm", "start-job", "call", "exec", "command",
  "builtin", "stdbuf", "ionice", "chronic", "unbuffer", "npm-run-all", "concurrently",
]);
const PRIVILEGE_NAMES = new Set(["sudo", "doas", "runas", "su", "gsudo", "pkexec"]);
const EVAL_NAMES = new Set(["eval", "iex", "invoke-expression"]);
const DISK_DESTRUCTIVE = new Set([
  "shred", "wipefs", "fdisk", "sfdisk", "parted", "diskpart", "format-volume", "clear-disk",
  "initialize-disk", "remove-partition", "rimraf", "srm",
]);
const POWER_NAMES = new Set(["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"]);

const PKG_MANAGERS: Record<string, { install: string[]; publish: string[]; destroy?: string[] }> = {
  pip: { install: ["install", "download", "wheel"], publish: [] },
  pip3: { install: ["install", "download", "wheel"], publish: [] },
  pipx: { install: ["install", "run", "inject", "upgrade", "upgrade-all", "reinstall"], publish: [] },
  uv: { install: ["add", "sync", "lock", "pip", "tool", "python"], publish: ["publish"] },
  uvx: { install: ["*"], publish: [] },
  poetry: { install: ["add", "install", "update", "lock"], publish: ["publish"] },
  conda: { install: ["install", "create", "update"], publish: [] },
  mamba: { install: ["install", "create", "update"], publish: [] },
  gem: { install: ["install", "update"], publish: ["push"] },
  cargo: { install: ["add", "install", "fetch", "update", "search"], publish: ["publish"] },
  go: { install: ["get", "install", "mod"], publish: [] },
  brew: { install: ["install", "upgrade", "update", "tap", "reinstall"], publish: [] },
  apt: { install: ["install", "update", "upgrade", "full-upgrade"], publish: [] },
  "apt-get": { install: ["install", "update", "upgrade", "dist-upgrade"], publish: [] },
  yum: { install: ["install", "update", "upgrade"], publish: [] },
  dnf: { install: ["install", "update", "upgrade"], publish: [] },
  apk: { install: ["add", "update", "upgrade"], publish: [] },
  zypper: { install: ["install", "in", "update", "up"], publish: [] },
  pacman: { install: [], publish: [] },
  choco: { install: ["install", "upgrade", "update"], publish: ["push"] },
  winget: { install: ["install", "upgrade", "update"], publish: [] },
  scoop: { install: ["install", "update"], publish: [] },
  dotnet: { install: ["add", "restore", "tool"], publish: ["nuget"] },
  composer: { install: ["require", "install", "update"], publish: [] },
  bundle: { install: ["install", "update", "add"], publish: [] },
  deno: { install: ["install", "add", "cache"], publish: ["publish"] },
  twine: { install: [], publish: ["upload"] },
  vsce: { install: [], publish: ["publish"] },
  ovsx: { install: [], publish: ["publish"] },
};

const NODE_PMS = new Set(["npm", "pnpm", "yarn", "bun", "cnpm"]);
const NODE_INSTALL = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci",
  "update", "up", "upgrade", "udpate", "install-test", "it", "install-ci-test", "cit", "fetch", "dedupe",
  "global",
]);
const NODE_EXEC = new Set(["exec", "x", "dlx"]);
const NODE_CREDENTIALS = new Set(["login", "adduser", "add-user", "token", "logout"]);

const GIT_READ = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "blame", "grep",
  "describe", "shortlog", "cat-file", "for-each-ref", "show-ref", "merge-base", "name-rev", "whatchanged",
  "version", "help", "check-ignore", "count-objects", "fsck", "var", "--version", "--help",
]);
const GH_MUTATING = new Set([
  "create", "merge", "close", "reopen", "comment", "edit", "review", "ready", "delete", "upload", "fork",
  "rename", "archive", "unarchive", "run", "cancel", "rerun", "enable", "disable", "transfer", "lock", "unlock",
  "develop", "set", "sync", "pin", "unpin", "clone",
]);

const SECRET_NAME_RE = /(secret|token|passw|api_?key|access_?key|private_?key|credential|auth)/i;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function stripBrackets(token: string): string {
  return token.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

function normName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("-") || (a.startsWith("/") && a.length <= 3 && /^\/[a-z?]+$/i.test(a))) {
      if (VALUE_FLAGS.has(a.toLowerCase())) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** True when a token names a credential file or secret store location. */
export function isSecretPathToken(token: string): boolean {
  let t = token.trim();
  if (!t) return false;
  const eq = t.indexOf("=");
  if (t.startsWith("-") && eq > 0) t = t.slice(eq + 1);
  t = t.replace(/^@/, "").replace(/\\/g, "/").replace(/^["']|["']$/g, "").toLowerCase();
  if (/(^|\/)\.env$/.test(t)) return true;
  if (/(^|\/)\.env\.[^/]+$/.test(t) && !/(^|\/)\.env\.(example|sample|template|dist|defaults)$/.test(t)) return true;
  if (/(^|\/)\.envrc$/.test(t)) return true;
  if (/(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/.test(t)) return true;
  if (/(^|\/)(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.dockercfg|\.pgpass)$/.test(t)) return true;
  if (/(^|\/)credentials[^/]*$/.test(t)) return true;
  if (/(^|\/)\.(ssh|aws|gnupg|azure|kube)(\/|$)/.test(t)) return true;
  if (/(^|\/)\.docker\/config\.json$/.test(t)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks|ppk)$/.test(t)) return true;
  if (/^\/etc\/(shadow|gshadow|sudoers)/.test(t)) return true;
  if (/(hklm|hkey_local_machine)\/(sam|security)\b/.test(t)) return true;
  if (t.includes("_authtoken")) return true;
  return false;
}

/** True when a token dereferences a secret-looking environment variable or dumps the environment. */
export function isSecretEnvToken(token: string): boolean {
  const t = token;
  if (/^env:\s*$/i.test(t)) return true;
  const envDrive = /^env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(t);
  if (envDrive && SECRET_NAME_RE.test(envDrive[1] as string)) return true;
  for (const m of t.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi)) if (SECRET_NAME_RE.test(m[1] as string)) return true;
  for (const m of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] as string;
    if (!/^env$/i.test(name) && SECRET_NAME_RE.test(name)) return true;
  }
  for (const m of t.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) if (SECRET_NAME_RE.test(m[1] as string)) return true;
  if (/process\.env(?!\s*(?:\.|\[\s*['"`])\s*[A-Za-z_])/.test(t)) return true;
  for (const m of t.matchAll(/process\.env\s*(?:\.|\[\s*['"`])\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (SECRET_NAME_RE.test(m[1] as string)) return true;
  }
  if (/os\.environ(?!\s*(?:\[|\.get\s*\())/.test(t)) return true;
  for (const m of t.matchAll(/os\.environ(?:\[\s*|\.get\(\s*)['"]([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (SECRET_NAME_RE.test(m[1] as string)) return true;
  }
  if (/getenvironmentvariables\s*\(/i.test(t)) return true;
  for (const m of t.matchAll(/getenvironmentvariable\s*\(\s*['"]([^'"]+)/gi)) {
    if (SECRET_NAME_RE.test(m[1] as string)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

class Acc {
  readonly caps = new Set<Capability>();
  readonly risks: RiskClass[] = [];
  readonly reasons: string[] = [];
  readonly writeTargets: string[] = [];

  add(risk: RiskClass, caps: Capability[], reason: string): void {
    this.risks.push(risk);
    for (const c of caps) this.caps.add(c);
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }

  merge(other: CommandClassification, prefix?: string): void {
    for (const r of other.riskSet) this.risks.push(r);
    for (const c of other.capabilities) this.caps.add(c);
    for (const reason of other.reasons) {
      const text = prefix ? `${prefix}: ${reason}` : reason;
      if (!this.reasons.includes(text)) this.reasons.push(text);
    }
    this.writeTargets.push(...other.writeTargets);
  }

  result(): CommandClassification {
    const riskSet = RISK_CLASS_IDS.filter((r) => this.risks.includes(r));
    return {
      capabilities: sortCapabilities(this.caps),
      risk: maxRisk(...this.risks),
      reasons: [...this.reasons],
      riskSet,
      writeTargets: [...new Set(this.writeTargets)],
    };
  }
}

const MAX_DEPTH = 4;

/** Classify a shell command line into capabilities and a risk class (spec §7/§8). */
export function classifyCommand(spec: string): CommandClassification {
  return classifyInternal(spec, 0);
}

function classifyInternal(spec: string, depth: number): CommandClassification {
  const acc = new Acc();
  if (typeof spec !== "string" || !spec.trim()) {
    acc.add("R0", [], "empty command");
    return acc.result();
  }
  if (depth > MAX_DEPTH) {
    acc.add("R3", ["process.exec"], "command nesting too deep to inspect safely");
    return acc.result();
  }
  const lexed = lex(spec);
  if (lexed.unbalanced) {
    acc.add("R3", ["process.exec"], "unbalanced quoting or substitution: command cannot be inspected safely");
  }
  if (lexed.segments.length > 1 || lexed.substitutions.length > 0) {
    acc.add("R0", [], "shell chaining/substitution: risk is the most severe of all parts");
  }
  for (const sub of lexed.substitutions) acc.merge(classifyInternal(sub, depth + 1), "command substitution");
  for (const target of lexed.redirects) classifyRedirect(target, acc);
  for (const seg of lexed.segments) classifySegment(seg, depth, acc);
  if (acc.risks.every((r) => r === "R0") && acc.caps.size === 0) {
    acc.add("R1", ["process.exec"], "unrecognised command: bounded local execution");
  }
  return acc.result();
}

function classifyRedirect(target: string, acc: Acc): void {
  const t = target.trim();
  const lower = t.toLowerCase();
  if (!t || ["/dev/null", "nul", "$null", "/dev/stdout", "/dev/stderr"].includes(lower)) return;
  if (/^\/dev\/(sd|hd|nvme|disk|mmcblk)/.test(lower) || /^\\\\\.\\physicaldrive/i.test(t)) {
    acc.add("R4", ["filesystem.write"], `output redirection overwrites a raw device (${t})`);
    return;
  }
  if (isSecretPathToken(t)) {
    acc.add("R3", ["filesystem.write", "secret.read"], `output redirection writes a credential file (${t})`);
    return;
  }
  if (/(^|[\\/])\.git([\\/]|$)/i.test(t)) {
    acc.add("R3", ["filesystem.write", "git.write"], `output redirection writes git internals (${t})`);
    return;
  }
  acc.writeTargets.push(t);
  acc.add("R1", ["filesystem.write"], `output redirection writes ${t}`);
}

function classifySegment(seg: Segment, depth: number, acc: Acc): void {
  let toks = seg.tokens.map(stripBrackets).filter((t) => t.length > 0);
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0] as string)) toks = toks.slice(1);
  if (!toks.length) {
    acc.add("R0", [], "shell variable assignment");
    return;
  }
  const name = normName(toks[0] as string);
  const args = toks.slice(1);
  const lowerArgs = args.map((a) => a.toLowerCase());

  const readsScriptFromStdin =
    PIPE_INTERPRETERS.has(name) && (positionals(args).every((a) => a === "-") || lowerArgs.includes("-s"));
  if (seg.piped && (EVAL_NAMES.has(name) || readsScriptFromStdin)) {
    acc.add("R4", ["process.exec"], `piping data into an interpreter (${name}) executes arbitrary code`);
    return;
  }

  if (AGENT_NAMES.has(name)) {
    acc.add("R5", ["process.exec", "agent.spawn"], `spawns an AI agent (${name})`);
    return;
  }

  for (const t of toks) {
    if (isSecretPathToken(t)) acc.add("R3", ["process.exec", "secret.read"], `touches a credential file (${t})`);
    if (isSecretEnvToken(t)) acc.add("R3", ["process.exec", "secret.read"], "reads secret environment variables");
  }
  const joined = toks.join(" ").toLowerCase();
  if (/\bdrop\s+(table|database|schema)\b/.test(joined) || /\btruncate\s+table\b/.test(joined)) {
    acc.add("R4", ["process.exec"], "drops or truncates database objects");
  }

  if (PRIVILEGE_NAMES.has(name)) {
    acc.add("R3", ["process.exec"], `privilege escalation (${name}) is outside the sandbox`);
    const start = args.findIndex((a) => !a.startsWith("-"));
    if (start >= 0) acc.merge(classifyInternal(args.slice(start).join(" "), depth + 1));
    return;
  }

  if (name === "env") {
    const start = args.findIndex((a) => !a.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    if (start < 0) acc.add("R3", ["process.exec", "secret.read"], "dumps environment variables (may expose secrets)");
    else acc.merge(classifyInternal(args.slice(start).join(" "), depth + 1));
    return;
  }
  if (SECRET_TOOL_NAMES.has(name)) {
    acc.add("R3", ["process.exec", "secret.read"], `reads secrets or environment (${name})`);
    return;
  }
  if ((name === "set" || name === "export" || name === "declare") && args.every((a) => /^-[px]*$/.test(a))) {
    acc.add("R3", ["process.exec", "secret.read"], `dumps environment variables (${name})`);
    return;
  }
  if (name === "gpg" && lowerArgs.some((a) => a.startsWith("--export-secret") || a === "--decrypt" || a === "-d")) {
    acc.add("R3", ["process.exec", "secret.read"], "exports or decrypts secret key material");
    return;
  }
  if (name === "reg" && ["save", "export"].includes(lowerArgs[0] ?? "")) {
    acc.add("R3", ["process.exec", "secret.read"], "exports registry hives");
    return;
  }

  if (EVAL_NAMES.has(name)) {
    acc.add("R3", ["process.exec"], `dynamic code evaluation (${name}) cannot be inspected`);
    return;
  }

  // Shell wrappers: classify the inner command string.
  if (SHELLS.has(name)) {
    const ci = args.findIndex((a) => /^-[a-z]*c$/i.test(a));
    if (ci >= 0) {
      acc.add("R1", ["process.exec"], `runs a ${name} command string`);
      acc.merge(classifyInternal(args.slice(ci + 1).join(" "), depth + 1));
    } else acc.add("R1", ["process.exec"], `runs a ${name} script`);
    return;
  }
  if (name === "cmd") {
    const ci = lowerArgs.findIndex((a) => a === "/c" || a === "/k" || a === "/r");
    acc.add("R1", ["process.exec"], "runs a cmd command string");
    if (ci >= 0) acc.merge(classifyInternal(args.slice(ci + 1).join(" "), depth + 1));
    return;
  }
  if (name === "powershell" || name === "pwsh") {
    classifyPowerShell(name, args, depth, acc);
    return;
  }
  if (GENERIC_WRAPPERS.has(name)) {
    acc.add("R1", ["process.exec"], `wrapper command (${name})`);
    const start = args.findIndex((a) => !a.startsWith("-") && !/^\d+(\.\d+)?[smhd]?$/.test(a) && a !== "");
    if (start >= 0) acc.merge(classifyInternal(args.slice(start).join(" "), depth + 1));
    return;
  }

  if (name === "npx" || name === "bunx" || name === "pnpx") {
    classifyNpx(args, depth, acc);
    return;
  }
  if (NODE_PMS.has(name)) {
    classifyNodePm(name, args, depth, acc);
    return;
  }
  if ((name === "python" || name === "python3" || name === "py") && lowerArgs[0] === "-m" && /^pip3?$/.test(lowerArgs[1] ?? "")) {
    classifyPkgManager("pip", args.slice(2), acc);
    return;
  }
  if (PKG_MANAGERS[name]) {
    classifyPkgManager(name, args, acc);
    return;
  }

  if (name === "git") {
    classifyGit(args, acc);
    return;
  }
  if (name === "gh") {
    classifyGh(lowerArgs, acc);
    return;
  }
  if (NETWORK_NAMES.has(name)) {
    acc.add("R2", ["process.exec", "network.connect"], `network access (${name})`);
    return;
  }
  if (name === "certutil" && lowerArgs.some((a) => a.includes("urlcache"))) {
    acc.add("R2", ["process.exec", "network.connect"], "network download (certutil -urlcache)");
    return;
  }
  if (CLOUD_NAMES.has(name)) {
    classifyCloud(name, lowerArgs, acc);
    return;
  }
  if (name === "docker" || name === "podman") {
    classifyDocker(name, lowerArgs, acc);
    return;
  }

  // Destructive local operations.
  if (name === "rm") {
    const recursive = lowerArgs.some((a) => /^-[a-z]*r/.test(a) || a === "--recursive");
    const targets = positionals(args);
    acc.writeTargets.push(...targets);
    if (recursive) acc.add("R4", ["process.exec", "filesystem.write"], "recursive delete (rm -r)");
    else if (targets.some(isBroadTarget)) acc.add("R4", ["process.exec", "filesystem.write"], "deletes a broad path");
    else acc.add("R1", ["process.exec", "filesystem.write"], "deletes files");
    return;
  }
  if (name === "rmdir" || name === "rd" || name === "del" || name === "erase") {
    const recursive = lowerArgs.some((a) => a === "/s" || /^-r/.test(a));
    const targets = positionals(args);
    acc.writeTargets.push(...targets);
    if (recursive) acc.add("R4", ["process.exec", "filesystem.write"], `recursive delete (${name} /s)`);
    else if (targets.some(isBroadTarget)) acc.add("R4", ["process.exec", "filesystem.write"], "deletes a broad path");
    else acc.add("R1", ["process.exec", "filesystem.write"], "deletes files");
    return;
  }
  if (name === "remove-item" || name === "ri") {
    const recursive = lowerArgs.some((a) => /^-r(e|ec|ecu|ecur|ecurs|ecurse)?(:.*)?$/.test(a));
    const targets = positionals(args);
    acc.writeTargets.push(...targets);
    if (recursive) acc.add("R4", ["process.exec", "filesystem.write"], "recursive delete (Remove-Item -Recurse)");
    else if (targets.some(isBroadTarget)) acc.add("R4", ["process.exec", "filesystem.write"], "deletes a broad path");
    else acc.add("R1", ["process.exec", "filesystem.write"], "deletes files");
    return;
  }
  if (DISK_DESTRUCTIVE.has(name) || /^mkfs(\.|$)/.test(name)) {
    acc.add("R4", ["process.exec", "filesystem.write"], `destructive disk/filesystem operation (${name})`);
    return;
  }
  if (name === "format" && args.length > 0) {
    acc.add("R4", ["process.exec", "filesystem.write"], "formats a volume");
    return;
  }
  if (name === "dd" && lowerArgs.some((a) => a.startsWith("of="))) {
    acc.add("R4", ["process.exec", "filesystem.write"], "raw block write (dd of=)");
    return;
  }
  if (name === "cipher" && lowerArgs.some((a) => a.startsWith("/w"))) {
    acc.add("R4", ["process.exec", "filesystem.write"], "wipes free space (cipher /w)");
    return;
  }
  if (name === "robocopy" && lowerArgs.some((a) => a === "/mir" || a === "/purge")) {
    acc.add("R4", ["process.exec", "filesystem.write"], "mirror copy deletes destination files (robocopy /MIR)");
    return;
  }
  if (POWER_NAMES.has(name)) {
    acc.add("R4", ["process.exec"], `power operation (${name})`);
    return;
  }
  if (name === "find") {
    if (lowerArgs.includes("-delete")) acc.add("R4", ["process.exec", "filesystem.write"], "find -delete removes files");
    else if (lowerArgs.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) {
      acc.add("R2", ["process.exec"], "find -exec runs arbitrary commands");
    } else acc.add("R0", ["process.exec", "filesystem.read"], "read-only search (find)");
    return;
  }
  if (name === "sed" || name === "perl") {
    if (lowerArgs.some((a) => /^-[a-z]*i/.test(a))) {
      const targets = positionals(args).slice(1);
      acc.writeTargets.push(...targets);
      acc.add("R1", ["process.exec", "filesystem.write"], `in-place edit (${name} -i)`);
    } else acc.add("R1", ["process.exec"], `runs ${name}`);
    return;
  }

  if (WRITE_LAST_OPERAND.has(name)) {
    const ops = positionals(args);
    const last = ops[ops.length - 1];
    if (last !== undefined) acc.writeTargets.push(last);
    acc.add("R1", ["process.exec", "filesystem.write"], `writes files (${name})`);
    return;
  }
  if (WRITE_ALL_OPERANDS.has(name)) {
    acc.writeTargets.push(...positionals(args));
    acc.add("R1", ["process.exec", "filesystem.write"], `writes files (${name})`);
    return;
  }
  if (READ_ONLY_NAMES.has(name)) {
    acc.add("R0", ["process.exec", "filesystem.read"], `read-only command (${name})`);
    return;
  }
  acc.add("R1", ["process.exec"], `local process (${name})`);
}

function isBroadTarget(target: string): boolean {
  const t = target.replace(/\\/g, "/");
  return ["/", "/*", "~", "~/", "~/*", "*", ".", "..", "./*", "../*", "*.*"].includes(t) || /^[a-z]:\/?\*?$/i.test(t);
}

function classifyPowerShell(name: string, args: string[], depth: number, acc: Acc): void {
  const lower = args.map((a) => a.toLowerCase());
  if (lower.some((a) => a === "-e" || a === "-ec" || /^-en(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?$/.test(a))) {
    acc.add("R3", ["process.exec"], `${name} -EncodedCommand cannot be inspected`);
    return;
  }
  acc.add("R1", ["process.exec"], `runs a ${name} command`);
  const fileIdx = lower.findIndex((a) => /^-f(i(l(e)?)?)?$/.test(a));
  if (fileIdx >= 0) return;
  const cmdIdx = lower.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(a));
  let rest: string[];
  if (cmdIdx >= 0) rest = args.slice(cmdIdx + 1);
  else {
    rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = lower[i] as string;
      if (a.startsWith("-")) {
        if (/^-(ex(ecutionpolicy)?|wi(ndowstyle)?|ver(sion)?|wd|workingdirectory)$/.test(a)) i++;
        continue;
      }
      rest = args.slice(i);
      break;
    }
  }
  if (rest.length) acc.merge(classifyInternal(rest.join(" "), depth + 1));
}

function classifyNpx(args: string[], depth: number, acc: Acc): void {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "-p" || a === "--package") {
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const pkgToken = args[i];
  if (pkgToken === undefined) {
    acc.add("R1", ["process.exec"], "npx without a package");
    return;
  }
  const pkg = pkgToken.toLowerCase().replace(/(?<=.)@[^/]*$/, "");
  const agent = AGENT_PACKAGES[pkg] ?? (AGENT_NAMES.has(normName(pkg)) ? normName(pkg) : undefined);
  if (agent) {
    acc.add("R5", ["process.exec", "agent.spawn"], `spawns an AI agent via npx (${agent})`);
    return;
  }
  acc.merge(classifyInternal([normName(pkg), ...args.slice(i + 1)].join(" "), depth + 1));
}

function classifyNodePm(name: string, args: string[], depth: number, acc: Acc): void {
  const lower = args.map((a) => a.toLowerCase());
  const subIdx = lower.findIndex((a) => !a.startsWith("-"));
  const sub = subIdx >= 0 ? (lower[subIdx] as string) : "";
  if (name === "yarn" && sub === "") {
    acc.add("R2", ["process.exec", "package.install", "network.connect"], "installs packages (yarn)");
    return;
  }
  if (NODE_EXEC.has(sub)) {
    classifyNpx(args.slice(subIdx + 1), depth, acc);
    return;
  }
  if (NODE_INSTALL.has(sub)) {
    acc.add("R2", ["process.exec", "package.install", "network.connect"], `installs packages (${name} ${sub})`);
    return;
  }
  if (sub === "publish") {
    acc.add("R2", ["process.exec", "network.connect"], `publishes a package to a registry (${name} publish)`);
    return;
  }
  if (sub === "unpublish") {
    acc.add("R4", ["process.exec", "network.connect"], `removes a published package (${name} unpublish)`);
    return;
  }
  if (sub === "deprecate" || sub === "dist-tag" || sub === "owner" || sub === "access") {
    acc.add("R2", ["process.exec", "network.connect"], `changes registry state (${name} ${sub})`);
    return;
  }
  if (NODE_CREDENTIALS.has(sub)) {
    acc.add("R3", ["process.exec", "secret.read"], `handles registry credentials (${name} ${sub})`);
    return;
  }
  if (sub === "config" && ["set", "delete", "edit"].includes(lower[subIdx + 1] ?? "")) {
    acc.add("R2", ["process.exec"], `changes ${name} configuration`);
    return;
  }
  acc.add("R1", ["process.exec"], `runs a package script (${name}${sub ? ` ${sub}` : ""})`);
}

function classifyPkgManager(name: string, args: string[], acc: Acc): void {
  const entry = PKG_MANAGERS[name];
  if (!entry) return;
  const lower = args.map((a) => a.toLowerCase());
  const sub = lower.find((a) => !a.startsWith("-")) ?? "";
  if (name === "pacman" && lower.some((a) => /^-S/i.test(a) || /^--sync/.test(a))) {
    acc.add("R2", ["process.exec", "package.install", "network.connect"], "installs packages (pacman -S)");
    return;
  }
  if (entry.publish.includes(sub)) {
    acc.add("R2", ["process.exec", "network.connect"], `publishes a package (${name} ${sub})`);
    return;
  }
  if (entry.install.includes("*") || entry.install.includes(sub)) {
    acc.add("R2", ["process.exec", "package.install", "network.connect"], `installs packages (${name}${sub ? ` ${sub}` : ""})`);
    return;
  }
  acc.add("R1", ["process.exec"], `runs ${name}${sub ? ` ${sub}` : ""}`);
}

function classifyGit(args: string[], acc: Acc): void {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i += 2;
      continue;
    }
    if (a.startsWith("-") && !GIT_READ.has(a)) {
      i++;
      continue;
    }
    break;
  }
  const sub = (args[i] ?? "").toLowerCase();
  const rest = args.slice(i + 1);
  const lower = rest.map((a) => a.toLowerCase());
  const gw: Capability[] = ["process.exec", "git.write"];
  const net: Capability[] = ["process.exec", "network.connect"];
  if (!sub) {
    acc.add("R0", ["process.exec"], "git without a subcommand");
    return;
  }
  if (GIT_READ.has(sub)) {
    acc.add("R0", ["process.exec", "filesystem.read"], `read-only git (${sub})`);
    return;
  }
  switch (sub) {
    case "push": {
      const force = rest.some(
        (a) =>
          a === "-f" ||
          a === "--force" ||
          a.startsWith("--force-with-lease") ||
          a === "--force-if-includes" ||
          a === "--mirror" ||
          a === "--delete" ||
          a === "-d" ||
          a === "--prune" ||
          /^\+/.test(a) ||
          /^:[^/]/.test(a)
      );
      if (force) acc.add("R4", [...gw, "network.connect"], "force/destructive push rewrites remote history");
      else acc.add("R2", [...gw, "network.connect"], "pushes to a git remote");
      return;
    }
    case "reset":
      if (lower.includes("--hard") || lower.includes("--merge")) acc.add("R4", gw, "git reset --hard discards work");
      else acc.add("R2", gw, "git reset mutates the index/history");
      return;
    case "clean":
      if (lower.some((a) => a === "-n" || a === "--dry-run")) acc.add("R0", ["process.exec"], "git clean dry run");
      else if (lower.some((a) => /^-[a-z]*f/.test(a) || a === "--force")) acc.add("R4", gw, "git clean -f deletes untracked files");
      else acc.add("R2", gw, "git clean");
      return;
    case "checkout":
    case "restore":
      if (lower.includes(".") || lower.includes("-f") || lower.includes("--force") || (sub === "checkout" && lower.includes("--"))) {
        acc.add("R4", gw, `git ${sub} discards working tree changes`);
      } else acc.add("R2", gw, `git ${sub} mutates the working tree`);
      return;
    case "branch": {
      const del = lower.some((a) => a === "-d" || a === "--delete");
      if (rest.includes("-D") || (del && lower.some((a) => a === "--force" || a === "-f"))) {
        acc.add("R4", gw, "force-deletes a branch");
      } else if (lower.some((a) => ["-d", "--delete", "-m", "-c", "--set-upstream-to", "-u"].includes(a)) || positionals(rest).length) {
        acc.add("R2", gw, "mutates git branches");
      } else acc.add("R0", ["process.exec"], "lists git branches");
      return;
    }
    case "tag":
      if (!rest.length || lower.some((a) => a === "-l" || a === "--list")) acc.add("R0", ["process.exec"], "lists git tags");
      else acc.add("R2", gw, "mutates git tags");
      return;
    case "remote":
      if (!rest.length || ["-v", "--verbose", "show", "get-url"].includes(lower[0] ?? "")) acc.add("R0", ["process.exec"], "inspects git remotes");
      else acc.add("R2", gw, "mutates git remotes");
      return;
    case "config": {
      if (rest.some((a) => /credential|token|password/i.test(a))) {
        acc.add("R3", ["process.exec", "secret.read"], "reads or writes git credentials configuration");
        return;
      }
      const readOnly = lower.some((a) => ["--get", "--get-all", "--list", "-l", "--get-regexp", "--show-origin"].includes(a)) || positionals(rest).length <= 1;
      if (readOnly) acc.add("R0", ["process.exec"], "reads git config");
      else acc.add("R2", gw, "changes git config");
      return;
    }
    case "stash":
      if (["list", "show"].includes(lower[0] ?? "")) acc.add("R0", ["process.exec"], "inspects git stash");
      else if (["drop", "clear"].includes(lower[0] ?? "")) acc.add("R4", gw, "drops stashed work");
      else acc.add("R2", gw, "mutates git stash");
      return;
    case "fetch":
    case "ls-remote":
      acc.add("R2", net, `contacts a git remote (${sub})`);
      return;
    case "pull":
    case "clone":
    case "submodule":
      acc.add("R2", [...gw, "network.connect"], `fetches from a git remote and writes (${sub})`);
      return;
    case "filter-branch":
    case "filter-repo":
      acc.add("R4", gw, "rewrites repository history");
      return;
    case "reflog":
      if (lower.includes("expire") || lower.includes("delete")) acc.add("R4", gw, "expires reflog entries");
      else acc.add("R0", ["process.exec"], "reads reflog");
      return;
    case "gc":
      if (lower.some((a) => a.startsWith("--prune"))) acc.add("R4", gw, "prunes unreachable objects");
      else acc.add("R2", gw, "git gc");
      return;
    case "update-ref":
      if (lower.includes("-d")) acc.add("R4", gw, "deletes a ref");
      else acc.add("R2", gw, "updates a ref");
      return;
    case "credential":
    case "credential-store":
    case "credential-manager":
      acc.add("R3", ["process.exec", "secret.read"], "accesses git credentials");
      return;
    case "send-email":
    case "request-pull":
      acc.add("R2", net, `sends data over the network (git ${sub})`);
      return;
    default:
      acc.add("R2", gw, `mutates local git state (git ${sub})`);
  }
}

function classifyGh(args: string[], acc: Acc): void {
  const sub = args[0] ?? "";
  const action = args[1] ?? "";
  const net: Capability[] = ["process.exec", "network.connect"];
  if (sub === "auth") {
    if (action === "token" || args.includes("--show-token") || args.includes("-t") || ["login", "refresh", "setup-git"].includes(action)) {
      acc.add("R3", ["process.exec", "secret.read"], `manages GitHub credentials (gh auth ${action})`);
    } else acc.add("R2", net, "gh auth status");
    return;
  }
  if (action === "delete" && ["repo", "release", "secret", "variable", "gist", "label", "run", "cache"].includes(sub)) {
    acc.add("R4", [...net, "git.write"], `deletes GitHub resources (gh ${sub} delete)`);
    return;
  }
  if (sub === "api") {
    const method = args.findIndex((a) => a === "-x" || a === "--method");
    const m = method >= 0 ? args[method + 1] ?? "" : "";
    const mutating = (m && m !== "get") || args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a));
    if (mutating) acc.add("R2", [...net, "git.write"], "mutating GitHub API call");
    else acc.add("R2", net, "GitHub API call");
    return;
  }
  if (GH_MUTATING.has(action) || sub === "release" || sub === "secret") {
    acc.add("R2", [...net, "git.write"], `writes to GitHub (gh ${sub}${action ? ` ${action}` : ""})`);
    return;
  }
  acc.add("R2", net, `contacts GitHub (gh ${sub})`);
}

function classifyCloud(name: string, args: string[], acc: Acc): void {
  const net: Capability[] = ["process.exec", "network.connect"];
  const sub = args[0] ?? "";
  if (name === "aws") {
    if (sub === "configure" || args.includes("get-secret-value") || args.includes("get-session-token") || args.includes("--with-decryption")) {
      acc.add("R3", [...net, "secret.read"], "reads cloud credentials or secrets (aws)");
      return;
    }
    if ((args.includes("rm") && args.includes("--recursive")) || (args.includes("rb") && args.includes("--force"))) {
      acc.add("R4", net, "recursive cloud storage delete (aws s3)");
      return;
    }
  }
  if (
    args.includes("destroy") ||
    (name === "kubectl" && sub === "delete") ||
    (name === "helm" && (sub === "uninstall" || sub === "delete")) ||
    (name === "vercel" && (sub === "remove" || sub === "rm")) ||
    args.some((a) => a.endsWith(":destroy") || a.endsWith(":delete"))
  ) {
    acc.add("R4", net, `destroys cloud resources (${name} ${sub})`);
    return;
  }
  if (["login", "auth"].includes(sub) || (name === "gcloud" && sub === "auth")) {
    acc.add("R3", [...net, "secret.read"], `manages cloud credentials (${name} ${sub})`);
    return;
  }
  acc.add("R2", net, `cloud/deployment CLI (${name}${sub ? ` ${sub}` : ""})`);
}

function classifyDocker(name: string, args: string[], acc: Acc): void {
  const sub = args[0] ?? "";
  const net: Capability[] = ["process.exec", "network.connect"];
  if (sub === "login") acc.add("R3", [...net, "secret.read"], `${name} login handles registry credentials`);
  else if (sub === "push") acc.add("R2", net, `${name} push publishes an image`);
  else if (sub === "pull") acc.add("R2", net, `${name} pull downloads an image`);
  else if ((sub === "system" || sub === "volume" || sub === "image" || sub === "container") && args.includes("prune")) {
    acc.add("R4", ["process.exec"], `${name} prune deletes data`);
  } else acc.add("R1", ["process.exec"], `runs ${name}${sub ? ` ${sub}` : ""}`);
}
