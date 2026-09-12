import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMcpWorkspaceEnv,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { createMcpServer } from "../src/surfaces/mcp/server";
import { createTempProjectRoot, rmTrackedRoots } from "./helpers/temp-workspace";

/**
 * M74 — MCP unsafe workspace regression.
 *
 * vscode-extension/mcp-launcher.cjs must never pin GRAPHFLOW_WORKSPACE_ROOT to
 * homedir/AppData (see comment on resolveChildWorkspaceRoot). Pure CJS spawn
 * side-effects make the launcher awkward to unit-test; these cases cover the
 * shared TS helpers the launcher mirrors.
 *
 * Isolation: no process.chdir(), no writes under $HOME. Project fixtures live
 * in os.tmpdir(); unsafe-cwd is exercised via fromDir / process.cwd mock.
 * homedir() is only used as a path string for the unsafe-root predicate.
 */

const tempRoots: string[] = [];
const envKeys = [
  "GRAPHFLOW_WORKSPACE_ROOT",
  "CURSOR_PROJECT_DIR",
  "WORKSPACE_FOLDER",
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Partial<
  Record<(typeof envKeys)[number], string | undefined>
>;

function createTempProject(prefix: string): string {
  return createTempProjectRoot(prefix, tempRoots);
}

function mockCwd(dir: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

beforeEach(() => {
  for (const key of envKeys) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
  rmTrackedRoots(tempRoots);
});

describe("M74 MCP unsafe workspace regression", () => {
  it("isUnsafeWorkspaceFallback(homedir) is true", () => {
    expect(isUnsafeWorkspaceFallback(homedir())).toBe(true);
  });

  it("clears GRAPHFLOW_WORKSPACE_ROOT when set to homedir", () => {
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();

    const resolved = ensureMcpWorkspaceEnv(homedir());
    expect(resolved === undefined || !isUnsafeWorkspaceFallback(resolved)).toBe(true);
    if (process.env.GRAPHFLOW_WORKSPACE_ROOT) {
      expect(isUnsafeWorkspaceFallback(process.env.GRAPHFLOW_WORKSPACE_ROOT)).toBe(false);
    }
  });

  it("resolveRuntimeWorkspaceRoot clears homedir env and honors safe rootDir", () => {
    const project = createTempProject("m74-safe-root");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();

    const withOverride = resolveRuntimeWorkspaceRoot({ rootDir: project });
    expect(withOverride).toBe(resolve(project));

    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;
    mockCwd(project);

    const discovered = resolveRuntimeWorkspaceRoot({ fromDir: project });
    expect(discovered).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
  });

  it("ensureMcpWorkspaceEnv rediscovers a real project after clearing home env", () => {
    const project = createTempProject("m74-rediscover");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;

    const resolved = ensureMcpWorkspaceEnv(project);
    expect(resolved).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(resolve(project));
  });

  it("returns a recoverable isError result for an unsafe rootDir instead of a protocol error", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "m74-unsafe-root", version: "1.0.0" });
    try {
      await server.sdkServer.connect(serverTransport);
      await client.connect(clientTransport);

      // The safety invariant is unchanged: home is still refused. But the caller
      // now gets an isError result it can act on (retry with a real rootDir)
      // rather than an opaque -32603 that kills the tool call.
      const result = await client.callTool({
        name: "graphflow_context",
        arguments: { query: "unsafe root probe", rootDir: homedir() },
      });

      expect(result.isError).toBe(true);
      const text = result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(text).toMatch(/unsafe workspace root/i);
      expect(text).toMatch(/Retry this same call with rootDir/);
      expect(text).toContain(homedir());
    } finally {
      await client.close().catch(() => undefined);
      await server.sdkServer.close().catch(() => undefined);
    }
  });

});
