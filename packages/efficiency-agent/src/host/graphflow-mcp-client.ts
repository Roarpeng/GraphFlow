import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EFF_AGENT_VERSION } from "../version.js";

/**
 * GraphFlow consumer over MCP stdio (2.x plan §12: the first version talks to
 * GraphFlow through MCP, never through its SQLite/files).
 *
 * One server per (command, rootDir) per process, reused across calls: a cold
 * GraphFlow start (node boot, store open, index refresh, embedding model) costs
 * seconds, and a bench run asks for context once per task. The connection is
 * spawned early via `prewarmGraphFlowClient` so the boot overlaps with fact
 * collection, closed after `idleMs` without calls, and never keeps the process
 * alive while idle. `closeGraphFlowClients()` ends every server (CLI exit).
 * `EFF_GRAPHFLOW_POOL=0` restores one short-lived server per call.
 *
 * A fresh process cannot beat the boot cost, so a resident server is the fast
 * path across CLI invocations: `EFF_GRAPHFLOW_MCP=http://127.0.0.1:PORT/mcp`
 * talks Streamable HTTP to `graphflow-mcp --http --port PORT` instead of
 * spawning. Loopback only, unless `EFF_GRAPHFLOW_MCP_TOKEN` supplies a bearer.
 */

export interface GraphFlowServerCommand {
  command: string;
  args: string[];
  /** Streamable HTTP endpoint of an already running server; no spawn. */
  url?: string;
  /** Bearer token for `url` (EFF_GRAPHFLOW_MCP_TOKEN). */
  token?: string;
  /** Why `url` must not be used; every fetch fails with this reason. */
  rejected?: string;
}

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** HTTP endpoint spec → command, or an error when it is unusable or unsafe. */
export function resolveGraphFlowHttpServer(
  spec: string,
  token?: string
): { server: GraphFlowServerCommand } | { error: string } {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return { error: `invalid GraphFlow MCP URL: ${spec}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `unsupported GraphFlow MCP URL scheme: ${url.protocol}` };
  }
  if (!isLoopbackUrl(url) && !token) {
    return { error: `refusing non-loopback GraphFlow MCP URL ${url.host} without EFF_GRAPHFLOW_MCP_TOKEN` };
  }
  return { server: { command: url.href, args: [], url: url.href, ...(token ? { token } : {}) } };
}

export interface GraphFlowAnchor {
  id: string;
  type?: string;
  relevance?: number;
}

export interface GraphFlowContext {
  summary: string[];
  anchors: GraphFlowAnchor[];
  /** Repo-relative files named by file:/symbol:/module: anchors. */
  anchorFiles: string[];
  /** GraphFlow's own token estimate of the packaged context. */
  compressedTokens?: number;
  estimatedRawTokens?: number;
  /** Cross-session Q&A turns GraphFlow matched to this query. */
  dialogueHits: number;
  durationMs: number;
}

export type GraphFlowContextResult =
  | { ok: true; context: GraphFlowContext }
  | { ok: false; error: string; durationMs: number };

/**
 * Server command resolution: explicit override, then EFF_GRAPHFLOW_MCP
 * ("cmd arg …"), then the installed runtime launcher. Undefined means
 * GraphFlow is not reachable from this machine.
 */
export function resolveGraphFlowServer(
  override?: string,
  env: Record<string, string | undefined> = process.env
): GraphFlowServerCommand | undefined {
  const spec = override ?? env.EFF_GRAPHFLOW_MCP;
  if (spec && /^\s*https?:\/\//i.test(spec)) {
    const token = env.EFF_GRAPHFLOW_MCP_TOKEN?.trim();
    const resolved = resolveGraphFlowHttpServer(spec.trim(), token || undefined);
    return "server" in resolved
      ? resolved.server
      : { command: spec.trim(), args: [], url: spec.trim(), rejected: resolved.error };
  }
  if (spec && spec.trim().length > 0) {
    const tokens = Array.from(spec.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? "");
    const [command, ...args] = tokens;
    return command ? { command, args } : undefined;
  }
  const launcher = join(homedir(), ".graphflow", "runtime", "mcp-launcher.cjs");
  if (existsSync(launcher)) {
    return { command: process.execPath, args: [launcher] };
  }
  return undefined;
}

export function anchorFilesFromIds(ids: string[]): string[] {
  const files = new Set<string>();
  for (const id of ids) {
    const match = /^(?:file|symbol|module):(.+?)(?::[0-9a-f]{6,})?$/i.exec(id);
    if (!match) continue;
    const path = match[1]!;
    files.add(/\.[a-z0-9]+$/i.test(path) ? path : `${path}.ts`);
  }
  return [...files];
}

function parseContextPayload(source: string | Record<string, unknown>): Omit<GraphFlowContext, "durationMs"> | undefined {
  let parsed: unknown = source;
  if (typeof source === "string") {
    try {
      parsed = JSON.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as {
    summary?: unknown;
    anchors?: unknown;
    tokenBudget?: { compressedTokens?: unknown; estimatedRawTokens?: unknown };
    dialogueHits?: unknown;
  };
  if (!Array.isArray(body.summary) || !Array.isArray(body.anchors)) return undefined;
  const anchors: GraphFlowAnchor[] = body.anchors
    .filter((a): a is { id: string; type?: unknown; relevance?: unknown } =>
      Boolean(a) && typeof (a as { id?: unknown }).id === "string"
    )
    .map((a) => ({
      id: a.id,
      ...(typeof a.type === "string" ? { type: a.type } : {}),
      ...(typeof a.relevance === "number" ? { relevance: a.relevance } : {}),
    }));
  const compressed = body.tokenBudget?.compressedTokens;
  const raw = body.tokenBudget?.estimatedRawTokens;
  return {
    summary: body.summary.filter((s): s is string => typeof s === "string").slice(0, 24),
    anchors,
    anchorFiles: anchorFilesFromIds(anchors.map((a) => a.id)),
    ...(typeof compressed === "number" ? { compressedTokens: compressed } : {}),
    ...(typeof raw === "number" ? { estimatedRawTokens: raw } : {}),
    dialogueHits: Array.isArray(body.dialogueHits) ? body.dialogueHits.length : 0,
  };
}

const DEFAULT_IDLE_MS = 60_000;
/** How long a graceful stdin-close may take before the server tree is killed. */
const CLOSE_GRACE_MS = 500;

interface GraphFlowConnection {
  key: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  ready: Promise<void>;
  connected: boolean;
  inflight: number;
  pooled: boolean;
  closed: boolean;
  idleMs: number;
  idleTimer: NodeJS.Timeout | undefined;
}

const connections = new Map<string, GraphFlowConnection>();

function poolingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.EFF_GRAPHFLOW_POOL?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function connectionKey(server: GraphFlowServerCommand, rootDir: string): string {
  return JSON.stringify([server.command, ...server.args, rootDir]);
}

/**
 * Idle pooled servers must not hold the event loop open (a CLI would hang until
 * the idle timer), in-flight calls must. The SDK keeps the child private, so
 * this is best effort: when the shape changes the handles simply stay ref'd and
 * `closeGraphFlowClients()` remains the exit path.
 */
function setChildRef(transport: GraphFlowConnection["transport"], ref: boolean): void {
  if (!(transport instanceof StdioClientTransport)) return;
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  if (!child) return;
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as Array<
    { ref?: () => void; unref?: () => void } | null | undefined
  >) {
    try {
      if (ref) handle?.ref?.();
      else handle?.unref?.();
    } catch {
      // handle already closed
    }
  }
}

/** taskkill /T: the server may be a launcher or tsx wrapper with its own child. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => undefined);
      killer.unref();
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

function openConnection(
  server: GraphFlowServerCommand,
  rootDir: string,
  pooled: boolean,
  idleMs: number
): GraphFlowConnection {
  if (server.rejected) throw new Error(server.rejected);
  let transport: GraphFlowConnection["transport"];
  if (server.url) {
    transport = new StreamableHTTPClientTransport(
      new URL(server.url),
      server.token ? { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } } : undefined
    );
  } else {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    env.GRAPHFLOW_MCP_STDIO = "1";
    env.GRAPHFLOW_WORKSPACE_ROOT = rootDir;
    // Lets a GraphFlow server that supports it start its first-preview work at
    // boot; older servers ignore the variable.
    env.GRAPHFLOW_MCP_WARMUP ??= "1";
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: rootDir,
      env,
      stderr: "ignore",
    });
  }
  const client = new Client({ name: "eff-agent", version: EFF_AGENT_VERSION });
  const connection: GraphFlowConnection = {
    key: connectionKey(server, rootDir),
    client,
    transport,
    ready: Promise.resolve(),
    connected: false,
    inflight: 0,
    pooled,
    closed: false,
    idleMs,
    idleTimer: undefined,
  };
  client.onclose = () => {
    connection.closed = true;
    if (connections.get(connection.key) === connection) connections.delete(connection.key);
  };
  // The SDK's HTTP transport types `T | undefined` callbacks that its own
  // exactOptionalPropertyTypes surface rejects; runtime-compatible.
  connection.ready = client.connect(transport as Parameters<Client["connect"]>[0]).then(() => {
    connection.connected = true;
    if (connection.inflight === 0) setChildRef(transport, false);
  });
  // A failed connect is reported by the call that awaits it.
  connection.ready.catch(() => undefined);
  return connection;
}

function acquireConnection(
  server: GraphFlowServerCommand,
  rootDir: string,
  options: { pooled: boolean; idleMs: number }
): GraphFlowConnection {
  if (!options.pooled) return openConnection(server, rootDir, false, options.idleMs);
  const key = connectionKey(server, rootDir);
  const existing = connections.get(key);
  if (existing && !existing.closed) return existing;
  const connection = openConnection(server, rootDir, true, options.idleMs);
  connections.set(key, connection);
  return connection;
}

async function closeConnection(connection: GraphFlowConnection): Promise<void> {
  if (connections.get(connection.key) === connection) connections.delete(connection.key);
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = undefined;
  const pid = connection.transport instanceof StdioClientTransport ? connection.transport.pid : null;
  connection.closed = true;
  let grace: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    connection.client.close().then(
      () => true,
      () => true
    ),
    // A server still booting has nothing to flush; do not wait for it.
    new Promise<boolean>((resolve) => {
      grace = setTimeout(() => resolve(false), connection.connected ? CLOSE_GRACE_MS : 0);
    }),
  ]);
  if (grace) clearTimeout(grace);
  if (!closed && pid !== null) killTree(pid);
}

function releaseConnection(connection: GraphFlowConnection, failed: boolean): void {
  connection.inflight -= 1;
  if (failed || !connection.pooled || connection.closed) {
    if (connection.inflight === 0 || failed) void closeConnection(connection);
    return;
  }
  if (connection.inflight > 0) return;
  setChildRef(connection.transport, false);
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = setTimeout(() => void closeConnection(connection), connection.idleMs);
  connection.idleTimer.unref();
}

/**
 * Start the GraphFlow server for `rootDir` without waiting for it, so its boot
 * overlaps with whatever the caller does next. No-op when pooling is off or a
 * connection already exists.
 */
export function prewarmGraphFlowClient(input: {
  rootDir: string;
  server: GraphFlowServerCommand;
  idleMs?: number;
}): void {
  if (!poolingEnabled()) return;
  try {
    acquireConnection(input.server, input.rootDir, { pooled: true, idleMs: input.idleMs ?? DEFAULT_IDLE_MS });
  } catch {
    // the next fetch reports the failure
  }
}

/** End every pooled GraphFlow server (graceful stdin close, then tree kill). */
export async function closeGraphFlowClients(): Promise<void> {
  await Promise.all([...connections.values()].map((connection) => closeConnection(connection)));
}

/** Number of live pooled connections (diagnostics and tests). */
export function graphFlowClientCount(): number {
  return [...connections.values()].filter((connection) => !connection.closed).length;
}

export async function fetchGraphFlowContext(input: {
  task: string;
  rootDir: string;
  server: GraphFlowServerCommand;
  timeoutMs?: number;
  /** Reuse one server across calls (default: on unless EFF_GRAPHFLOW_POOL=0). */
  pooled?: boolean;
  idleMs?: number;
}): Promise<GraphFlowContextResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 120_000;
  let connection: GraphFlowConnection;
  try {
    connection = acquireConnection(input.server, input.rootDir, {
      pooled: input.pooled ?? poolingEnabled(),
      idleMs: input.idleMs ?? DEFAULT_IDLE_MS,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
  }
  connection.inflight += 1;
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = undefined;
  setChildRef(connection.transport, true);
  const { client } = connection;
  let timer: NodeJS.Timeout | undefined;
  let failed = false;
  try {
    const call = (async () => {
      await connection.ready;
      return client.callTool(
        {
          name: "graphflow_context",
          arguments: { query: input.task, rootDir: input.rootDir, recordDialogue: false },
        },
        undefined,
        { timeout: timeoutMs }
      );
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`graphflow_context timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = (await Promise.race([call, timeout])) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) {
      return { ok: false, error: `graphflow_context error: ${text.slice(0, 200)}`, durationMs: Date.now() - startedAt };
    }
    // With `mcp.textCopy: "auto"` large responses carry only a stub in text;
    // structuredContent always has the full payload.
    const structured =
      result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
        ? (result.structuredContent as Record<string, unknown>)
        : undefined;
    const payload = (structured ? parseContextPayload(structured) : undefined) ?? parseContextPayload(text);
    if (!payload) {
      return { ok: false, error: "graphflow_context returned an unparseable payload", durationMs: Date.now() - startedAt };
    }
    return { ok: true, context: { ...payload, durationMs: Date.now() - startedAt } };
  } catch (error) {
    // A timed-out or broken server is not reused: the next call starts fresh.
    failed = true;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
    releaseConnection(connection, failed);
  }
}
