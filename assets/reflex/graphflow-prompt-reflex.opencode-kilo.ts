/**
 * GraphFlow Prompt Reflex — shared OpenCode (v1) / Kilo Code plugin.
 *
 * Hook: `chat.message` (fires when a new user message arrives, BEFORE the LLM;
 * output.parts is passed by reference — mutating it in place rewrites the user
 * message that is persisted and sent to the model).
 *
 * Behavior (mirrors `graphflow hook user-prompt`):
 *   exit 2           → macro executed locally; REPLACE the user text with a
 *                      reflex note + summary from stderr.
 *   exit 0 + stdout  → stdout is JSON {"hookSpecificOutput":{"additionalContext":hint}};
 *                      APPEND the hint to the user text.
 *   anything else    → stay silent. Never break the host.
 *
 * Kill switch: GRAPHFLOW_PROMPT_REFLEX=0 disables everything (no child spawn).
 *
 * Runtime: Bun (both hosts). Only node builtins (`node:child_process`,
 * `node:fs`, `node:path`) are imported at runtime — no npm dependencies, so
 * the file works as a bare local plugin on both hosts.
 *
 * Export shape — one file, both hosts:
 *   - OpenCode v1 (1.x, incl. >= 1.18.29 object entrypoint) and Kilo Code pick
 *     up the default export `{ id, server }` and register it exactly once.
 *   - Older v1 builds that only understand named exports fall back to
 *     `GraphFlowPromptReflex`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const HOOK_TIMEOUT_MS = 60_000;
const GRAPHFLOW_PACKAGE = "@roarpeng/graphflow";

/** Default PATHEXT probe order when the env var is missing on Windows. */
const PATH_EXT_DEFAULT = [".com", ".exe", ".bat", ".cmd"];

/**
 * Resolve every absolute `name` (plus Windows PATHEXT variants) on PATH, in
 * PATH order. Deterministic and shell-free — replaces `which`, so resolution
 * behaves identically on any runtime and finds installs beyond the FIRST
 * PATH hit (e.g. a stale project-local `.bin` shadowing a global install).
 */
