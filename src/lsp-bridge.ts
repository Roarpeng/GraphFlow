/**
 * GraphFlow 3.4.1 — Self-written LSP JSON-RPC stdio bridge (`src/lsp-bridge.ts`)
 *
 * This module is the "L2" semantic tier: a dependency-free Language Server Protocol
 * client that can query any stdio language server (pyright/pylsp, gopls, rust-analyzer,
 * clangd, OmniSharp/Roslyn, sourcekit-lsp, ...). It owns the whole lifecycle itself:
 *
 *   spawn -> Content-Length framing both ways -> initialize / initialized handshake ->
 *   didOpen / didChange -> definition / references / hover -> timeout / crash handling ->
 *   kill + await exit (no orphaned language servers, no unhandled rejections).
 *
 * Robustness contract:
 *   - A missing server command (synchronous spawn error) makes `createLspBridge` resolve
 *     `undefined` instead of throwing.
 *   - Request failures/timeouts resolve to `[]` / `undefined` from the public query
 *     methods; only the escape-hatch `request()` rejects (callers there opt in).
 *   - Server->client requests (`workspace/configuration`, `client/registerCapability`,
 *     progress, ...) are answered so servers never hang waiting on the client.
 *   - A crashed server is restarted lazily at most `restartLimit` times (default 1), so a
 *     flapping server can never loop forever.
 *   - Captured stderr is available via `getStderr()` for diagnostics; open documents are
 *     re-opened after a restart.
 *
 * Positions on the public API are LSP-native: `line` and `character` are 0-based.
 * Returned `file` values are absolute paths with forward slashes (non-`file:` URIs are
 * returned verbatim).
 *
 * This is deliberately not a general-purpose LSP client: no workspace/didChangeWatchedFiles,
 * no diagnostics subscription, no semantic tokens. It only implements what the P4 queries
 * need; extend it when a caller needs more.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const STDERR_BUFFER_LIMIT = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10000;
const DEFAULT_RESTART_LIMIT = 1;
const KILL_GRACE_MS = 1500;
const CLIENT_NAME = "graphflow-lsp-bridge";
const CLIENT_VERSION = "1.0.0";

// ── Public types ───────────────────────────────────────────────────────────────────

/** LSP-native position: both fields are 0-based. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Normalized definition/reference location. `line`/`character` are 0-based (LSP-native). */
export interface LspLocation {
  /** Absolute path with forward slashes (or the raw URI for non-file schemes). */
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface LspHover {
  /** Markdown or plain text contents, flattened to a string. */
  contents: string;
  range?: LspRange;
}

export interface LspBridgeOptions {
  /** Server executable, e.g. `gopls`, `pyright-langserver`, `node`. */
  command: string;
  args?: string[];
  /** Working directory used for spawn and for resolving relative document paths. */
  cwd?: string;
  /** Default `textDocument.languageId` for opened documents (e.g. `python`, `go`). */
  languageId?: string;
  /** Workspace root URI (file URI or filesystem path); defaults to `cwd` as a file URI. */
  rootUri?: string;
  /** Per-request timeout in ms (definition/references/hover/raw requests). Default 8000. */
  requestTimeoutMs?: number;
  /** initialize handshake timeout in ms. Default 10000. */
  initializeTimeoutMs?: number;
  /** Maximum lazy restarts after an unexpected crash. Default 1 (0 disables restarts). */
  restartLimit?: number;
  /** Extra environment variables merged over `process.env` (useful for wrappers/CI). */
  env?: Record<string, string>;
  /** Client name reported in `initialize.clientInfo`. */
  clientName?: string;
}

/** A ready-to-use LSP command preset for one language. */
export interface LspCommandPreset {
  command: string;
  args: string[];
  languageId: string;
}

/** Client handle returned by `createLspBridge`. */
export interface LspBridge {
  readonly command: string;
  readonly languageId: string;
  readonly initialized: boolean;
  readonly running: boolean;
  /** Captured stderr tail (bounded). Useful for diagnostics when a server misbehaves. */
  getStderr(): string;
  /**
   * Open a document for the server. Reads it from disk when `content` is omitted.
   * Re-opening an already-open document with new content sends `didChange`.
   * Returns false when the server is unavailable or the file cannot be read.
   */
  openDocument(file: string, content?: string, languageId?: string): Promise<boolean>;
  /** Send a full-text `didChange` (opens the document first when needed). */
  changeDocument(file: string, content: string): Promise<boolean>;
  /** Send `didClose` for a previously opened document. */
  closeDocument(file: string): Promise<void>;
  /** Resolve the definition(s) at an LSP position. Returns `[]` on any failure/timeout. */
  definition(file: string, line: number, character: number): Promise<LspLocation[]>;
  /** Resolve references at an LSP position (declarations included). `[]` on failure. */
  references(file: string, line: number, character: number): Promise<LspLocation[]>;
  /** Hover text at an LSP position, or `undefined` on failure/timeout. */
  hover(file: string, line: number, character: number): Promise<LspHover | undefined>;
  /** Escape hatch: raw JSON-RPC request; rejects on failure (callers opt in). */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  /** Kill the server (and its stdio pipe), awaiting process exit. Idempotent. */
  dispose(): Promise<void>;
}

// ── Command presets + command availability ────────────────────────────────────────

/**
 * Best-effort language server command presets. Nothing here is installed by GraphFlow:
 * callers should try `findAvailableLspPreset()` (which checks PATH) before spawning.
 * `omnisharp`/`csharp-ls` and `pyright-langserver`/`pylsp` are listed as alternatives.
 */
export const LSP_COMMAND_PRESETS: Readonly<Record<string, readonly LspCommandPreset[]>> = {
  python: [
    { command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
    { command: "pylsp", args: [], languageId: "python" },
  ],
  go: [{ command: "gopls", args: [], languageId: "go" }],
  rust: [{ command: "rust-analyzer", args: [], languageId: "rust" }],
  c: [{ command: "clangd", args: ["--background-index"], languageId: "c" }],
  cpp: [{ command: "clangd", args: ["--background-index"], languageId: "cpp" }],
  csharp: [
    { command: "omnisharp", args: ["--languageserver"], languageId: "csharp" },
    { command: "csharp-ls", args: [], languageId: "csharp" },
  ],
  typescript: [
    { command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
  ],
  javascript: [
    { command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ],
};

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  golang: "go",
};

/** All preset variants known for a language id/alias (empty when unknown). */
export function getLspCommandPresets(language: string): readonly LspCommandPreset[] {
  if (typeof language !== "string") return [];
  const key = language.trim().toLowerCase();
  const direct = LSP_COMMAND_PRESETS[key];
  if (direct) return direct;
  const alias = LANGUAGE_ALIASES[key];
  if (!alias) return [];
  return LSP_COMMAND_PRESETS[alias] ?? [];
}

/** First preset whose executable is present on PATH; `undefined` when none is installed. */
export function findAvailableLspPreset(language: string): LspCommandPreset | undefined {
  return getLspCommandPresets(language).find((preset) => isCommandAvailable(preset.command));
}

/**
 * Check whether `command` resolves to an executable file. Self-written PATH/PATHEXT scan
 * (no subprocess): bare names are probed on every PATH entry, while names containing a
 * slash/backslash are resolved directly.
 */
export function isCommandAvailable(command: string): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension.length > 0)
    : [];
  const extension = extname(trimmed).toLowerCase();
  const candidateNames = !isWindows
    ? [trimmed]
    : extensions.includes(extension)
      ? [trimmed]
      : [trimmed, ...extensions.map((knownExtension) => `${trimmed}${knownExtension}`)];

  const candidates: string[] = [];
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    for (const name of candidateNames) {
      try {
        candidates.push(resolve(name));
      } catch {
        // Ignore unusable candidate paths.
      }
    }
  } else {
    const pathDirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
    for (const dir of pathDirs) {
      for (const name of candidateNames) candidates.push(join(dir, name));
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) continue;
      if (!isWindows) accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Not this candidate; keep scanning.
    }
  }
  return false;
}

