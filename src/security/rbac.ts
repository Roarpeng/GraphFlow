/**
 * Team HTTP RBAC — viewer | contributor | admin.
 *
 * Local-first surfaces (stdio, loopback file/sqlite, unauthenticated loopback
 * HTTP) never consult this module. Shared HTTP surfaces fail closed: a missing
 * role is a deny, not a silent grant.
 */

export const TEAM_ROLES = ["viewer", "contributor", "admin"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_PERMISSIONS = [
  "graph.read",
  "graph.write",
  "graph.delete",
  "skill.read",
  "skill.sync",
  "artifact.import",
  "governance.mutate",
  "diagnose.read",
] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

const ROLE_RANK: Record<TeamRole, number> = {
  viewer: 0,
  contributor: 1,
  admin: 2,
};

const ROLE_PERMISSIONS: Record<TeamRole, readonly TeamPermission[]> = {
  viewer: ["graph.read", "skill.read", "diagnose.read"],
  contributor: [
    "graph.read",
    "graph.write",
    "skill.read",
    "skill.sync",
    "artifact.import",
    "diagnose.read",
  ],
  admin: [
    "graph.read",
    "graph.write",
    "graph.delete",
    "skill.read",
    "skill.sync",
    "artifact.import",
    "governance.mutate",
    "diagnose.read",
  ],
};

/** Graphify / team-memory JSON-RPC methods. */
const TEAM_METHOD_PERMISSION: Record<string, TeamPermission> = {
  "graph.query_subgraph": "graph.read",
  "graph.get_nodes": "graph.read",
  "graph.get_neighbors": "graph.read",
  "graph.read_snapshot": "graph.read",
  "team.health": "diagnose.read",
  "graph.upsert_nodes": "graph.write",
  "graph.upsert_edges": "graph.write",
  "graph.delete_node": "graph.delete",
  "graph.delete_edge": "graph.delete",
  "skill.sync_push": "skill.sync",
  "skill.sync_pull": "skill.read",
  "artifact.import": "artifact.import",
  "governance.quarantine": "governance.mutate",
  "governance.review": "governance.mutate",
};

/** GraphFlow MCP tool names on the shared HTTP surface. */
const MCP_TOOL_PERMISSION: Record<string, TeamPermission> = {
  graphflow_context: "graph.read",
  graphflow_diagnose: "diagnose.read",
  graphflow_skill_insights: "skill.read",
  graphflow_skill_guide: "diagnose.read",
  graphflow_run: "graph.write",
  graphflow_plan: "graph.write",
  graphflow_index: "graph.write",
  graphflow_insight: "graph.write",
  graphflow_report_outcome: "graph.write",
  graphflow_artifact: "artifact.import",
};

export interface AuthorizationDecision {
  ok: boolean;
  role?: TeamRole;
  permission?: TeamPermission;
  reason?: string;
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

export function permissionsForRole(role: TeamRole): readonly TeamPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleSatisfies(actual: TeamRole, required: TeamRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function hasPermission(role: TeamRole | undefined, permission: TeamPermission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Map JWT `scope` tokens (and a few aliases) to the strongest matching role.
 * Unknown scopes are ignored — absence of a known role scope means unresolved.
 */
export function roleFromScopes(scopes: readonly string[]): TeamRole | undefined {
  let best: TeamRole | undefined;
  for (const raw of scopes) {
    const scope = raw.trim().toLowerCase();
    if (!scope) continue;
    const mapped = mapScopeToken(scope);
    if (!mapped) continue;
    if (!best || ROLE_RANK[mapped] > ROLE_RANK[best]) best = mapped;
  }
  return best;
}

function mapScopeToken(scope: string): TeamRole | undefined {
  if (
    scope === "memory:admin" ||
    scope === "admin" ||
    scope === "role:admin" ||
    scope === "graphflow:admin"
  ) {
    return "admin";
  }
  if (
    scope === "memory:write" ||
    scope === "contributor" ||
    scope === "role:contributor" ||
    scope === "editor" ||
    scope === "role:editor" ||
    scope === "graphflow:write"
  ) {
    return "contributor";
  }
  if (
    scope === "memory:read" ||
    scope === "viewer" ||
    scope === "role:viewer" ||
    scope === "graphflow:read"
  ) {
    return "viewer";
  }
  return undefined;
}

export function defaultScopesForRole(role: TeamRole): string {
  if (role === "admin") return "memory:read memory:write memory:admin";
  if (role === "contributor") return "memory:read memory:write";
  return "memory:read";
}

export function permissionForTeamMethod(method: string): TeamPermission | undefined {
  return TEAM_METHOD_PERMISSION[method];
}

export function permissionForMcpTool(toolName: string): TeamPermission | undefined {
  return MCP_TOOL_PERMISSION[toolName];
}

export function authorizePermission(
  role: TeamRole | undefined,
  permission: TeamPermission,
  subject = "action"
): AuthorizationDecision {
  if (!role) {
    return {
      ok: false,
      permission,
      reason: `RBAC denied ${subject}: role unresolved (fail closed)`,
    };
  }
  if (!hasPermission(role, permission)) {
    return {
      ok: false,
      role,
      permission,
      reason: `RBAC denied ${subject}: role '${role}' lacks '${permission}'`,
    };
  }
  return { ok: true, role, permission };
}

export function authorizeTeamMethod(
  role: TeamRole | undefined,
  method: string
): AuthorizationDecision {
  const permission = permissionForTeamMethod(method);
  if (!permission) {
    return {
      ok: false,
      ...(role ? { role } : {}),
      reason: `RBAC denied ${method}: unknown method (fail closed)`,
    };
  }
  return authorizePermission(role, permission, method);
}

export function authorizeMcpTool(
  role: TeamRole | undefined,
  toolName: string
): AuthorizationDecision {
  const permission = permissionForMcpTool(toolName);
  if (!permission) {
    return {
      ok: false,
      ...(role ? { role } : {}),
      reason: `RBAC denied ${toolName}: unknown tool (fail closed)`,
    };
  }
  return authorizePermission(role, permission, toolName);
}

export class TeamAuthorizationError extends Error {
  readonly statusCode = 403;
  readonly decision: AuthorizationDecision;

  constructor(decision: AuthorizationDecision) {
    super(decision.reason ?? "RBAC denied");
    this.name = "TeamAuthorizationError";
    this.decision = decision;
  }
}

export function assertAuthorized(decision: AuthorizationDecision): void {
  if (!decision.ok) {
    throw new TeamAuthorizationError(decision);
  }
}
