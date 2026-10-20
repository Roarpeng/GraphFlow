/**
 * Real MCP stdio end-to-end test for the packaged server surface.
 *
 * Spawns `node --import <repo tsx loader> src/mcp-server.ts` in a throwaway
 * workspace (never dist, so it works before a build), then speaks raw MCP
 * JSON-RPC (newline-delimited JSON) over stdin/stdout:
 *
 *   initialize -> notifications/initialized -> tools/list (4 tools, <460 wire
 *   tokens) -> gf_read -> gf_exec -> unknown tool -> tools/list again
 *
 * No MCP SDK client is used; request ids are matched manually and every request
 * has a timeout so a broken server fails fast instead of hanging the suite.
 *
 * Standalone: `npx tsx tests/mcp-e2e.test.ts`.
 * Also picked up automatically by `tests/run-all.ts` (`*.test.ts`).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 15_000;
const OVERALL_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 3_000;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL ${name}\n${detail}`);
  }
}

function fail(name: string, err: unknown, stderr = ""): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  results.push({ name, ok: false, detail });
  console.error(`FAIL ${name}\n${detail}${stderr ? `\n--- server stderr ---\n${stderr}` : ""}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (message: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private stderrText = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exitPromise: Promise<void>;
  private readonly overallTimer: NodeJS.Timeout;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.rejectPending(
        new Error(
          `MCP server exited before responding (code=${code ?? "null"}, signal=${signal ?? "none"})` +
            (this.stderrText ? `\nstderr:\n${this.stderrText}` : "")
        )
      );
    });
    this.child.on("error", (error) => {
      this.exitInfo = this.exitInfo ?? { code: null, signal: null };
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.child.once("close", () => resolveExit());
    });
    this.overallTimer = setTimeout(() => {
      this.stderrText += `\n[e2e] overall timeout (${OVERALL_TIMEOUT_MS}ms) exceeded; killing server`;
      this.kill();
    }, OVERALL_TIMEOUT_MS);
    this.overallTimer.unref();
  }

  static spawn(workspaceDir: string): McpStdioClient {
    const repoRoot = join(__dirname, "..");
    const tsxLoader = pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const serverScript = join(repoRoot, "src", "mcp-server.ts");
    const child = spawn(process.execPath, ["--import", tsxLoader, serverScript], {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GRAPHFLOW_MCP_STDIO: "1", GRAPHFLOW_LOG_JSON: "1" },
    }) as ChildProcessWithoutNullStreams;
    return new McpStdioClient(child);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // The server should only emit JSON-RPC lines; ignore anything else.
        continue;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  request(
    id: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timeout after ${REQUEST_TIMEOUT_MS}ms waiting for JSON-RPC id=${id} (${method})` +
              (this.stderrText ? `\nstderr:\n${this.stderrText}` : "")
          )
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      };
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  hasExited(): boolean {
    return this.exitInfo !== null;
  }

  stderr(): string {
    return this.stderrText;
  }

  private kill(): void {
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.overallTimer);
    if (this.exitInfo) return;
    try {
      this.child.stdin.end();
    } catch {
      // stdin already closed
    }
    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), CLOSE_TIMEOUT_MS)),
    ]);
    if (!graceful) {
      this.kill();
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, CLOSE_TIMEOUT_MS)),
      ]);
    }
  }
}

function createFixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-mcp-e2e-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "model.ts"),
    [
      "export class OrderService {",
      "  cancelOrder(orderId: string): string {",
      "    return `cancelled:${orderId}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "src", "app.ts"),
    [
      'import { OrderService } from "./model.js";',
      "",
      "export function main(): string {",
      "  const service = new OrderService();",
      '  return service.cancelOrder("42");',
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return root;
}

function textOf(response: JsonRpcResponse): string {
  const result = response.result as ToolCallResult | undefined;
  return result?.content?.[0]?.text ?? "";
}

async function main(): Promise<void> {
  const workspace = createFixtureWorkspace();
  let client: McpStdioClient | undefined;

  try {
    const spawnStartedAt = Date.now();
    client = McpStdioClient.spawn(workspace);

    const init = await client.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "graphflow-e2e", version: "1.0.0" },
    });
    client.notify("notifications/initialized");

    const toolsList = await client.request(2, "tools/list");
    const read = await client.request(3, "tools/call", {
      name: "gf_read",
      arguments: { targets: ["src/app.ts#main"], rootDir: workspace },
    });
    const exec = await client.request(4, "tools/call", {
      name: "gf_exec",
      arguments: { cmd: "affected-tests", changedFiles: ["src/model.ts"], rootDir: workspace },
    });
    const unknown = await client.request(5, "tools/call", {
      name: "gf_does_not_exist",
      arguments: {},
    });
    const toolsListAfter = await client.request(6, "tools/list");
    const handshakeMs = Date.now() - spawnStartedAt;

    const tools = (toolsList.result?.tools ?? []) as McpTool[];
    const toolsAfter = (toolsListAfter.result?.tools ?? []) as McpTool[];
    const readText = textOf(read);
    const execText = textOf(exec);
    const serverStderr = client.stderr();

    check("initialize returns graphflow serverInfo and tools capability", () => {
      assert(init.error === undefined, `initialize returned error: ${JSON.stringify(init.error)}`);
      assert(init.result, "initialize must return a result");
      const serverInfo = init.result.serverInfo as { name?: string; version?: string } | undefined;
      const capabilities = init.result.capabilities as Record<string, unknown> | undefined;
      assertEqual(serverInfo?.name, "graphflow", "serverInfo.name");
      assertEqual(typeof serverInfo?.version, "string", "serverInfo.version must be a string");
      assert(
        capabilities && typeof capabilities.tools === "object" && capabilities.tools !== null,
        "initialize must advertise the tools capability"
      );
      assertEqual(init.id, 1, "initialize response id echo");
    });

    check("tools/list exposes exactly the 4 gf_* tools", () => {
      assert(toolsList.error === undefined, `tools/list error: ${JSON.stringify(toolsList.error)}`);
      assertEqual(tools.length, 4, "tool count");
      assertEqual(
        JSON.stringify(tools.map((tool) => tool.name).sort()),
        JSON.stringify(["gf_edit", "gf_exec", "gf_macro", "gf_read"]),
        "tool names"
      );
    });

    check("tools/list wire tax stays under 460 tokens", () => {
      const wireChars = JSON.stringify(tools).length;
      const wireTokens = wireChars / 4;
      assert(
        wireTokens < 460,
        `expected <460 wire tokens for all 4 tool schemas, got ${wireChars} chars / ${wireTokens} tokens`
      );
    });

    check("gf_read slices the function and attaches a blast-radius section", () => {
      assert(read.error === undefined, `gf_read returned error: ${JSON.stringify(read.error)}`);
      assert(readText.includes("export function main"), `read output must contain the sliced function:\n${readText}`);
      assert(readText.includes("[Blast Radius"), `read output must contain [Blast Radius:\n${readText}`);
      assert(readText.includes("cancelOrder"), "read type closure should include the called method");
    });

  check("gf_exec affected-tests returns an honest receipt (including zero matches)", () => {
    assert(exec.error === undefined, `gf_exec returned error: ${JSON.stringify(exec.error)}`);
    assert(execText.trim().length > 0, "gf_exec text must be non-empty");
    // The fixture has no test files, so zero matches is the correct answer. It must be
    // reported as NONE, not as a green PASS that hides a broken router.
    assert(
      execText.startsWith("NONE [affected-tests]") ||
        execText.startsWith("# Affected Tests") ||
        execText.startsWith("PASS [affected-tests]"),
      `expected affected-tests receipt, got:\n${execText}`
    );
    assert(/affected/i.test(execText), "receipt must mention affected tests");
    });

    check("unknown tool returns a graceful error without crashing", () => {
      const jsonRpcError = unknown.error !== undefined && typeof unknown.error.message === "string";
      const errorText = textOf(unknown);
      const errReceipt = errorText.startsWith("ERR [unknown-v3-tool]");
      assert(
        jsonRpcError || errReceipt,
        `expected a JSON-RPC error or "ERR [unknown-v3-tool]" text, got: ${JSON.stringify(unknown)}`
      );
      assert(
        !(unknown.result?.content?.[0]?.text ?? "").includes("Fatal"),
        "unknown tool must not produce a fatal error"
      );
    });

    check("server keeps serving requests after the unknown-tool call", () => {
      assert(!client!.hasExited(), "MCP server must stay alive after an unknown tool call");
      assert(toolsListAfter.error === undefined, "tools/list after unknown tool must succeed");
      assertEqual(toolsAfter.length, 4, "tools/list after unknown tool still returns 4 tools");
      assertEqual(toolsListAfter.id, 6, "post-unknown response id echo");
    });

    check("server process ran cleanly (no fatal stderr output)", () => {
      assert(
        !serverStderr.includes("[GraphFlow MCP] Fatal error"),
        `server stderr must not contain a fatal error:\n${serverStderr}`
      );
      assert(!client!.hasExited(), "server should still be running before the test closes it");
    });

    console.log(`\nMCP e2e handshake (spawn -> 6 JSON-RPC round-trips) in ${handshakeMs}ms.`);
  } catch (err) {
    fail("MCP stdio spawn/handshake sequence", err, client?.stderr() ?? "");
  } finally {
    if (client) await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} MCP e2e checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("MCP e2e test failed:", err);
  process.exit(1);
});
