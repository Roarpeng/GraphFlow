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

export const name = "graphflow-opencode";
export const ENABLED_ENV = "GRAPHFLOW_OPENCODE_PLUGIN";

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
 * Spawn the graphflow CLI once, resolving when it closes, errors, or times out.
 * Never rejects.
 */
function runCli(args, config) {
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
      child = spawnFn(bin, args, { stdio: ["ignore", "ignore", "ignore"], env, detached: false });
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
 * @param {{ spawn?: typeof spawn, env?: NodeJS.ProcessEnv, log?: { warn?: (msg: string) => void }, configPath?: string }} [config]
 */
export function createGraphFlowPlugin(config = {}) {
  const env = config.env ?? process.env;
  const log = config.log ?? {};
  /** @type {Map<string, string>} */
  const lastTextBySession = new Map();

  return async () => {
    return {
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
            await runCli([...cfgArgs, "context", "preview", "--reply", reply], config);
            await runCli([...cfgArgs, "dialogue", "record", "--reply", reply], config);
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
