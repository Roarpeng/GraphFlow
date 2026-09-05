import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphifyMcpClient, TeamAuthError } from "../src/graph/graphify-mcp-client";
import { issueLocalJwt } from "../src/security/token-auth";
import { diagnoseTeamConfig, probeTeamDiagnosis } from "../src/surfaces/team/diagnose";
import {
  readTeamServerOptionsFromArgv,
  issueTeamTokenFromArgv,
} from "../src/surfaces/team/cli";
import { startTeamMemoryServer } from "../src/surfaces/team/server";
import { diagnoseRoutingResult } from "../src/surfaces/cli/runtime";
import { validateConfig } from "../src/config/loader";
import type { GraphFlowConfig } from "../src/config/schema";
import type { GraphNode } from "../src/core/types";

const servers: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "graphflow-team-"));
  dirs.push(dir);
  return dir;
}

function sampleNode(id: string, content = "hello team"): GraphNode {
  return { id, type: "File", content, metadata: {} };
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
}

function teamConfig(endpoint: string, apiKey: string, tenant = "acme"): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: { smart: { provider: "openai" }, economy: { provider: "openai" } },
    budgetPolicy: { runTokenCap: 1000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: "mcp-http",
      mcpEndpoint: endpoint,
      mcpApiKey: apiKey,
      mcpTenant: tenant,
      graphStorePath: join(tempDir(), "fallback.json"),
      maxContextTokens: 200,
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
}

