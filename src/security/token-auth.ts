import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

export interface TokenAuthConfig {
  /** Shared-secret bearer tokens for local/team deployments. */
  bearerTokens?: readonly string[];
  /** HS256 JWT secret. */
  jwtSecret?: string;
  /** RS256/ES256 public key PEM for OIDC providers. */
  publicKeyPem?: string;
  issuer?: string;
  audience?: string;
  requiredScope?: string;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  scope?: unknown;
  sub?: unknown;
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

export async function verifyAccessToken(
  authorizationHeader: string | undefined,
  config: TokenAuthConfig
): Promise<{ authenticated: boolean; subject?: string; reason?: string }> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { authenticated: false, reason: "missing bearer token" };
  }
  const token = authorizationHeader.slice(7).trim();

  for (const expected of config.bearerTokens ?? []) {
    if (expected && secureEquals(token, expected)) {
      return { authenticated: true, subject: "bearer" };
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

  if (config.issuer && jwt.payload.iss !== config.issuer) {
    return { authenticated: false, reason: "issuer rejected" };
  }
  const audience = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
  if (config.audience && !audience.includes(config.audience)) {
    return { authenticated: false, reason: "audience rejected" };
  }
  const scopes = typeof jwt.payload.scope === "string" ? jwt.payload.scope.split(/\s+/) : [];
  if (config.requiredScope && !scopes.includes(config.requiredScope)) {
    return { authenticated: false, reason: "scope rejected" };
  }
  return { authenticated: true, subject: typeof jwt.payload.sub === "string" ? jwt.payload.sub : "jwt" };
}

export function issueLocalJwt(
  subject: string,
  secret: string,
  options: { issuer?: string; audience?: string; scope?: string; ttlSeconds?: number } = {}
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: subject,
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    iat: now,
    exp: now + (options.ttlSeconds ?? 3600),
  });
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}