// ── Normalization helpers ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function uriToFile(uri: string): string {
  if (uri.startsWith("file:")) {
    try {
      return normalizeSlashes(fileURLToPath(uri));
    } catch {
      return uri;
    }
  }
  return uri;
}

function pickRangeObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["range", "targetSelectionRange", "targetRange"]) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
  }
  return undefined;
}

function normalizeLocation(value: unknown): LspLocation | undefined {
  if (!isRecord(value)) return undefined;
  const uri =
    typeof value.uri === "string"
      ? value.uri
      : typeof value.targetUri === "string"
        ? value.targetUri
        : undefined;
  if (!uri) return undefined;
  const range = pickRangeObject(value);
  if (!range) return undefined;
  const start = isRecord(range.start) ? range.start : undefined;
  const end = isRecord(range.end) ? range.end : undefined;
  const startLine = asFiniteNumber(start?.line);
  const startCharacter = asFiniteNumber(start?.character);
  if (startLine === undefined || startCharacter === undefined) return undefined;
  return {
    file: uriToFile(uri),
    line: startLine,
    character: startCharacter,
    endLine: asFiniteNumber(end?.line) ?? startLine,
    endCharacter: asFiniteNumber(end?.character) ?? startCharacter,
  };
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  const items = Array.isArray(result) ? result : [result];
  const locations: LspLocation[] = [];
  for (const item of items) {
    const location = normalizeLocation(item);
    if (location) locations.push(location);
  }
  return locations;
}

