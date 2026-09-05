import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GraphEdge, GraphNode } from "../../core/types.js";
import { GraphifyFileClient } from "../../graph/graphify-file-client.js";
import { approveGraphNode, propagateQuarantine } from "../../graph/team-governance.js";
import { appendGovernanceAudit } from "../../learning/evidence.js";
import {
  assertAuthorized,
  authorizeTeamMethod,
  TeamAuthorizationError,
  type TeamRole,
} from "../../security/rbac.js";
import {
  credentialsConfigured,
  verifyAccessToken,
  type AccessTokenResult,
  type TokenAuthConfig,
} from "../../security/token-auth.js";

export interface TeamHttpAuthOptions extends TokenAuthConfig {
  allowedTenants?: readonly string[];
}

export interface TeamMemoryServerOptions {
  host?: string;
  port?: number;
  endpoint?: string;
  /** Root directory for per-tenant graph + skill-pack files. */
  storeRoot?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  signal?: AbortSignal;
  auth?: TeamHttpAuthOptions;
  auditPath?: string;
  /**
   * When true (default for non-loopback), credentials + RBAC are required.
   * Loopback stays local-first unless auth is explicitly configured.
   */
  requireAuth?: boolean;
}

export interface StartedTeamMemoryServer {
  httpServer: HttpServer;
  url: string;
  endpoint: string;
  host: string;
  port: number;
  storeRoot: string;
  requireAuth: boolean;
  rbac: true;
  close(): Promise<void>;
}

export interface TeamHealthResult {
  ok: true;
  service: "graphflow-team-memory";
  tenant: string;
  role: TeamRole | "local";
  rbac: true;
  authMode: "none" | "bearer" | "jwt";
  nodeCount: number;
  edgeCount: number;
  skillPackRevision: number | null;
}

interface SkillPackStore {
  revision: number;
  updatedAt: string;
  pack: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function normalizeHttpEndpoint(endpoint: string | undefined): string {
  const value = endpoint?.trim() || "/mcp";
  if (!value.startsWith("/")) throw new Error("Team memory endpoint must begin with '/'");
  if (value.includes("*") || value.includes("?")) throw new Error("Team memory endpoint must be an exact path");
  return value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function writeHttpJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  requestId: number | string | null,
  message: string,
  code = -32600
): void {
  writeHttpJson(res, status, {
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message },
  });
}

function validateHttpOrigin(req: IncomingMessage, allowedOrigins: string[] | undefined): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  return Boolean(allowedOrigins?.some((allowed) => allowed.toLowerCase() === origin.toLowerCase()));
}

function validateHttpHost(req: IncomingMessage, host: string, allowedHosts: string[] | undefined): boolean {
  const header = req.headers.host;
  if (!header) return false;
  if (!allowedHosts?.length) {
    const hostname = header.split(":", 2)[0] ?? "";
    return isLoopbackHost(host) && isLoopbackHost(hostname);
  }
  const normalized = header.toLowerCase();
  return allowedHosts.some((allowed) => allowed.toLowerCase() === normalized);
}

function requestTenant(req: IncomingMessage, auth: TeamHttpAuthOptions | undefined): string {
  const value = req.headers["x-graphflow-tenant"];
  const raw = Array.isArray(value) ? value[0] : value;
  const tenant = raw?.trim() || "default";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(tenant)) {
    throw new Error("tenant is not allowed");
  }
  if (auth?.allowedTenants?.length && !auth.allowedTenants.includes(tenant)) {
    throw new Error("tenant is not allowed");
  }
  return tenant;
}

