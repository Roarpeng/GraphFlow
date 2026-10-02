import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { resolveConfig } from "../src/config/resolve";
import { closeAllGraphClients, createGraphClient } from "../src/graph/client-factory";
import { loadEpisode } from "../src/learning/episodic-memory";
import { createMcpServer } from "../src/surfaces/mcp/server";

/**
 * graphflow_run → graphflow_report_outcome round trip on ONE MCP server.
 *
 * Live finding (published 2.0.3): the MCP host could not load better-sqlite3,
 * so the `auto` transport wrote episodes to the JSON fallback store; a SQLite
 * host (the source CLI) then merged that JSON into SQLite and moved the file
 * away, and the same MCP server answered "Episode not found" for the episode
 * it had just created. These cases pin the fixed contract:
 *  - run and report both honor `rootDir` (same workspace binding);
 *  - an episode this server ran survives its store file being swapped;
 *  - the CLI `outcome report --root-dir` resolves the same store.
 */

const repoRoot = resolve(__dirname, "..");
const envKeys = ["GRAPHFLOW_CONFIG_HOME", "GRAPHFLOW_WORKSPACE_ROOT", "GRAPHFLOW_AUTO_CAPTURE"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

function createWorkspace(): { ws: string; storePath: string } {
  const base = mkdtempSync(join(tmpdir(), "gf-episode-rt-"));
  tempRoots.push(base);
  const ws = join(base, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "gf-episode-rt" }), "utf8");
  writeFileSync(
    join(ws, "src", "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "utf8"
  );
  const defaults = getDefaultConfig();
  // Project-layer config (no configPath on the calls): file transport keeps
  // Windows free of open SQLite handles at teardown; providers stay empty so
  // graphflow_run takes the bridge path without any network call.
  writeFileSync(
    join(ws, "graphflow.config.json"),
    JSON.stringify({
      ...defaults,
      providers: {},
      graphPolicy: {
        ...defaults.graphPolicy,
        transport: "file",
        graphStorePath: "graphflow-out/graphflow-graph.json",
        autoIndexOnRun: true,
        autoIndexOnPreview: false,
        autoIndexOnSave: false,
        embeddingProvider: "fnv",
        includeExtensions: [".ts"],
      },
      learningPolicy: { ...defaults.learningPolicy, enableFlywheel: true },
    }),
    "utf8"
  );
  return { ws, storePath: join(ws, "graphflow-out", "graphflow-graph.json") };
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "episode-roundtrip", version: "1.0.0" });
  await server.sdkServer.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.sdkServer.close().catch(() => undefined);
    },
  };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
  };
  expect(result.isError, JSON.stringify(result.content).slice(0, 400)).not.toBe(true);
  return result.structuredContent ?? (JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>);
}

async function readOutcome(ws: string, episodeId: string): Promise<string | undefined> {
  const client = createGraphClient(resolveConfig(undefined, { rootDir: ws }));
  try {
    return (await loadEpisode(client, episodeId))?.outcome;
  } finally {
    await client.close?.();
  }
}

beforeAll(() => {
  // No developer global config (real provider keys would turn bridge mode
  // into live LLM calls) and no session-journal writes into the repo cwd.
  const configHome = mkdtempSync(join(tmpdir(), "gf-episode-rt-home-"));
  tempRoots.push(configHome);
  process.env.GRAPHFLOW_CONFIG_HOME = configHome;
  process.env.GRAPHFLOW_AUTO_CAPTURE = "0";
  delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
});

afterEach(async () => {
  await closeAllGraphClients();
});