function hoverContentsToString(contents: unknown): string | undefined {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    const parts = contents
      .map((part) => hoverContentsToString(part))
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (isRecord(contents) && typeof contents.value === "string") return contents.value;
  return undefined;
}

function normalizeHover(result: unknown): LspHover | undefined {
  if (!isRecord(result)) return undefined;
  const contents = hoverContentsToString(result.contents);
  if (contents === undefined || contents.length === 0) return undefined;
  const rangeObject = isRecord(result.range) ? result.range : undefined;
  if (!rangeObject) return { contents };
  const start = isRecord(rangeObject.start) ? rangeObject.start : undefined;
  const end = isRecord(rangeObject.end) ? rangeObject.end : undefined;
  const startLine = asFiniteNumber(start?.line);
  const startCharacter = asFiniteNumber(start?.character);
  const endLine = asFiniteNumber(end?.line);
  const endCharacter = asFiniteNumber(end?.character);
  if (
    startLine === undefined ||
    startCharacter === undefined ||
    endLine === undefined ||
    endCharacter === undefined
  ) {
    return { contents };
  }
  return {
    contents,
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
  };
}

function resolveDocumentPath(file: string, cwd: string): string | undefined {
  if (typeof file !== "string" || file.length === 0) return undefined;
  try {
    return resolve(isAbsolute(file) ? file : join(cwd, file));
  } catch {
    return undefined;
  }
}

// ── Process helpers ──────────────────────────────────────────────────────────────

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (child.pid !== undefined) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      child.off("spawn", onSpawn);
      child.off("error", onError);
      resolvePromise(ok);
    };
    const onSpawn = (): void => finish(true);
    const onError = (): void => finish(false);
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish();
    }, timeoutMs);
    child.once("exit", finish);
    try {
      child.kill();
    } catch {
      finish();
    }
  });
}

// ── Bridge implementation ────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface OpenedDocument {
  languageId: string;
  version: number;
  text: string;
}

class JsonRpcLspBridge implements LspBridge {
  readonly command: string;
  readonly languageId: string;

  private readonly args: readonly string[];
  private readonly cwd: string;
  private readonly rootUri: string;
  private readonly requestTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly restartLimit: number;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly clientName: string;

  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private stderrText = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openedDocuments = new Map<string, OpenedDocument>();
  private nextRequestId = 1;
  private initializedFlag = false;
  private runningFlag = false;
  private disposedFlag = false;
  private startPromise: Promise<boolean> | undefined;
  private restartsUsed = 0;

