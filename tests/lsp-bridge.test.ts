/**
 * Self-written LSP bridge — tests for `src/lsp-bridge.ts`.
 *
 * Every check drives a tiny fake language server (a plain Node `.cjs` script written into
 * a temp dir) that speaks Content-Length framed JSON-RPC over stdio. It intentionally
 * exercises the hard parts of a hand-written client: header/body framing, the
 * initialize/initialized handshake, server->client requests that must be answered,
 * didOpen/didChange notifications, graceful request timeouts, crash-restart (bounded) and
 * child-process cleanup on dispose.
 *
 * Run: npx tsx tests/lsp-bridge.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LSP_COMMAND_PRESETS,
  createLspBridge,
  findAvailableLspPreset,
  getLspCommandPresets,
  isCommandAvailable,
  type LspBridge,
} from "../src/lsp-bridge.js";

// The fake server is a plain CommonJS script: it must not depend on the repo, tsx or any
// installed package. It writes markers/PID to files so the test can prove side effects.
const FAKE_LSP_SERVER_SOURCE = [
  '"use strict";',
  'const fs = require("fs");',
  'const path = require("path");',
  'const { pathToFileURL } = require("url");',
  "",
  'const target = process.env.FAKE_LSP_TARGET || __filename;',
  'const markerFile = process.env.FAKE_LSP_MARKER || "";',
  'const pidFile = process.env.FAKE_LSP_PIDFILE || "";',
  'const stateFile = process.env.FAKE_LSP_STATEFILE || "";',
  'const hangDefinition = process.env.FAKE_LSP_HANG_DEFINITION === "1";',
  'const hangInitialize = process.env.FAKE_LSP_HANG_INITIALIZE === "1";',
  'const crashOnce = process.env.FAKE_LSP_CRASH_ONCE === "1";',
  "",
  "if (pidFile) {",
  "  try { fs.writeFileSync(pidFile, String(process.pid)); } catch (err) { /* ignore */ }",
  "}",
  "function mark(event) {",
  "  if (!markerFile) return;",
  '  try { fs.appendFileSync(markerFile, event + "\\n"); } catch (err) { /* ignore */ }',
  "}",
  'mark("start:" + process.pid);',
  'process.stderr.write("[fake-lsp] started pid=" + process.pid + "\\n");',
  "",
  "let pendingDefinitionId = null;",
  "",
  "function send(message) {",
  "  const json = JSON.stringify(message);",
  '  const payload = Buffer.from(json, "utf8");',
  '  process.stdout.write("Content-Length: " + payload.length + "\\r\\n\\r\\n");',
  "  process.stdout.write(payload);",
  "}",
  "",
  "function handleMessage(message) {",
  "  const method = message.method;",
  "  const id = message.id;",
  "  if (method === undefined && id !== undefined) {",
  "    if (id === 9001 && pendingDefinitionId !== null) {",
  "      const definitionId = pendingDefinitionId;",
  "      pendingDefinitionId = null;",
  "      send({",
  '        jsonrpc: "2.0",',
  "        id: definitionId,",
  "        result: {",
  "          uri: pathToFileURL(target).href,",
  "          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },",
  "        },",
  "      });",
  "    }",
  "    return;",
  "  }",
  '  if (method === "initialize") {',
  '    mark("initialize");',
  "    if (hangInitialize) return;",
  '    send({ jsonrpc: "2.0", id: id, result: { capabilities: {',
  "      textDocumentSync: 1, definitionProvider: true, referencesProvider: true, hoverProvider: true,",
  "    } } });",
  "    return;",
  "  }",
  '  if (method === "initialized") { mark("initialized"); return; }',
  '  if (method === "textDocument/didOpen") { mark("didOpen:" + message.params.textDocument.uri); return; }',
  '  if (method === "textDocument/didChange") { mark("didChange"); return; }',
  '  if (method === "textDocument/didClose") { mark("didClose"); return; }',
  '  if (method === "textDocument/definition") {',
  '    mark("definition");',
  "    if (hangDefinition) return;",
  "    if (crashOnce && stateFile && !fs.existsSync(stateFile)) {",
  '      try { fs.writeFileSync(stateFile, "1"); } catch (err) { /* ignore */ }',
  "      process.exit(7);",
  "    }",
  "    pendingDefinitionId = id;",
  '    send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{}] } });',
  "    return;",
  "  }",
  '  if (method === "textDocument/references") {',
  '    send({ jsonrpc: "2.0", id: id, result: [',
  "      { uri: pathToFileURL(target).href, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } },",
  "      { uri: pathToFileURL(path.join(path.dirname(target), \"other.ts\")).href, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },",
  "    ] });",
  "    return;",
  "  }",
  '  if (method === "textDocument/hover") {',
  '    send({ jsonrpc: "2.0", id: id, result: {',
  "      contents: { kind: \"markdown\", value: \"**hover** ok\" },",
  "      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },",
  "    } });",
  "    return;",
  "  }",
  '  if (method === "workspace/symbol") {',
  '    send({ jsonrpc: "2.0", id: id, result: [] });',
  "    return;",
  "  }",
  '  if (method === "shutdown") { send({ jsonrpc: "2.0", id: id, result: null }); return; }',
  '  if (method === "exit") { process.exit(0); }',
  "}",
  "",
  "let buffer = Buffer.alloc(0);",
  'process.stdin.on("data", function (chunk) {',
  "  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);",
  "  for (;;) {",
  '    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");',
  "    if (headerEnd < 0) return;",
  '    const headerText = buffer.subarray(0, headerEnd).toString("ascii");',
  "    const lengthMatch = /Content-Length:\\s*(\\d+)/i.exec(headerText);",
  "    if (!lengthMatch) { buffer = buffer.subarray(headerEnd + 4); continue; }",
  "    const length = Number(lengthMatch[1]);",
  "    const start = headerEnd + 4;",
  "    if (buffer.length < start + length) return;",
  '    const body = buffer.subarray(start, start + length).toString("utf8");',
  "    buffer = buffer.subarray(start + length);",
  "    try { handleMessage(JSON.parse(body)); } catch (err) { /* ignore */ }",
  "  }",
  "});",
  'process.stdin.on("end", function () { process.exit(0); });',
  "",
].join("\n");

