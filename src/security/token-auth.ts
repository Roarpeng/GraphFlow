import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import {
  defaultScopesForRole,
  isTeamRole,
  roleFromScopes,
  type TeamRole,
} from "./rbac.js";

export interface TokenAuthConfig {
  /** Shared-secret bearer tokens for local/team deployments. */
  bearerTokens?: readonly string[];
  /** Optional role assignment for each bearer token value. */
  bearerRoleMap?: Readonly<Record<string, TeamRole>>;
  /** HS256 JWT secret. */
  jwtSecret?: string;
  /** RS256/ES256 public key PEM for OIDC providers. */
  publicKeyPem?: string;
  issuer?: string;
  audience?: string;
  requiredScope?: string;
}

export interface AccessTokenResult {
  authenticated: boolean;
  subject?: string;
  reason?: string;
  role?: TeamRole;
  scopes?: string[];
}

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  scope?: unknown;
  scp?: unknown;
  role?: unknown;
  roles?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
}

interface ParsedJwt {
  header: JwtHeader;
  payload: JwtClaims;
  signature: Buffer;
}

function splitToken(token: string): ParsedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as JwtHeader,
      payload: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JwtClaims,
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return undefined;
  }
}

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseScopeList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return [];
}

function roleFromClaims(payload: JwtClaims): TeamRole | undefined {
  if (isTeamRole(payload.role)) return payload.role;
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const fromRoles = roleFromScopes(roles.filter((item): item is string => typeof item === "string"));
  if (fromRoles) return fromRoles;
  return roleFromScopes([...parseScopeList(payload.scope), ...parseScopeList(payload.scp)]);
}

function bearerCandidates(config: TokenAuthConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of config.bearerTokens ?? []) {
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  for (const token of Object.keys(config.bearerRoleMap ?? {})) {
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export async function verifyAccessToken(
  authorizationHeader: string | undefined,
  config: TokenAuthConfig
): Promise<AccessTokenResult> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { authenticated: false, reason: "missing bearer token" };
  }
  const token = authorizationHeader.slice(7).trim();

  for (const expected of bearerCandidates(config)) {
    if (expected && secureEquals(token, expected)) {
      const role = config.bearerRoleMap?.[expected];
      return {
        authenticated: true,
        subject: "bearer",
        ...(role ? { role } : {}),
      };
    }
  }

  const jwt = splitToken(token);
  if (!jwt || typeof jwt.payload !== "object" || jwt.payload === null) {
    return { authenticated: false, reason: "invalid token" };
  }
  const signed = `${token.split(".")[0]}.${token.split(".")[1]}`;
  let verified = false;
  if (jwt.header?.alg === "HS256" && config.jwtSecret) {
    const expected = createHmac("sha256", config.jwtSecret).update(signed).digest();
    verified = expected.length === jwt.signature.length && timingSafeEqual(expected, jwt.signature);
  } else if (
    (jwt.header?.alg === "RS256" || jwt.header?.alg === "ES256") &&
    config.publicKeyPem
  ) {
    try {
      verified = cryptoVerify(
        jwt.header.alg,
        Buffer.from(signed),
        createPublicKey(config.publicKeyPem),
        jwt.signature
      );
    } catch {
      verified = false;
    }
  }
  if (!verified) return { authenticated: false, reason: "signature rejected" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof jwt.payload.exp === "number" && jwt.payload.exp < now) {
    return { authenticated: false, reason: "token expired" };
  }
  if (typeof jwt.payload.nbf === "number" && jwt.payload.nbf > now) {
    return { authenticated: false, reason: "token not yet valid" };
  }

  if (config.issuer && jwt.payload.iss !== config.issuer) {
    return { authenticated: false, reason: "issuer rejected" };
  }
  const audience = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
  if (config.audience && !audience.includes(config.audience)) {
    return { authenticated: false, reason: "audience rejected" };
  }
  const scopes = [...parseScopeList(jwt.payload.scope), ...parseScopeList(jwt.payload.scp)];
  if (config.requiredScope && !scopes.includes(config.requiredScope)) {
    return { authenticated: false, reason: "scope rejected" };
  }
  const role = roleFromClaims(jwt.payload);
  return {
    authenticated: true,
    subject: typeof jwt.payload.sub === "string" ? jwt.payload.sub : "jwt",
    ...(role ? { role } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

export function issueLocalJwt(
  subject: string,
  secret: string,
  options: {
    issuer?: string;
    audience?: string;
    scope?: string;
    role?: TeamRole;
    ttlSeconds?: number;
  } = {}
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const role = options.role;
  const scope = options.scope ?? (role ? defaultScopesForRole(role) : undefined);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: subject,
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
    ...(scope ? { scope } : {}),
    ...(role ? { role } : {}),
    iat: now,
    exp: now + (options.ttlSeconds ?? 3600),
  });
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/** Parse `viewer:secret`, `admin:secret`, or `secret:admin` into token + role. Bare tokens have no role. */
export function parseRoleTaggedBearer(raw: string): { token: string; role?: TeamRole } {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(":");
  if (sep > 0) {
    const left = trimmed.slice(0, sep).trim();
    const right = trimmed.slice(sep + 1).trim();
    if (right && isTeamRole(left.toLowerCase())) {
      return { token: right, role: left.toLowerCase() as TeamRole };
    }
    if (left && isTeamRole(right.toLowerCase())) {
      return { token: left, role: right.toLowerCase() as TeamRole };
    }
  }
  return { token: trimmed };
}

export function credentialsConfigured(config: TokenAuthConfig | undefined): boolean {
  return Boolean(
    config?.bearerTokens?.length ||
      (config?.bearerRoleMap && Object.keys(config.bearerRoleMap).length > 0) ||
      config?.jwtSecret ||
      config?.publicKeyPem
  );
}