  constructor(options: LspBridgeOptions) {
    this.command = options.command;
    this.args = [...(options.args ?? [])];
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.languageId = options.languageId ?? "plaintext";
    this.rootUri = normalizeRootUri(options.rootUri, this.cwd);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.restartLimit = Math.max(0, options.restartLimit ?? DEFAULT_RESTART_LIMIT);
    this.extraEnv = options.env;
    this.clientName = options.clientName ?? CLIENT_NAME;
  }

  get initialized(): boolean {
    return this.initializedFlag;
  }

  get running(): boolean {
    return this.runningFlag;
  }

  getStderr(): string {
    return this.stderrText;
  }

  /**
   * Spawn + handshake. Public only so the module-level factory can drive the initial
   * start without counting it as a restart; not part of the exported `LspBridge` surface.
   */
  async start(): Promise<boolean> {
    if (this.disposedFlag) return false;
    this.initializedFlag = false;
    this.runningFlag = false;
    this.stdoutBuffer = Buffer.alloc(0);
    try {
      const child = spawn(this.command, [...this.args], {
        cwd: this.cwd,
        env: { ...process.env, ...(this.extraEnv ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      // Permanent handlers are attached before the spawn wait so an early 'error'
      // (e.g. ENOENT) can never become an unhandled EventEmitter error.
      child.on("error", (error: Error) => {
        if (this.child === child) this.onProcessFailure(error);
      });
      child.on("exit", (code, signal) => {
        if (this.child === child) this.onProcessExit(code, signal);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.child === child) this.onStdout(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (this.child === child) this.appendStderr(chunk);
      });
      // EPIPE from a dying server must not crash the host process.
      child.stdin.on("error", () => {
        // Intentionally ignored: write failures are reported by the pending request logic.
      });

      const spawned = await waitForSpawn(child);
      if (!spawned || this.disposedFlag) {
        this.forceKill();
        return false;
      }
      this.runningFlag = true;

      const initializeResult = await this.sendRequestInternal(
        "initialize",
        this.buildInitializeParams(),
        this.initializeTimeoutMs
      );
      if (!isRecord(initializeResult)) {
        this.forceKill();
        return false;
      }
      this.initializedFlag = true;
      this.sendNotification("initialized", {});
      this.reopenDocuments();
      return true;
    } catch {
      this.forceKill();
      return false;
    }
  }

  async openDocument(file: string, content?: string, languageId?: string): Promise<boolean> {
    if (this.disposedFlag) return false;
    if (!(await this.ensureRunning())) return false;
    const absolute = resolveDocumentPath(file, this.cwd);
    if (!absolute) return false;
    let text = content;
    if (text === undefined) {
      try {
        text = readFileSync(absolute, "utf8");
      } catch {
        return false;
      }
    }
    const language = languageId ?? this.languageId;
    const uri = pathToFileURL(absolute).href;
    const existing = this.openedDocuments.get(absolute);
    if (existing) {
      if (existing.text === text) return true;
      const version = existing.version + 1;
      this.openedDocuments.set(absolute, { languageId: language, version, text });
      return this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    const version = 1;
    this.openedDocuments.set(absolute, { languageId: language, version, text });
    return this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: language, version, text },
    });
  }

  async changeDocument(file: string, content: string): Promise<boolean> {
    if (this.disposedFlag) return false;
    if (!(await this.ensureRunning())) return false;
    const absolute = resolveDocumentPath(file, this.cwd);
    if (!absolute) return false;
    const existing = this.openedDocuments.get(absolute);
    if (!existing) return this.openDocument(absolute, content);
    const version = existing.version + 1;
    this.openedDocuments.set(absolute, { languageId: existing.languageId, version, text: content });
    return this.sendNotification("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(absolute).href, version },
      contentChanges: [{ text: content }],
    });
  }

  async closeDocument(file: string): Promise<void> {
    if (this.disposedFlag) return;
    const absolute = resolveDocumentPath(file, this.cwd);
    if (!absolute) return;
    if (!this.openedDocuments.delete(absolute)) return;
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri: pathToFileURL(absolute).href },
    });
  }

  async definition(file: string, line: number, character: number): Promise<LspLocation[]> {
    const absolute = await this.ensureDocument(file);
    if (!absolute) return [];
    try {
      const result = await this.sendRequestInternal(
        "textDocument/definition",
        {
          textDocument: { uri: pathToFileURL(absolute).href },
          position: { line, character },
        },
        this.requestTimeoutMs
      );
      return normalizeLocations(result);
    } catch {
      return [];
    }
  }

  async references(file: string, line: number, character: number): Promise<LspLocation[]> {
    const absolute = await this.ensureDocument(file);
    if (!absolute) return [];
    try {
      const result = await this.sendRequestInternal(
        "textDocument/references",
        {
          textDocument: { uri: pathToFileURL(absolute).href },
          position: { line, character },
          context: { includeDeclaration: true },
        },
        this.requestTimeoutMs
      );
      return normalizeLocations(result);
    } catch {
      return [];
    }
  }

  async hover(file: string, line: number, character: number): Promise<LspHover | undefined> {
    const absolute = await this.ensureDocument(file);
    if (!absolute) return undefined;
    try {
      const result = await this.sendRequestInternal(
        "textDocument/hover",
        {
          textDocument: { uri: pathToFileURL(absolute).href },
          position: { line, character },
        },
        this.requestTimeoutMs
      );
      return normalizeHover(result);
    } catch {
      return undefined;
    }
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!(await this.ensureRunning())) {
      throw new Error("LSP bridge is not running");
    }
    return this.sendRequestInternal(method, params, timeoutMs ?? this.requestTimeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    this.initializedFlag = false;
    this.runningFlag = false;
    this.rejectPending(new Error("LSP bridge disposed"));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // Pipe already closed.
    }
    try {
      child.kill();
    } catch {
      // Already dead (kill() returns false on Windows for a dead PID).
    }
    await waitForExit(child, KILL_GRACE_MS);
  }

  // ── lifecycle internals ────────────────────────────────────────────────────────

  private ensureRunning(): Promise<boolean> {
    if (this.disposedFlag) return Promise.resolve(false);
    if (this.runningFlag && this.initializedFlag) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    if (this.restartsUsed >= this.restartLimit) return Promise.resolve(false);
    this.restartsUsed += 1;
    this.startPromise = this.start()
      .then((ok) => {
        this.startPromise = undefined;
        return ok;
      })
      .catch(() => {
        this.startPromise = undefined;
        return false;
      });
    return this.startPromise;
  }

  private async ensureDocument(file: string): Promise<string | undefined> {
    const absolute = resolveDocumentPath(file, this.cwd);
    if (!absolute) return undefined;
    if (!this.openedDocuments.has(absolute)) {
      const opened = await this.openDocument(absolute);
      if (!opened) return undefined;
    }
    if (!(await this.ensureRunning())) return undefined;
    return absolute;
  }

  private onProcessFailure(error: Error): void {
    this.runningFlag = false;
    this.initializedFlag = false;
    this.rejectPending(new Error(`LSP server failed: ${error.message}`));
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.runningFlag = false;
    this.initializedFlag = false;
    if (this.child) this.child = undefined;
    const reason = code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`;
    this.rejectPending(new Error(`LSP server process exited (${reason})`));
  }

  private forceKill(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // Pipe already closed.
    }
    try {
      child.kill();
    } catch {
      // Already dead.
    }
  }

  private rejectPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrText = (this.stderrText + chunk.toString("utf8")).slice(-STDERR_BUFFER_LIMIT);
  }

  private buildInitializeParams(): Record<string, unknown> {
    return {
      processId: process.pid,
      clientInfo: { name: this.clientName, version: CLIENT_VERSION },
      locale: "en",
      rootPath: this.cwd,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: false,
            willSave: false,
            willSaveWaitUntil: false,
          },
          definition: { linkSupport: true, dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: {
            contentFormat: ["markdown", "plaintext"],
            dynamicRegistration: false,
          },
          publishDiagnostics: { relatedInformation: false, versionSupport: false },
        },
        window: {
          workDoneProgress: false,
          showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
        },
        general: { positionEncodings: ["utf-16"] },
      },
      initializationOptions: {},
    };
  }

  private reopenDocuments(): void {
    for (const [absolute, document] of this.openedDocuments) {
      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(absolute).href,
          languageId: document.languageId,
          version: document.version,
          text: document.text,
        },
      });
    }
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────────────

  private sendRequestInternal(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.disposedFlag || !this.child || !this.runningFlag) {
      return Promise.reject(new Error("LSP server is not running"));
    }
    const id = this.nextRequestId++;
    const timeout = Math.max(1, timeoutMs);
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.writeMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        rejectPromise(new Error(`LSP request '${method}' timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      if (!this.writeMessage(message)) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectPromise(new Error(`LSP request '${method}' could not be written (server not writable)`));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): boolean {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    return this.writeMessage(message);
  }

  private writeMessage(message: Record<string, unknown>): boolean {
    const child = this.child;
    if (this.disposedFlag || !child || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      const payload = Buffer.from(JSON.stringify(message), "utf8");
      const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
      child.stdin.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      return false;
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.disposedFlag) return;
    this.stdoutBuffer =
      this.stdoutBuffer.length === 0 ? chunk : Buffer.concat([this.stdoutBuffer, chunk]);
    this.drainMessages();
  }

  private drainMessages(): void {
    for (;;) {
      const headerEnd = this.stdoutBuffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) return;
      const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      const length = lengthMatch?.[1] !== undefined ? Number.parseInt(lengthMatch[1], 10) : Number.NaN;
      if (!Number.isFinite(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        // Malformed header: drop it and resync instead of wedging the transport.
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }
      const messageStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.stdoutBuffer.length < messageStart + length) return;
      const body = this.stdoutBuffer.subarray(messageStart, messageStart + length).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(messageStart + length);
      this.handleMessage(body);
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const rawId = parsed.id;
    const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined;

    if (method !== undefined) {
      if (id !== undefined) {
        this.respondToServerRequest(method, id, parsed.params);
      }
      // Server notifications (diagnostics/logs/progress) are intentionally ignored.
      return;
    }
    if (typeof id === "number") {
      this.handleResponse(id, parsed);
    }
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message.error;
    if (isRecord(error) && typeof error.message === "string") {
      pending.reject(new Error(`LSP request failed: ${error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  private respondToServerRequest(method: string, id: number | string, params: unknown): void {
    switch (method) {
      case "workspace/configuration": {
        const items =
          isRecord(params) && Array.isArray(params.items) ? params.items : [];
        this.writeMessage({ jsonrpc: "2.0", id, result: items.map(() => null) });
        return;
      }
      case "workspace/workspaceFolders":
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          result: [{ uri: this.rootUri, name: "workspace" }],
        });
        return;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        this.writeMessage({ jsonrpc: "2.0", id, result: null });
        return;
      case "workspace/applyEdit":
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          result: { applied: false, failureReason: "graphflow-lsp-bridge is read-only" },
        });
        return;
      default:
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unsupported client request: ${method}` },
        });
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────────

function normalizeRootUri(rootUri: string | undefined, cwd: string): string {
  if (rootUri === undefined || rootUri.length === 0) return pathToFileURL(cwd).href;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rootUri)) return rootUri; // Already a URI.
  try {
    return pathToFileURL(resolve(rootUri)).href;
  } catch {
    return pathToFileURL(cwd).href;
  }
}

/**
 * Start a language server and complete the `initialize`/`initialized` handshake.
 * Resolves `undefined` when the command cannot be spawned, the handshake fails, or the
 * initialize handshake times out — absent servers are a normal, non-fatal condition.
 */
export async function createLspBridge(options: LspBridgeOptions): Promise<LspBridge | undefined> {
  if (!options || typeof options.command !== "string" || options.command.trim().length === 0) {
    return undefined;
  }
  const bridge = new JsonRpcLspBridge(options);
  const started = await bridge.start();
  if (!started) {
    await bridge.dispose();
    return undefined;
  }
  return bridge;
}