interface FakeProject {
  root: string;
  serverPath: string;
  targetPath: string;
  markerPath: string;
  pidPath: string;
  statePath: string;
}

function makeProject(): FakeProject {
  const root = mkdtempSync(join(tmpdir(), "gf-lsp-bridge-"));
  const serverPath = join(root, "fake-lsp.cjs");
  writeFileSync(serverPath, FAKE_LSP_SERVER_SOURCE, "utf8");
  const targetPath = join(root, "target.ts");
  writeFileSync(targetPath, "export const value = 1;\n", "utf8");
  return {
    root,
    serverPath,
    targetPath,
    markerPath: join(root, "events.log"),
    pidPath: join(root, "server.pid"),
    statePath: join(root, "crash-state"),
  };
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "gf-lsp-bridge-root-"));
}

function baseEnv(project: FakeProject): Record<string, string> {
  return {
    FAKE_LSP_TARGET: project.targetPath,
    FAKE_LSP_MARKER: project.markerPath,
    FAKE_LSP_PIDFILE: project.pidPath,
    FAKE_LSP_STATEFILE: project.statePath,
  };
}

function spawnOptions(
  project: FakeProject,
  env: Record<string, string>,
  options?: { requestTimeoutMs?: number; initializeTimeoutMs?: number; restartLimit?: number }
): Parameters<typeof createLspBridge>[0] {
  return {
    command: process.execPath,
    args: [project.serverPath],
    cwd: project.root,
    languageId: "typescript",
    env: { ...baseEnv(project), ...env },
    requestTimeoutMs: options?.requestTimeoutMs ?? 4000,
    initializeTimeoutMs: options?.initializeTimeoutMs ?? 5000,
    restartLimit: options?.restartLimit ?? 1,
  };
}

