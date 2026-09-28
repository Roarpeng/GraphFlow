/**
 * GraphFlow opencode plugin glue.
 *
 * Loaded by opencode from `~/.config/opencode/plugins/graphflow.mjs` (global) or
 * `.opencode/plugins/graphflow.mjs` (project). opencode calls each exported
 * plugin function with `{ project, client, $, directory, worktree }` and expects
 * a hooks object back.
 *
 * Job (dsh/plugin.mjs parity): close the GraphFlow learning loop on session
 * boundaries — capture the last assistant reply of a turn and backfill the
 * pending dialogue turn through the local `graphflow` CLI (idempotent tip fill).
 *
 * Rules:
 * - Best-effort: NEVER throw into the opencode loop (every handler try/caught).
 * - One env switch: `GRAPHFLOW_OPENCODE_PLUGIN=0` disables the plugin.
 * - No hard dependency on the opencode SDK; `ctx` is unused (duck-typed).
 * - The exported factory is injectable (`spawn`/`env`) so tests stay offline.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join as joinPath } from "node:path";

export const name = "graphflow-opencode";
export const ENABLED_ENV = "GRAPHFLOW_OPENCODE_PLUGIN";

/** @param {string} p */
const fileExists = (p) => {
  try {
    return Boolean(p) && existsSync(p);
  } catch {
    return false;
  }
};

/** Reply text is clipped before it crosses a process boundary. */
const REPLY_CLIP_MAX = 4000;
/** CLI children are killed after this long (detached:false + timeout). */
const FILL_TIMEOUT_MS = 20_000;

/**
 * One-switch kill for the plugin. `GRAPHFLOW_OPENCODE_PLUGIN` in
 * {0,false,off,no,disabled} (case-insensitive) disables it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isEnabled(env = process.env) {
  const raw = env[ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
}

/** Separate switch: the plugin's session hooks and its MCP registration are
 *  independently useful, and registering a second server is not something to
 *  turn on for someone who already has one in opencode.json. */
export const MCP_ENV = "GRAPHFLOW_OPENCODE_MCP";

export function shouldRegisterMcp(env = process.env) {
  const raw = env[MCP_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Opt-in capability switches to pass through to the MCP server.
 *
 * Every GraphFlow economy feature is default-off because it either costs tokens
 * on every response or changes what the caller receives. A host that registers
 * the server from this plugin therefore gets the plain server unless it asks for
 * more — the switch is listed rather than assumed, so what is active is visible
 * in one place instead of being spread across config files.
 */
export const PASSTHROUGH_ENV = [
  "GRAPHFLOW_PROJECT_BRIEF",
  "GRAPHFLOW_CACHE_LAYOUT",
  "GRAPHFLOW_CONTEXT_ECONOMICS",
  "GRAPHFLOW_FRESHNESS",
  "GRAPHFLOW_ABSTAIN",
  "GRAPHFLOW_ABSTAIN_ENFORCE",
  "GRAPHFLOW_STATIC_PREFIX_TOKENS",
  "GRAPHFLOW_SUFFIX_TOKENS",
];

/**
 * Build the MCP server spec, preferring a local build over the published one.
 *
 * A developer working on GraphFlow needs opencode to exercise the working tree,
 * not whatever npm has. GRAPHFLOW_MCP_SERVER points at an entry point when even
 * that guess is wrong. Without it we prefer `<repo>/dist/surfaces/mcp/server.js`
 * when that file exists and fall back to the installed package, so a user who
 * installed the plugin without building gets the shipped server and nobody
 * silently loses their tools.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {any} [input] opencode plugin context (supplies the workspace)
 * @param {{cwd?:string}} [config]
 */
export function mcpServerSpec(env = process.env, input, config) {
  const explicit = env.GRAPHFLOW_MCP_SERVER?.trim();
  const workspace = resolveWorkspaceDirectory(input, config?.cwd);
  const localEntry = workspace ? joinPath(workspace, "dist", "surfaces", "mcp", "server.js") : "";
  const entry = explicit || (localEntry && fileExists(localEntry) ? localEntry : "");
  const environment = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) environment[key] = value.trim();
  }
  if (env.GRAPHFLOW_LOG_JSON) environment.GRAPHFLOW_LOG_JSON = env.GRAPHFLOW_LOG_JSON;
  if (workspace) environment.GRAPHFLOW_WORKSPACE_ROOT = workspace;
  const spec = { type: "local", command: [process.execPath] };
  spec.command.push(entry);
  spec.enabled = true;
  if (Object.keys(environment).length > 0) spec.environment = environment;
  return spec;
}

/**
 * Collapse whitespace, strip NUL (illegal in argv), and truncate. Never throws.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipReplyText(text, max = REPLY_CLIP_MAX) {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

/**
 * Best-effort extraction of a text part from an opencode `message.part.updated`
 * event. Tolerates both `event.properties.part` and `event.part` shapes.
 * @param {any} event
 * @returns {{ sessionID: string|undefined, text: string } | undefined}
 */
