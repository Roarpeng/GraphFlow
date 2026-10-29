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
 * Runtime: Bun (both hosts). Only `node:child_process` is imported at runtime —
 * no npm dependencies, so the file works as a bare local plugin on both hosts.
 *
 * Export shape — one file, both hosts:
 *   - OpenCode v1 (1.x, incl. >= 1.18.29 object entrypoint) and Kilo Code pick
 *     up the default export `{ id, server }` and register it exactly once.
 *   - Older v1 builds that only understand named exports fall back to
 *     `GraphFlowPromptReflex`.
 */

import { spawnSync } from "node:child_process";

const HOOK_TIMEOUT_MS = 60_000;
const GRAPHFLOW_PACKAGE = "@roarpeng/graphflow";

/** Resolve an executable on PATH (Bun.which honors Windows PATHEXT). */
function which(cmd) {
  const bun = globalThis.Bun;
  if (bun && typeof bun.which === "function") {
    try {
      const found = bun.which(cmd);
      if (found) return found;
    } catch {
      /* ignore and fall through */
    }
  }
  return undefined;
}

/**
 * Absolute-path guard for resolved executables: only `which()`-resolved
 * absolute paths are ever spawned — never a bare PATH-relative name.
 * Matches Windows drive roots, UNC paths, and posix roots.
 */
function isAbsoluteExecutablePath(file) {
  return typeof file === "string" && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(file);
}

/** Candidate command paths for `cmd`: `which()`-resolved absolute paths only. */
function commandCandidates(cmd) {
  const out = [];
  const push = (v) => {
    if (isAbsoluteExecutablePath(v) && !out.includes(v)) out.push(v);
  };
  push(which(cmd));
  if (process.platform === "win32") {
    for (const ext of [".cmd", ".exe", ".bat"]) push(which(cmd + ext));
  }
  return out;
}

/**
 * Run `graphflow hook user-prompt` synchronously with the JSON payload on stdin.
 * On Windows, npm installs `graphflow` as a `.cmd` shim, and both Node and Bun
 * refuse to spawn `.cmd`/`.bat` directly (EINVAL) — so every candidate gets a
 * second attempt wrapped in `cmd.exe /d /s /c`. Falls back to npx when
 * `graphflow` is not on PATH. Returns undefined when nothing could run.
 */
function runGraphFlowHook(stdinPayload) {
  const isWin = process.platform === "win32";
  const comspec = isWin
    ? isAbsoluteExecutablePath(process.env.ComSpec)
      ? process.env.ComSpec
      : "C:\\Windows\\System32\\cmd.exe"
    : "";
  const SPAWN_OPTS = {
    timeout: HOOK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  };

  const exec = (file, args) => {
    try {
      const res = spawnSync(file, args, { ...SPAWN_OPTS, input: stdinPayload });
      if (!res.error && res.status !== null) {
        return {
          status: res.status,
          stdout: typeof res.stdout === "string" ? res.stdout : "",
          stderr: typeof res.stderr === "string" ? res.stderr : "",
        };
      }
    } catch {
      /* fall through */
    }
    if (isWin) {
      try {
        const quoted = /[ "]/.test(file) ? `"${file}"` : file;
        const res = spawnSync(comspec, ["/d", "/s", "/c", `${quoted} ${args.join(" ")}`], {
          ...SPAWN_OPTS,
          input: stdinPayload,
        });
        if (!res.error && res.status !== null) {
          return {
            status: res.status,
            stdout: typeof res.stdout === "string" ? res.stdout : "",
            stderr: typeof res.stderr === "string" ? res.stderr : "",
          };
        }
      } catch {
        /* fall through */
      }
    }
    return undefined;
  };

  const graphflowArgs = ["hook", "user-prompt"];
  const npxArgs = ["-y", `--package=${GRAPHFLOW_PACKAGE}`, "graphflow", ...graphflowArgs];

  for (const file of commandCandidates("graphflow")) {
    const result = exec(file, graphflowArgs);
    if (result) return result;
  }
  for (const file of commandCandidates("npx")) {
    const result = exec(file, npxArgs);
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
