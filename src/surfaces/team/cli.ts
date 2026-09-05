import { readFileSync } from "node:fs";
import { isTeamRole, type TeamRole } from "../../security/rbac.js";
import { issueLocalJwt, parseRoleTaggedBearer } from "../../security/token-auth.js";
import {
  isLoopbackHost,
  startTeamMemoryServer,
  type TeamHttpAuthOptions,
  type TeamMemoryServerOptions,
} from "./server.js";

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

function collectFlags(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1]?.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

export function readTeamServerOptionsFromArgv(
  argv: string[] = process.argv.slice(2)
): TeamMemoryServerOptions {
  const rawPort = readFlag(argv, "--port");
  const port = rawPort ? Number.parseInt(rawPort, 10) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  const bearerRoleMap: Record<string, TeamRole> = {};
  const bearerTokens: string[] = [];
  const tagged = [
    ...(process.env.GRAPHFLOW_TEAM_TOKEN ? [process.env.GRAPHFLOW_TEAM_TOKEN] : []),
    ...collectFlags(argv, "--http-token"),
  ];
  for (const raw of tagged) {
    const parsed = parseRoleTaggedBearer(raw);
    bearerTokens.push(parsed.token);
    if (parsed.role) bearerRoleMap[parsed.token] = parsed.role;
  }
  for (const raw of collectFlags(argv, "--role-map")) {
    const parsed = parseRoleTaggedBearer(raw);
    if (parsed.role) {
      bearerRoleMap[parsed.token] = parsed.role;
      if (!bearerTokens.includes(parsed.token)) bearerTokens.push(parsed.token);
    }
  }

  const jwtSecret = readFlag(argv, "--http-jwt-secret") ?? process.env.GRAPHFLOW_TEAM_JWT_SECRET;
  const publicKeyFile = readFlag(argv, "--http-public-key-file");
  const issuer = readFlag(argv, "--http-oidc-issuer") ?? process.env.GRAPHFLOW_TEAM_OIDC_ISSUER;
  const audience = readFlag(argv, "--http-oidc-audience") ?? process.env.GRAPHFLOW_TEAM_OIDC_AUDIENCE;
  const requiredScope = readFlag(argv, "--http-required-scope");
  const allowedTenants = collectFlags(argv, "--allow-tenant");
  const host = readFlag(argv, "--host");
  const requireAuthFlag = argv.includes("--require-auth")
    ? true
    : argv.includes("--allow-anonymous")
      ? false
      : undefined;

  const auth: TeamHttpAuthOptions = {
    ...(bearerTokens.length > 0 ? { bearerTokens } : {}),
    ...(Object.keys(bearerRoleMap).length > 0 ? { bearerRoleMap } : {}),
    ...(jwtSecret ? { jwtSecret } : {}),
    ...(publicKeyFile ? { publicKeyPem: readFileSync(publicKeyFile, "utf8") } : {}),
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
    ...(requiredScope ? { requiredScope } : {}),
    ...(allowedTenants.length > 0 ? { allowedTenants } : {}),
  };

  const endpoint = readFlag(argv, "--endpoint");
  const storeRoot = readFlag(argv, "--store");
  const auditPath = readFlag(argv, "--audit-path");
  const allowedHosts = collectFlags(argv, "--allow-host");
  const allowedOrigins = collectFlags(argv, "--allow-origin");
  return {
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(storeRoot ? { storeRoot } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    ...(Object.keys(auth).length > 0 ? { auth } : {}),
    ...(auditPath ? { auditPath } : {}),
    ...(requireAuthFlag !== undefined ? { requireAuth: requireAuthFlag } : {}),
  };
}

export async function startTeamServerFromArgv(argv: string[]) {
  return startTeamMemoryServer(readTeamServerOptionsFromArgv(argv));
}

export function issueTeamTokenFromArgv(argv: string[]): {
  token: string;
  subject: string;
  role: TeamRole;
  ttlSeconds: number;
} {
  const subject = readFlag(argv, "--subject") ?? "team-user";
  const roleRaw = readFlag(argv, "--role") ?? "contributor";
  if (!isTeamRole(roleRaw)) {
    throw new Error("--role must be viewer, contributor, or admin");
  }
  const secret =
    readFlag(argv, "--secret") ??
    process.env.GRAPHFLOW_TEAM_JWT_SECRET ??
    process.env.GRAPHFLOW_MCP_HTTP_JWT_SECRET;
  if (!secret) {
    throw new Error("JWT secret required: pass --secret or set GRAPHFLOW_TEAM_JWT_SECRET");
  }
  const ttlRaw = readFlag(argv, "--ttl");
  const ttlSeconds = ttlRaw ? Number.parseInt(ttlRaw, 10) : 86400;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("--ttl must be a positive integer (seconds)");
  }
  const issuer = readFlag(argv, "--issuer") ?? "graphflow-team";
  const audience = readFlag(argv, "--audience") ?? "graphflow-team";
  const token = issueLocalJwt(subject, secret, {
    role: roleRaw,
    issuer,
    audience,
    ttlSeconds,
  });
  return { token, subject, role: roleRaw, ttlSeconds };
}

export function buildTeamClientExampleConfig(options: {
  endpoint?: string;
  tenant?: string;
  apiKey?: string;
} = {}): Record<string, unknown> {
  const endpoint = options.endpoint ?? "http://127.0.0.1:8787/mcp";
  const tenant = options.tenant ?? "default";
  return {
    graphPolicy: {
      transport: "mcp-http",
      mcpEndpoint: endpoint,
      mcpApiKey: options.apiKey ?? "${GRAPHFLOW_TEAM_TOKEN}",
      mcpTenant: tenant,
      graphStorePath: "graphflow-out/graphflow-graph.json",
      maxContextTokens: 1500,
      enableAutoBuild: true,
    },
    _comment:
      "Point mcpApiKey at a viewer|contributor|admin bearer or an HS256 JWT issued by `graphflow team issue-token`. Loopback solo use stays transport: auto with no auth.",
  };
}

export function describeTeamBindPolicy(host: string): string {
  return isLoopbackHost(host)
    ? "loopback: auth optional (local-first)"
    : "non-loopback: auth + RBAC required";
}