describe("team memory server product path", () => {
  it("boots on loopback without auth (local-first)", async () => {
    const started = await startTeamMemoryServer({
      host: "127.0.0.1",
      port: 0,
      storeRoot: tempDir(),
    });
    servers.push(started);
    expect(started.requireAuth).toBe(false);
    expect(started.rbac).toBe(true);

    const res = await rpc(started.url, "graph.upsert_nodes", { nodes: [sampleNode("n1")] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();

    const snap = await rpc(started.url, "graph.read_snapshot");
    const snapshot = await snap.json();
    expect(snapshot.result.nodes).toHaveLength(1);
  });

  it("refuses non-loopback binds without auth / allowedHosts", async () => {
    await expect(startTeamMemoryServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/non-loopback/i);
    await expect(
      startTeamMemoryServer({ host: "0.0.0.0", port: 0, allowedHosts: ["example.com"] })
    ).rejects.toThrow(/requires auth/i);
  });

  it("allows viewer reads and denies writes / governance", async () => {
    const started = await startTeamMemoryServer({
      host: "127.0.0.1",
      port: 0,
      storeRoot: tempDir(),
      requireAuth: true,
      auth: {
        bearerRoleMap: {
          view: "viewer",
          write: "contributor",
          root: "admin",
        },
      },
    });
    servers.push(started);

    const seed = await rpc(started.url, "graph.upsert_nodes", { nodes: [sampleNode("file:a")] }, {
      Authorization: "Bearer write",
    });
    expect(seed.status).toBe(200);

    const read = await rpc(started.url, "graph.query_subgraph", { query: "team" }, {
      Authorization: "Bearer view",
    });
    expect(read.status).toBe(200);
    expect((await read.json()).result.nodes.length).toBeGreaterThan(0);

    const deniedWrite = await rpc(started.url, "graph.upsert_nodes", { nodes: [sampleNode("file:b")] }, {
      Authorization: "Bearer view",
    });
    expect(deniedWrite.status).toBe(403);
    expect((await deniedWrite.json()).error.message).toMatch(/viewer.*graph.write/);

    const deniedGov = await rpc(started.url, "governance.quarantine", { nodeIds: ["file:a"] }, {
      Authorization: "Bearer write",
    });
    expect(deniedGov.status).toBe(403);

    const adminDel = await rpc(started.url, "graph.delete_node", { id: "file:a" }, {
      Authorization: "Bearer root",
    });
    expect(adminDel.status).toBe(200);
  });

  it("isolates tenants and rejects unknown tenants when allowlisted", async () => {
    const started = await startTeamMemoryServer({
      host: "127.0.0.1",
      port: 0,
      storeRoot: tempDir(),
      requireAuth: true,
      auth: {
        bearerRoleMap: { tok: "contributor" },
        allowedTenants: ["acme", "other"],
      },
    });
    servers.push(started);

    await rpc(started.url, "graph.upsert_nodes", { nodes: [sampleNode("only-acme", "acme secret")] }, {
      Authorization: "Bearer tok",
      "X-GraphFlow-Tenant": "acme",
    });

    const other = await rpc(started.url, "graph.query_subgraph", { query: "secret" }, {
      Authorization: "Bearer tok",
      "X-GraphFlow-Tenant": "other",
    });
    expect((await other.json()).result.nodes).toEqual([]);

    const acme = await rpc(started.url, "graph.query_subgraph", { query: "secret" }, {
      Authorization: "Bearer tok",
      "X-GraphFlow-Tenant": "acme",
    });
    expect((await acme.json()).result.nodes).toHaveLength(1);

    const blocked = await rpc(started.url, "graph.query_subgraph", { query: "x" }, {
      Authorization: "Bearer tok",
      "X-GraphFlow-Tenant": "evil",
    });
    expect(blocked.status).toBe(403);
  });

  it("rejects missing/wrong client tokens and does not degrade on 401/403", async () => {
    const started = await startTeamMemoryServer({
      host: "127.0.0.1",
      port: 0,
      storeRoot: tempDir(),
      requireAuth: true,
      auth: { bearerRoleMap: { good: "contributor" } },
    });
    servers.push(started);

    const anon = await rpc(started.url, "graph.query_subgraph", { query: "" });
    expect(anon.status).toBe(401);

    const client = new GraphifyMcpClient(started.url, "bad-token", { tenant: "default" });
    await expect(client.upsertNodes([sampleNode("x")])).rejects.toBeInstanceOf(TeamAuthError);
    expect(client.isDegraded).toBe(false);

    const ok = new GraphifyMcpClient(started.url, "good", { tenant: "default" });
    await ok.upsertNodes([sampleNode("n-ok")]);
    const snap = await ok.fetchSnapshot();
    expect(snap.nodes.map((n) => n.id)).toContain("n-ok");
  });

  it("round-trips JWT contributor skill packs and reports diagnose fields", async () => {
    const secret = "team-diag-secret";
    const token = issueLocalJwt("ada", secret, { role: "contributor", issuer: "graphflow-team", audience: "graphflow-team" });
    const started = await startTeamMemoryServer({
      host: "127.0.0.1",
      port: 0,
      storeRoot: tempDir(),
      requireAuth: true,
      auth: { jwtSecret: secret, issuer: "graphflow-team", audience: "graphflow-team" },
    });
    servers.push(started);

    const client = new GraphifyMcpClient(started.url, token, { tenant: "default" });
    const pushed = await client.pushSkillPack({
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [{ id: "skill:demo", type: "Skill", content: "use team RBAC", metadata: {} }],
    });
    expect(pushed.revision).toBe(1);
    const pulled = await client.pullSkillPack();
    expect((pulled.pack as { skills: Array<{ id: string }> }).skills[0]?.id).toBe("skill:demo");

    const health = await client.teamHealth();
    expect(health).toMatchObject({
      ok: true,
      service: "graphflow-team-memory",
      tenant: "default",
      role: "contributor",
      rbac: true,
    });

    const cfg = teamConfig(started.url, token, "default");
    const snapshot = diagnoseTeamConfig(cfg);
    expect(snapshot).toMatchObject({
      enabled: true,
      transport: "mcp-http",
      endpoint: started.url,
      tenant: "default",
      authMode: "bearer",
      rbacExpected: true,
    });
  });

  it("parses team CLI flags and issues role-scoped JWTs", () => {
    const options = readTeamServerOptionsFromArgv([
      "--host", "127.0.0.1",
      "--port", "8787",
      "--http-token", "admin:root-token",
      "--allow-tenant", "acme",
      "--require-auth",
    ]);
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(8787);
    expect(options.requireAuth).toBe(true);
    expect(options.auth?.bearerRoleMap?.["root-token"]).toBe("admin");
    expect(options.auth?.allowedTenants).toEqual(["acme"]);

    const issued = issueTeamTokenFromArgv([
      "--subject", "ada",
      "--role", "viewer",
      "--secret", "cli-secret",
      "--ttl", "60",
    ]);
    expect(issued.role).toBe("viewer");
    expect(issued.token.split(".")).toHaveLength(3);
  });

  it("includes team config on diagnoseRoutingResult", () => {
    const diagnosis = diagnoseRoutingResult();
    expect(diagnosis.team).toMatchObject({
      enabled: false,
      transport: expect.any(String),
      authMode: "none",
      rbacExpected: false,
    });
  });
});

describe("team diagnose probe", () => {
  it("marks unreachable mcp-http endpoints as degraded", async () => {
    const cfgPath = join(tempDir(), "graphflow.config.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      cfgPath,
      JSON.stringify(
        teamConfig("http://127.0.0.1:1/mcp", "tok", "default"),
        null,
        2
      )
    );
    const probed = await probeTeamDiagnosis(cfgPath);
    expect(probed.enabled).toBe(true);
    expect(probed.reachable).toBe(false);
    expect(probed.degradedToLocal).toBe(true);
  });
});