afterAll(() => {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

// Each case indexes a one-file workspace and runs the bridge orchestrator; on
// a saturated machine (full root suite + parallel agents) that measured up to
// ~60s, so the ceiling is 180s rather than the 60s global default.
describe("MCP episode round trip (graphflow_run → graphflow_report_outcome)", () => {
  it("records the outcome for an episode created by graphflow_run on the same server (rootDir binding)", async () => {
    const { ws, storePath } = createWorkspace();
    const { client, close } = await connect();
    try {
      const run = await callJson(client, "graphflow_run", {
        task: "add a subtract function next to add in src/math.ts",
        rootDir: ws,
      });
      expect(run.status).toBe("DELEGATED");
      const episodeId = run.episodeId as string;
      expect(episodeId).toMatch(/^episode:/);
      // rootDir is honored: the episode lands in the workspace store, not the
      // server's cwd (the repo).
      expect(existsSync(storePath)).toBe(true);
      expect(await readOutcome(ws, episodeId)).toBe("pending");

      const report = await callJson(client, "graphflow_report_outcome", {
        episodeId,
        success: true,
        rootDir: ws,
      });
      expect(report).toMatchObject({ ok: true, episodeId, outcome: "pass" });
      expect(await readOutcome(ws, episodeId)).toBe("pass");
    } finally {
      await close();
    }
  }, 180_000);

  it("still finds its own episode after the store file was merged away by a SQLite host", async () => {
    const { ws, storePath } = createWorkspace();
    const { client, close } = await connect();
    try {
      const run = await callJson(client, "graphflow_run", {
        task: "rename add to sum in src/math.ts",
        rootDir: ws,
      });
      const episodeId = run.episodeId as string;
      expect(episodeId).toMatch(/^episode:/);

      // What mergeSiblingJsonStoreIntoSqlite does from another process: the
      // JSON store this server writes to is moved to a backup.
      await closeAllGraphClients();
      renameSync(storePath, `${storePath}.merged-bak.latest`);
      expect(await readOutcome(ws, episodeId)).toBeUndefined();

      const report = await callJson(client, "graphflow_report_outcome", {
        episodeId,
        success: false,
        lessons: ["store swap must not orphan the episode created by this server"],
        rootDir: ws,
      });
      expect(report).toMatchObject({ ok: true, episodeId, outcome: "fail" });
      expect(await readOutcome(ws, episodeId)).toBe("fail");
    } finally {
      await close();
    }
  }, 180_000);

  it("unknown episode ids still answer ok:false with the legacy reason shape", async () => {
    const { ws } = createWorkspace();
    const { client, close } = await connect();
    try {
      const report = await callJson(client, "graphflow_report_outcome", {
        episodeId: "episode:does-not-exist",
        success: true,
        rootDir: ws,
      });
      expect(report).toEqual({ ok: false, reason: "Episode not found: episode:does-not-exist" });
    } finally {
      await close();
    }
  }, 180_000);

  it("CLI `outcome report --root-dir` resolves the same store as the MCP run", async () => {
    const { ws } = createWorkspace();
    const { client, close } = await connect();
    let episodeId: string;
    try {
      const run = await callJson(client, "graphflow_run", {
        task: "document add in src/math.ts",
        rootDir: ws,
      });
      episodeId = run.episodeId as string;
      expect(episodeId).toMatch(/^episode:/);
    } finally {
      await close();
    }
    await closeAllGraphClients();

    // cwd is the repo on purpose: only --root-dir points at the workspace.
    const cli = spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        join(repoRoot, "src", "surfaces", "cli", "index.ts"),
        "--json",
        "outcome",
        "report",
        episodeId,
        "true",
        "--root-dir",
        ws,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 170_000,
        env: { ...process.env, GRAPHFLOW_SKIP_POSTINSTALL: "1", GRAPHFLOW_LOG_LEVEL: "silent" },
      }
    );
    expect(cli.status, cli.stderr.slice(-800)).toBe(0);
    const payload = JSON.parse(cli.stdout.slice(cli.stdout.indexOf("{"))) as {
      data?: Record<string, unknown>;
    } & Record<string, unknown>;
    expect(payload.data ?? payload).toMatchObject({ ok: true, episodeId, outcome: "pass" });
    expect(await readOutcome(ws, episodeId)).toBe("pass");
  }, 180_000);
});
