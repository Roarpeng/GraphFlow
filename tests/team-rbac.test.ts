import { describe, expect, it } from "vitest";
import {
  authorizeMcpTool,
  authorizeTeamMethod,
  defaultScopesForRole,
  hasPermission,
  roleFromScopes,
  permissionsForRole,
} from "../src/security/rbac";
import {
  issueLocalJwt,
  parseRoleTaggedBearer,
  verifyAccessToken,
} from "../src/security/token-auth";

describe("team RBAC roles and scopes", () => {
  it("maps JWT scopes to viewer / contributor / admin (strongest wins)", () => {
    expect(roleFromScopes(["memory:read"])).toBe("viewer");
    expect(roleFromScopes(["memory:write"])).toBe("contributor");
    expect(roleFromScopes(["memory:admin"])).toBe("admin");
    expect(roleFromScopes(["memory:read", "memory:write"])).toBe("contributor");
    expect(roleFromScopes(["memory:read", "memory:admin"])).toBe("admin");
    expect(roleFromScopes(["unknown"])).toBeUndefined();
  });

  it("fails closed when role is unresolved", () => {
    expect(hasPermission(undefined, "graph.read")).toBe(false);
    expect(authorizeTeamMethod(undefined, "graph.query_subgraph").ok).toBe(false);
    expect(authorizeTeamMethod(undefined, "graph.query_subgraph").reason).toMatch(/fail closed/);
    expect(authorizeTeamMethod("viewer", "graph.unknown_method").ok).toBe(false);
  });

  it("enforces the permission matrix per role", () => {
    expect(permissionsForRole("viewer")).toContain("graph.read");
    expect(permissionsForRole("viewer")).not.toContain("graph.write");

    expect(authorizeTeamMethod("viewer", "graph.query_subgraph").ok).toBe(true);
    expect(authorizeTeamMethod("viewer", "graph.read_snapshot").ok).toBe(true);
    expect(authorizeTeamMethod("viewer", "skill.sync_pull").ok).toBe(true);
    expect(authorizeTeamMethod("viewer", "graph.upsert_nodes").ok).toBe(false);
    expect(authorizeTeamMethod("viewer", "skill.sync_push").ok).toBe(false);
    expect(authorizeTeamMethod("viewer", "artifact.import").ok).toBe(false);
    expect(authorizeTeamMethod("viewer", "governance.quarantine").ok).toBe(false);

    expect(authorizeTeamMethod("contributor", "graph.upsert_nodes").ok).toBe(true);
    expect(authorizeTeamMethod("contributor", "skill.sync_push").ok).toBe(true);
    expect(authorizeTeamMethod("contributor", "artifact.import").ok).toBe(true);
    expect(authorizeTeamMethod("contributor", "graph.delete_node").ok).toBe(false);
    expect(authorizeTeamMethod("contributor", "governance.quarantine").ok).toBe(false);

    expect(authorizeTeamMethod("admin", "graph.delete_node").ok).toBe(true);
    expect(authorizeTeamMethod("admin", "governance.quarantine").ok).toBe(true);
    expect(authorizeTeamMethod("admin", "governance.review").ok).toBe(true);
  });

  it("gates MCP tools the same way", () => {
    expect(authorizeMcpTool("viewer", "graphflow_diagnose").ok).toBe(true);
    expect(authorizeMcpTool("viewer", "graphflow_context").ok).toBe(true);
    expect(authorizeMcpTool("viewer", "graphflow_index").ok).toBe(false);
    expect(authorizeMcpTool("contributor", "graphflow_index").ok).toBe(true);
    expect(authorizeMcpTool("contributor", "graphflow_artifact").ok).toBe(true);
    expect(authorizeMcpTool("viewer", "graphflow_artifact").ok).toBe(false);
    expect(authorizeMcpTool("admin", "graphflow_report_outcome").ok).toBe(true);
  });

  it("resolves JWT role claim and default scopes from issueLocalJwt", async () => {
    const secret = "unit-jwt-secret";
    const token = issueLocalJwt("ada", secret, { role: "viewer", issuer: "graphflow-team", audience: "graphflow-team" });
    const accepted = await verifyAccessToken(`Bearer ${token}`, {
      jwtSecret: secret,
      issuer: "graphflow-team",
      audience: "graphflow-team",
    });
    expect(accepted).toMatchObject({ authenticated: true, subject: "ada", role: "viewer" });
    expect(accepted.scopes).toEqual(defaultScopesForRole("viewer").split(/\s+/));

    const admin = issueLocalJwt("bob", secret, { role: "admin" });
    const adminAuth = await verifyAccessToken(`Bearer ${admin}`, { jwtSecret: secret });
    expect(adminAuth.role).toBe("admin");
  });

  it("maps bearer role map and role-tagged tokens", async () => {
    const accepted = await verifyAccessToken("Bearer tok-write", {
      bearerRoleMap: { "tok-write": "contributor", "tok-view": "viewer" },
    });
    expect(accepted).toMatchObject({ authenticated: true, role: "contributor", subject: "bearer" });

    expect(parseRoleTaggedBearer("admin:s3cret")).toEqual({ token: "s3cret", role: "admin" });
    expect(parseRoleTaggedBearer("s3cret:viewer")).toEqual({ token: "s3cret", role: "viewer" });
    expect(parseRoleTaggedBearer("bare-token")).toEqual({ token: "bare-token" });
  });

  it("rejects expired JWTs", async () => {
    const secret = "exp-secret";
    const token = issueLocalJwt("ada", secret, { role: "admin", ttlSeconds: 1 });
    const now = Math.floor(Date.now() / 1000);
    // rewrite exp in the past
    const [h, p] = token.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8"));
    payload.exp = now - 10;
    const signed = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const { createHmac } = await import("node:crypto");
    const forged = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
    const rejected = await verifyAccessToken(`Bearer ${forged}`, { jwtSecret: secret });
    expect(rejected.authenticated).toBe(false);
    expect(rejected.reason).toBe("token expired");
  });
});