function resolveAllOnPath(name) {
  const out = [];
  const pathEnv = process.env.PATH ?? "";
  const sep = pathEnv.includes(";") ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? [
          ...new Set([
            ...(process.env.PATHEXT ?? "").split(";").filter(Boolean),
            ...PATH_EXT_DEFAULT,
            "",
          ]),
        ]
      : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!isAbsoluteExecutablePath(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate) && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * Absolute-path guard for resolved executables: only `which()`-resolved
 * absolute paths are ever spawned — never a bare PATH-relative name.
 * Matches Windows drive roots, UNC paths, and posix roots.
 */
function isAbsoluteExecutablePath(file) {
  return typeof file === "string" && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(file);
}

/** Candidate command paths for `cmd`: every absolute PATH hit, in order. */
function commandCandidates(cmd) {
  return resolveAllOnPath(cmd);
}

/**
 * Resolve a package file that npm-family installs place under
 * `<dir>/node_modules/<pkgPath...>`. No shell is involved — this sidesteps
 * the Windows `.cmd` shim problem entirely.
 */
function jsEntryInDir(dir, ...pkgPath) {
  if (!isAbsoluteExecutablePath(dir)) return undefined;
  const entry = join(dir, "node_modules", ...pkgPath);
  return existsSync(entry) ? entry : undefined;
}

/** Direct file probe: `dir` must be absolute; segments are joined as-is. */
function jsFileAt(dir, ...segments) {
  if (!isAbsoluteExecutablePath(dir)) return undefined;
  const entry = join(dir, ...segments);
  return existsSync(entry) ? entry : undefined;
}

function graphflowCliCandidates() {
  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  for (const shim of commandCandidates("graphflow")) {
    const binDir = dirname(shim);
    // npm unix global installs symlink the bin straight at dist/cli.js —
    // the realpath IS the entry. Also covers pnpm-style link farms.
    try {
      const real = realpathSync(shim);
      if (/dist[\\/]cli\.js$/.test(real)) push(real);
    } catch {
      /* not a resolvable link */
    }
    // npm global on Windows / project root: <binDir>/node_modules/...
    push(jsEntryInDir(binDir, "@roarpeng", "graphflow", "dist", "cli.js"));
    // npm global on unix: <prefix>/bin + <prefix>/lib/node_modules/...
    push(jsEntryInDir(join(binDir, "..", "lib"), "@roarpeng", "graphflow", "dist", "cli.js"));
    // yarn classic global: <prefix>/bin + <prefix>/global/node_modules/...
    push(jsEntryInDir(join(binDir, "..", "global"), "@roarpeng", "graphflow", "dist", "cli.js"));
    // npm project-local / hoisted layout: shims in node_modules/.bin, the
    // package tree one level up.
    if (basename(binDir) === ".bin") {
      push(jsFileAt(dirname(binDir), "@roarpeng", "graphflow", "dist", "cli.js"));
    }
  }
  return out;
}

function npxCliCandidates() {
  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  for (const shim of commandCandidates("npx")) {
    const binDir = dirname(shim);
    push(jsEntryInDir(binDir, "npm", "bin", "npx-cli.js"));
    push(jsEntryInDir(join(binDir, "..", "lib"), "npm", "bin", "npx-cli.js"));
    if (basename(binDir) === ".bin") {
      push(jsFileAt(dirname(binDir), "npm", "bin", "npx-cli.js"));
    }
  }
  return out;
}

/**
 * Absolute JS runtime candidates: every `node` on PATH (PATHEXT order puts
 * node.exe first on Windows), then the host runtime itself
 * (`process.execPath` — Bun runs plain node scripts fine).
 */
function jsRuntimeCandidates() {
  const out = [...resolveAllOnPath("node")];
  if (isAbsoluteExecutablePath(process.execPath) && !out.includes(process.execPath)) {
    out.push(process.execPath);
  }
  return out;
}

/**
 * Run `graphflow hook user-prompt` synchronously with the JSON payload on
 * stdin. Never touches a shell: the installed CLI's JS entry is resolved as
 * a sibling of the bin shim and spawned directly with an absolute JS
 * runtime. Falls back to npx's own `npx-cli.js` the same way when
 * `graphflow` is not resolvable. Returns undefined when nothing could run
 * (the hook then stays silent, never breaking the host). Install layouts no
 * rule covers (e.g. pnpm global on Windows) disable the reflex rather than
 * falling back to a shell.
 */
function runGraphFlowHook(stdinPayload) {
  const SPAWN_OPTS = {
    timeout: HOOK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  };

  const exec = (args) => {
    for (const runtime of jsRuntimeCandidates()) {
      try {
        const res = spawnSync(runtime, args, { ...SPAWN_OPTS, input: stdinPayload });
        if (!res.error && res.status !== null) {
          return {
            status: res.status,
            stdout: typeof res.stdout === "string" ? res.stdout : "",
            stderr: typeof res.stderr === "string" ? res.stderr : "",
          };
        }
      } catch {
        /* try the next runtime */
      }
    }
    return undefined;
  };

  for (const cli of graphflowCliCandidates()) {
    const result = exec([cli, "hook", "user-prompt"]);
    if (result) return result;
  }
  const npxArgs = ["-y", `--package=${GRAPHFLOW_PACKAGE}`, "graphflow", "hook", "user-prompt"];
  for (const npxCli of npxCliCandidates()) {
    const result = exec([npxCli, ...npxArgs]);
    if (result) return result;
  }
  return undefined;
}

function extractUserText(output) {
  if (!Array.isArray(output?.parts)) return undefined;
  const texts = [];
  let first;
  for (const part of output.parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (!first) first = part;
    if (part.text.length > 0) texts.push(part.text);
  }
  if (!first) return undefined;
  return { text: texts.join("\n"), part: first };
}

async function onChatMessage(input, output) {
  if (process.env.GRAPHFLOW_PROMPT_REFLEX === "0") return;

  const user = extractUserText(output);
  if (!user || user.text.trim().length === 0) return;

  const payload = JSON.stringify({
    prompt: user.text,
    cwd: process.cwd(),
    session_id: input?.sessionID ?? "",
  });
  const result = runGraphFlowHook(payload);
  if (!result) return;

  if (result.status === 2) {
    const summary = (result.stderr || "").trim() || (result.stdout || "").trim() || "已执行匹配的 GraphFlow 宏";
    user.part.text =
      `[GraphFlow Prompt Reflex] ${summary}\n\n` +
      `(原始输入:"${user.text}"。该操作已在本地完成,无需模型处理,简要确认即可。)`;
    return;
  }

  if (result.status === 0 && result.stdout.trim().length > 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      const hint = parsed?.hookSpecificOutput?.additionalContext;
      if (typeof hint === "string" && hint.trim().length > 0) {
        user.part.text = `${user.text}\n[GraphFlow Prompt Reflex 提示] ${hint.trim()}`;
      }
    } catch {
      /* stdout was not the expected JSON — stay silent */
    }
  }
}

export const GraphFlowPromptReflex = async () => ({
  "chat.message": async (input, output) => {
    try {
      await onChatMessage(input, output);
    } catch {
      /* never break the host */
    }
  },
});

// Preferred entrypoint on OpenCode v1 >= 1.18.29 and on Kilo Code
// (`id` is required for local-file plugins on Kilo).
export default {
  id: "graphflow-prompt-reflex",
  server: GraphFlowPromptReflex,
};