function sanitizeTenant(tenant: string): string {
  return tenant.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function tenantStorePaths(storeRoot: string, tenant: string): { graph: string; skills: string } {
  const root = join(storeRoot, sanitizeTenant(tenant));
  mkdirSync(root, { recursive: true });
  return {
    graph: join(root, "graph.json"),
    skills: join(root, "skills.json"),
  };
}

function readSkillPack(path: string): SkillPackStore | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillPackStore;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSkillPack(path: string, pack: unknown): SkillPackStore {
  const previous = readSkillPack(path);
  const next: SkillPackStore = {
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    pack,
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function authModeOf(auth: TeamHttpAuthOptions | undefined): TeamHealthResult["authMode"] {
  if (auth?.jwtSecret || auth?.publicKeyPem) return "jwt";
  if (auth?.bearerTokens?.length || (auth?.bearerRoleMap && Object.keys(auth.bearerRoleMap).length > 0)) {
    return "bearer";
  }
  return "none";
}

async function dispatchTeamMethod(
  method: string,
  params: Record<string, unknown>,
  store: GraphifyFileClient,
  skillPath: string
): Promise<unknown> {
  switch (method) {
    case "graph.upsert_nodes": {
      await store.upsertNodes((params.nodes as GraphNode[]) ?? []);
      return null;
    }
    case "graph.upsert_edges": {
      await store.upsertEdges((params.edges as GraphEdge[]) ?? []);
      return null;
    }
    case "graph.query_subgraph": {
      const query = String(params.query ?? "");
      return { nodes: await store.queryByKeyword(query) };
    }
    case "graph.get_nodes": {
      return { nodes: await store.getNodesByIds((params.ids as string[]) ?? []) };
    }
    case "graph.get_neighbors": {
      const direction = params.direction === "out" || params.direction === "in" || params.direction === "both"
        ? params.direction
        : "both";
      return {
        neighbors: await store.getNeighbors(
          (params.nodeIds as string[]) ?? [],
          params.relations as GraphEdge["relation"][] | undefined,
          direction
        ),
      };
    }
    case "graph.delete_node": {
      await store.deleteNode(String(params.id ?? ""));
      return null;
    }
    case "graph.delete_edge": {
      await store.deleteEdge(
        String(params.from ?? ""),
        String(params.to ?? ""),
        params.relation as GraphEdge["relation"]
      );
      return null;
    }
    case "graph.read_snapshot": {
      return store.readSnapshot();
    }
    case "skill.sync_push": {
      const stored = writeSkillPack(skillPath, params.pack ?? params);
      return { revision: stored.revision, updatedAt: stored.updatedAt };
    }
    case "skill.sync_pull": {
      const stored = readSkillPack(skillPath);
      return { pack: stored?.pack ?? null, revision: stored?.revision ?? null, updatedAt: stored?.updatedAt ?? null };
    }
    case "artifact.import": {
      await store.upsertNodes((params.nodes as GraphNode[]) ?? []);
      await store.upsertEdges((params.edges as GraphEdge[]) ?? []);
      const snapshot = store.readSnapshot();
      return { nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length, imported: true };
    }
    case "governance.quarantine": {
      const ids = (params.nodeIds as string[]) ?? [];
      return propagateQuarantine(store, ids, {
        ...(typeof params.actor === "string" ? { actor: params.actor } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      });
    }
    case "governance.review": {
      return approveGraphNode(
        store,
        String(params.nodeId ?? ""),
        String(params.role ?? "admin"),
        params.decision === "rejected" ? "rejected" : "approved",
        typeof params.reason === "string" ? params.reason : undefined
      );
    }
    case "team.health": {
      return null;
    }
    default:
      throw new Error(`Unknown Graphify method: ${method}`);
  }
}

export async function startTeamMemoryServer(
  options: TeamMemoryServerOptions = {}
): Promise<StartedTeamMemoryServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? Number(process.env.GRAPHFLOW_TEAM_PORT ?? 0);
  const endpoint = normalizeHttpEndpoint(options.endpoint ?? process.env.GRAPHFLOW_TEAM_ENDPOINT);
  const storeRoot = resolve(options.storeRoot ?? process.env.GRAPHFLOW_TEAM_STORE ?? ".graphflow/team-store");
  const loopback = isLoopbackHost(host);
  const hasCredentials = credentialsConfigured(options.auth);
  const requireAuth = options.requireAuth ?? (!loopback || hasCredentials);

  if (!loopback && !options.allowedHosts?.length) {
    throw new Error(`Refusing to bind team memory HTTP to non-loopback ${host} without explicit allowedHosts`);
  }
  if (requireAuth && !hasCredentials) {
    throw new Error(
      "Team memory server requires auth for this bind (bearer token or JWT). " +
        "Pass --http-token <role:token> or --http-jwt-secret, or bind loopback without credentials."
    );
  }
  if (!loopback && hasCredentials) {
    const roles = Object.values(options.auth?.bearerRoleMap ?? {});
    const jwtReady = Boolean(options.auth?.jwtSecret || options.auth?.publicKeyPem);
    if (!jwtReady && roles.length === 0) {
      throw new Error(
        "Non-loopback team serve requires RBAC role assignment: use --http-token viewer|contributor|admin:<token> " +
          "or issue JWTs with a role / memory:* scope."
      );
    }
  }

  mkdirSync(storeRoot, { recursive: true });
  const auditPath = options.auditPath ?? join(storeRoot, "team-http-audit.jsonl");

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (!validateHttpHost(req, host, options.allowedHosts)) {
        writeJsonRpcError(res, 403, null, "Invalid GraphFlow team HTTP Host");
        return;
      }
      if (!validateHttpOrigin(req, options.allowedOrigins)) {
        writeJsonRpcError(res, 403, null, "Origin is not allowed by GraphFlow team HTTP");
        return;
      }

      let tenant = "default";
      try {
        tenant = requestTenant(req, options.auth);
      } catch (error) {
        writeJsonRpcError(res, 403, null, error instanceof Error ? error.message : "tenant rejected");
        return;
      }

      let authentication: AccessTokenResult = { authenticated: true, subject: "local" };
      if (requireAuth) {
        authentication = await verifyAccessToken(req.headers.authorization, options.auth ?? {});
        if (!authentication.authenticated) {
          appendGovernanceAudit(auditPath, {
            actor: "anonymous",
            action: "team.auth.reject",
            subject: req.url ?? endpoint,
            tenant,
            data: { reason: authentication.reason },
          });
          writeJsonRpcError(res, 401, null, authentication.reason ?? "authentication rejected");
          return;
        }
      }

      const url = new URL(req.url ?? "/", "http://graphflow.invalid");
      const healthPath = url.pathname === "/health" || url.pathname === `${endpoint}/health`;
      const rpcPath = url.pathname === endpoint || (endpoint === "/mcp" && url.pathname === "/");

      if (req.method === "GET" && healthPath) {
        const paths = tenantStorePaths(storeRoot, tenant);
        const store = new GraphifyFileClient(paths.graph);
        const snapshot = store.readSnapshot();
        const pack = readSkillPack(paths.skills);
        const health: TeamHealthResult = {
          ok: true,
          service: "graphflow-team-memory",
          tenant,
          role: authentication.role ?? "local",
          rbac: true,
          authMode: authModeOf(options.auth),
          nodeCount: snapshot.nodes.length,
          edgeCount: snapshot.edges.length,
          skillPackRevision: pack?.revision ?? null,
        };
        if (requireAuth) {
          try {
            assertAuthorized(authorizeTeamMethod(authentication.role, "team.health"));
          } catch (error) {
            const message = error instanceof Error ? error.message : "RBAC denied";
            writeJsonRpcError(res, 403, null, message);
            return;
          }
        }
        writeHttpJson(res, 200, health);
        return;
      }

      if (!rpcPath) {
        writeJsonRpcError(res, 404, null, `Unknown GraphFlow team HTTP endpoint: ${url.pathname}`);
        return;
      }

      if (req.method !== "POST") {
        writeJsonRpcError(res, 405, null, "GraphFlow team memory accepts POST JSON-RPC");
        return;
      }

      let parsed: JsonRpcRequest;
      try {
        const body = await readJsonBody(req);
        parsed = (body && typeof body === "object" ? body : {}) as JsonRpcRequest;
      } catch {
        writeJsonRpcError(res, 400, null, "Invalid JSON body");
        return;
      }

      const requestId = parsed.id ?? null;
      const method = typeof parsed.method === "string" ? parsed.method : "";
      if (!method) {
        writeJsonRpcError(res, 400, requestId, "JSON-RPC method is required");
        return;
      }

      if (requireAuth) {
        try {
          assertAuthorized(authorizeTeamMethod(authentication.role, method));
        } catch (error) {
          const message = error instanceof TeamAuthorizationError || error instanceof Error
            ? error.message
            : "RBAC denied";
          appendGovernanceAudit(auditPath, {
            actor: authentication.subject ?? "anonymous",
            action: "team.rbac.deny",
            subject: method,
            tenant,
            data: { reason: message, role: authentication.role ?? null },
          });
          writeJsonRpcError(res, 403, requestId, message);
          return;
        }
      }

      const paths = tenantStorePaths(storeRoot, tenant);
      const store = new GraphifyFileClient(paths.graph);
      const auditEvent = appendGovernanceAudit(auditPath, {
        actor: authentication.subject ?? "local",
        action: `team.${method}`,
        subject: `${tenant}:${method}`,
        tenant,
        data: { role: authentication.role ?? "local" },
      });
      res.setHeader("x-graphflow-audit-seq", String(auditEvent.seq));
      res.setHeader("x-graphflow-tenant", tenant);
      if (authentication.role) {
        res.setHeader("x-graphflow-role", authentication.role);
      }

      try {
        if (method === "team.health") {
          const snapshot = store.readSnapshot();
          const pack = readSkillPack(paths.skills);
          const health: TeamHealthResult = {
            ok: true,
            service: "graphflow-team-memory",
            tenant,
            role: authentication.role ?? "local",
            rbac: true,
            authMode: authModeOf(options.auth),
            nodeCount: snapshot.nodes.length,
            edgeCount: snapshot.edges.length,
            skillPackRevision: pack?.revision ?? null,
          };
          writeHttpJson(res, 200, { jsonrpc: "2.0", id: requestId, result: health });
          return;
        }
        const result = await dispatchTeamMethod(
          method,
          parsed.params && typeof parsed.params === "object" ? parsed.params : {},
          store,
          paths.skills
        );
        writeHttpJson(res, 200, { jsonrpc: "2.0", id: requestId, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : "team method failed";
        writeJsonRpcError(res, 200, requestId, message, -32000);
      }
    })().catch((error) => {
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, null, "Unexpected GraphFlow team HTTP error");
      } else {
        res.destroy();
      }
      console.error("[GraphFlow team] Unexpected HTTP error:", error);
    });
  });

  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      void httpServer.close();
    }, { once: true });
  }

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, resolveListen);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("GraphFlow team HTTP listener did not return a TCP address");
  }

  return {
    httpServer,
    url: `http://${host === "::1" ? `[${host}]` : host}:${address.port}${endpoint}`,
    endpoint,
    host,
    port: address.port,
    storeRoot,
    requireAuth,
    rbac: true,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}