export function extractTextPart(event) {
  if (!event || event.type !== "message.part.updated") return undefined;
  const part = event.properties?.part ?? event.part;
  if (!part || part.type !== "text" || typeof part.text !== "string") return undefined;
  const sessionID = part.sessionID ?? part.sessionId ?? event.properties?.sessionID;
  return { sessionID, text: part.text };
}

/**
 * Workspace directory for the CLI children.
 *
 * opencode calls each plugin with `{ project, client, $, directory, worktree }`.
 * The glue used to ignore them and let every child inherit the *host process*
 * cwd, so a session opened outside the project (or with a subdirectory cwd)
 * recorded its reply into the wrong workspace — and when that cwd is `$HOME`
 * GraphFlow refuses it outright and the fill is dropped silently. Prefer the
 * git worktree root, then the session directory, then `config.cwd`.
 * @param {any} input opencode plugin context
 * @param {string} [fallbackCwd]
 * @returns {string|undefined}
 */
export function resolveWorkspaceDirectory(input, fallbackCwd) {
  const project = input?.project;
  const candidates = [
    input?.worktree,
    input?.directory,
    project?.worktree,
    project?.directory,
    typeof fallbackCwd === "string" ? fallbackCwd : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Spawn the graphflow CLI once, resolving when it closes, errors, or times out.
 * Never rejects. `cwd` is the session workspace resolved by the caller.
 */
function runCli(args, config, cwd) {
  const spawnFn = config.spawn ?? spawn;
  const env = config.env ?? process.env;
  const bin = env.GRAPHFLOW_HOOK_BIN?.trim() || "graphflow";
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        // ignore
      }
      done();
    }, FILL_TIMEOUT_MS);
    let child;
    try {
      child = spawnFn(bin, args, {
        stdio: ["ignore", "ignore", "ignore"],
        env,
        detached: false,
        ...(typeof cwd === "string" && cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
    } catch {
      done();
      return;
    }
    if (typeof child?.on !== "function") {
      done();
      return;
    }
    child.on("error", done);
    child.on("close", done);
  });
}

/**
 * Create an opencode plugin function. Tests inject `spawn`/`env`; production
 * uses the real `node:child_process` spawn and `process.env`.
 * @param {{ spawn?: typeof spawn, env?: NodeJS.ProcessEnv, log?: { warn?: (msg: string) => void }, configPath?: string, cwd?: string }} [config]
 */
export function createGraphFlowPlugin(config = {}) {
  const env = config.env ?? process.env;
  const log = config.log ?? {};
  /** @type {Map<string, string>} */
  const lastTextBySession = new Map();

  // opencode hands the session workspace to the plugin function
  // (`{ project, client, $, directory, worktree }`); resolve it once so every
  // CLI child runs in the project instead of inheriting the host process cwd.
  return async (input = {}) => {
    const workspace = resolveWorkspaceDirectory(input, config.cwd);
    return {
      // Registering the MCP server from the plugin rather than from
      // opencode.json is deliberate. opencode owns that file: an entry written
      // into it by hand was normalised away on the next opencode write, which is
      // observed behaviour, not a theory. A plugin's `mcp` hook is merged by
      // opencode itself, so it survives.
      //
      // Off unless GRAPHFLOW_OPENCODE_MCP is set, so an existing install that
      // already lists graphflow in opencode.json does not end up with two.
      mcp: shouldRegisterMcp(env) ? { graphflow: mcpServerSpec(env, input, config) } : {},

      event: async ({ event }) => {
        try {
          if (!isEnabled(env)) return;
          if (!event || typeof event.type !== "string") return;

          if (event.type === "message.part.updated") {
            const part = extractTextPart(event);
            if (part?.sessionID && part.text) {
              lastTextBySession.set(part.sessionID, part.text);
            }
            return;
          }

          if (event.type === "session.idle" || event.type === "session.deleted") {
            const sessionID =
              event.properties?.sessionID ?? event.properties?.info?.id ?? event.properties?.session?.id;
            const reply = clipReplyText(sessionID ? (lastTextBySession.get(sessionID) ?? "") : "");
            if (sessionID) lastTextBySession.delete(sessionID);
            if (!reply) return;
            const cfgArgs = config.configPath ? ["--config", config.configPath] : [];
            // Both commands are idempotent tip fills; order mirrors dsh/plugin.mjs.
            await runCli([...cfgArgs, "context", "preview", "--reply", reply], config, workspace);
            await runCli([...cfgArgs, "dialogue", "record", "--reply", reply], config, workspace);
          }
        } catch (error) {
          try {
            log.warn?.(
              `[graphflow] opencode plugin: ${error instanceof Error ? error.message : String(error)}`
            );
          } catch {
            // logging must never throw into the harness
          }
        }
      },
    };
  };
}

export const GraphFlowOpenCodePlugin = createGraphFlowPlugin();
export default GraphFlowOpenCodePlugin;