function readMarker(project: FakeProject): string {
  try {
    return readFileSync(project.markerPath, "utf8");
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await sleep(25);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

async function main(): Promise<void> {
  await check("tooling: presets cover 6 families and isCommandAvailable scans PATH", async () => {
    assert.equal(isCommandAvailable(process.execPath), true, "the running node executable must be found");
    assert.equal(isCommandAvailable("graphflow-definitely-missing-lsp-cmd-xyz"), false);
    assert.equal(isCommandAvailable(""), false);
    for (const language of ["python", "go", "rust", "c", "cpp", "csharp", "typescript", "javascript"]) {
      assert.ok(
        (LSP_COMMAND_PRESETS[language] ?? []).length > 0,
        `expected presets for ${language}`
      );
    }
    const python = getLspCommandPresets("python");
    assert.equal(python.length, 2);
    assert.equal(python[0]?.command, "pyright-langserver");
    assert.equal(python[1]?.command, "pylsp");
    assert.equal(getLspCommandPresets("py")[0]?.languageId, "python");
    assert.equal(getLspCommandPresets("c++")[0]?.command, "clangd");
    assert.equal(getLspCommandPresets("not-a-language").length, 0);
    assert.equal(findAvailableLspPreset("not-a-language"), undefined);
    const available = findAvailableLspPreset("python");
    assert.ok(
      available === undefined || typeof available.command === "string",
      "findAvailableLspPreset must return a preset or undefined"
    );
  });

  await check("a missing server command resolves undefined with no unhandled rejection", async () => {
    const root = makeRoot();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const bridge = await createLspBridge({
        command: "graphflow-definitely-missing-lsp-cmd-xyz",
        cwd: root,
        requestTimeoutMs: 300,
      });
      assert.equal(bridge, undefined, "absent server must resolve undefined");
      await sleep(100);
      assert.deepEqual(unhandled, [], "no unhandled rejection may escape");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      rmSync(root, { recursive: true, force: true });
    }
  });

  await check("handshake, didOpen/didChange, definition, references and hover work", async () => {
    const project = makeProject();
    const bridge = await createLspBridge(spawnOptions(project, {}));
    try {
      assert.ok(bridge, "bridge must start against the fake server");
      assert.equal(bridge?.initialized, true, "initialize handshake must complete");
      assert.equal(bridge?.running, true);

      assert.equal(await bridge?.openDocument(project.targetPath), true, "openDocument must succeed");
      assert.equal(
        await waitFor(() => readMarker(project).includes("didOpen:"), 2000),
        true,
        `didOpen notification must reach the server, marker=${readMarker(project)}`
      );
      assert.equal(readMarker(project).includes("initialize"), true, "initialize marker");
      assert.equal(await waitFor(() => readMarker(project).includes("initialized"), 2000), true);

      assert.equal(
        await bridge?.changeDocument(project.targetPath, "export const value = 2;\n"),
        true,
        "changeDocument must succeed"
      );
      assert.equal(
        await waitFor(() => readMarker(project).includes("didChange"), 2000),
        true,
        "didChange notification must reach the server"
      );

      const definitions = await bridge!.definition(project.targetPath, 1, 4);
      assert.equal(definitions.length, 1, `expected 1 definition, got ${definitions.length}`);
      assert.ok(definitions[0]?.file.endsWith("target.ts"), `definition file: ${definitions[0]?.file}`);
      assert.equal(definitions[0]?.line, 2);
      assert.equal(definitions[0]?.character, 4);
      assert.equal(definitions[0]?.endLine, 2);
      assert.equal(definitions[0]?.endCharacter, 9);

      const references = await bridge!.references(project.targetPath, 1, 4);
      assert.equal(references.length, 2, "references must normalize both locations");
      assert.ok(references.some((location) => location.file.endsWith("target.ts")));
      assert.ok(references.some((location) => location.file.endsWith("other.ts")));

      const hover = await bridge!.hover(project.targetPath, 1, 4);
      assert.equal(hover?.contents, "**hover** ok");
      assert.equal(hover?.range?.start.line, 1);
      assert.equal(hover?.range?.end.character, 3);

      const rawSymbols = await bridge!.request("workspace/symbol", { query: "value" });
      assert.deepEqual(rawSymbols, [], "raw request escape hatch must round-trip");

      assert.equal(
        await waitFor(() => bridge!.getStderr().includes("[fake-lsp] started"), 2000),
        true,
        `stderr must be captured, got: ${bridge!.getStderr()}`
      );

      await bridge!.closeDocument(project.targetPath);
      assert.equal(
        await waitFor(() => readMarker(project).includes("didClose"), 2000),
        true,
        "didClose notification must reach the server"
      );
    } finally {
      await bridge?.dispose();
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  await check("request timeouts resolve gracefully and the bridge stays usable", async () => {
    const project = makeProject();
    const bridge = await createLspBridge(
      spawnOptions(project, { FAKE_LSP_HANG_DEFINITION: "1" }, { requestTimeoutMs: 350 })
    );
    try {
      assert.ok(bridge, "bridge must start");
      const startedAt = Date.now();
      const definitions = await bridge!.definition(project.targetPath, 1, 4);
      const elapsed = Date.now() - startedAt;
      assert.deepEqual(definitions, [], "timed-out definition must resolve []");
      assert.ok(elapsed >= 250, `expected a real timeout wait, got ${elapsed}ms`);
      assert.ok(elapsed < 5000, `timeout must stay bounded, got ${elapsed}ms`);
      const hover = await bridge!.hover(project.targetPath, 1, 4);
      assert.equal(hover?.contents, "**hover** ok", "the bridge must stay usable after a timeout");
      assert.equal(bridge!.running, true, "bridge must remain running after a timeout");
    } finally {
      await bridge?.dispose();
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  await check("a crashed server is restarted once and recovers", async () => {
    const project = makeProject();
    const bridge = await createLspBridge(
      spawnOptions(project, { FAKE_LSP_CRASH_ONCE: "1" }, { requestTimeoutMs: 4000, restartLimit: 1 })
    );
    try {
      assert.ok(bridge, "bridge must start");
      const first = await bridge!.definition(project.targetPath, 1, 4);
      assert.deepEqual(first, [], "definition against a crashing server must degrade to []");
      assert.equal(bridge!.running, false, "crashed server must be marked not running");

      const second = await bridge!.definition(project.targetPath, 1, 4);
      assert.equal(second.length, 1, "definition after the bounded restart must succeed");
      assert.equal(bridge!.running, true, "bridge must be running again after restart");
      const starts = readMarker(project)
        .split("\n")
        .filter((line) => line.startsWith("start:")).length;
      assert.ok(starts >= 2, `expected a restart, saw ${starts} server starts`);
    } finally {
      await bridge?.dispose();
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  await check("dispose kills the language server process (no orphans)", async () => {
    const project = makeProject();
    const bridge = await createLspBridge(spawnOptions(project, {}));
    try {
      assert.ok(bridge, "bridge must start");
      assert.equal(
        await waitFor(() => existsSync(project.pidPath), 3000),
        true,
        "fake server must record its pid"
      );
      const serverPid = Number(readFileSync(project.pidPath, "utf8"));
      assert.ok(Number.isInteger(serverPid) && serverPid > 0, `invalid server pid: ${serverPid}`);
      assert.equal(isProcessAlive(serverPid), true, "server must be alive before dispose");

      await bridge!.dispose();
      assert.equal(bridge!.running, false, "dispose must mark the bridge not running");
      const gone = await waitFor(() => !isProcessAlive(serverPid), 4000);
      assert.equal(gone, true, `server process ${serverPid} must be dead after dispose`);
      await bridge!.dispose(); // Idempotent: a second dispose must not throw.
    } finally {
      await bridge?.dispose();
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  await check("initialize timeout returns undefined and kills the hung child", async () => {
    const project = makeProject();
    const startedAt = Date.now();
    const bridge = await createLspBridge(
      spawnOptions(project, { FAKE_LSP_HANG_INITIALIZE: "1" }, { initializeTimeoutMs: 350 })
    );
    const elapsed = Date.now() - startedAt;
    try {
      assert.equal(bridge, undefined, "hung initialize must resolve undefined");
      assert.ok(elapsed >= 250, `expected initialize timeout wait, got ${elapsed}ms`);
      assert.ok(elapsed < 8000, `initialize timeout must stay bounded, got ${elapsed}ms`);
      const gone = await waitFor(() => {
        if (!existsSync(project.pidPath)) return false;
        const serverPid = Number(readFileSync(project.pidPath, "utf8"));
        return !isProcessAlive(serverPid);
      }, 4000);
      assert.equal(gone, true, "the hung server child must be killed on initialize failure");
    } finally {
      rmSync(project.root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("lsp-bridge test failed:", err);
  process.exit(1);
});
