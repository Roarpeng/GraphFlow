/**
 * Secret redaction (spec §12). Patterns run most-specific first; already-redacted markers are never
 * re-matched, so redaction is idempotent. Plain hex hashes (git SHAs) and UUIDs carry no key prefix
 * and are left untouched.
 */

interface SecretRule {
  kind: string;
  re: RegExp;
  /** Number of leading capture groups to keep verbatim (prefix such as `password=`). */
  keepGroups?: number;
}

const RULES: readonly SecretRule[] = [
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "deepseek-key", re: /\bsk-[a-f0-9]{32,}\b/g },
  { kind: "openai-key", re: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  {
    kind: "aws-secret-key",
    re: /((?:aws_?secret_?access_?key|aws_?secret|secret_?access_?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    keepGroups: 1,
  },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { kind: "bearer-token", re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, keepGroups: 1 },
  { kind: "basic-auth", re: /\b(Basic\s+)([A-Za-z0-9+/]{16,}={0,2})/g, keepGroups: 1 },
  {
    kind: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"'<>[\]]+):([^\s@/"'<>[\]]+)@/gi,
    keepGroups: 1,
  },
  {
    kind: "generic-secret",
    re: /((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|token)["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"'`,;]{8,})/gi,
    keepGroups: 1,
  },
];

/** Values that look like code references rather than literal secrets (e.g. `password = getPassword()`). */
function looksLikeCodeReference(value: string): boolean {
  if (value.startsWith("[REDACTED")) return true;
  if (/^(process\.env|os\.environ|import\.meta\.env|\$\{|\$|env\.|config\.|settings\.)/i.test(value)) return true;
  if (/[()]/.test(value) && !/\d/.test(value.replace(/\(\)$/, ""))) return true;
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && !/\d/.test(value);
}

export function redactSecrets(text: string): { text: string; redactions: number; kinds: string[] } {
  if (typeof text !== "string" || !text) return { text: typeof text === "string" ? text : "", redactions: 0, kinds: [] };
  let out = text;
  let redactions = 0;
  const kinds: string[] = [];
  for (const rule of RULES) {
    out = out.replace(rule.re, (match: string, ...groups: unknown[]) => {
      const keep = rule.keepGroups ?? 0;
      if (rule.kind === "generic-secret") {
        const value = String(groups[1] ?? "");
        if (looksLikeCodeReference(value)) return match;
      }
      redactions++;
      if (!kinds.includes(rule.kind)) kinds.push(rule.kind);
      const prefix = groups.slice(0, keep).map((g) => (typeof g === "string" ? g : "")).join("");
      const suffix = rule.kind === "url-credentials" ? "@" : "";
      return `${prefix}[REDACTED:${rule.kind}]${suffix}`;
    });
  }
  return { text: out, redactions, kinds };
}

/** Deep-redact every string inside a JSON-like value. The input is never mutated. */
export function redactDeep<T>(value: T): { value: T; redactions: number } {
  let redactions = 0;
  const seen = new WeakMap<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      redactions += r.redactions;
      return r.text;
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) return seen.get(v);
      const arr: unknown[] = [];
      seen.set(v, arr);
      for (const item of v) arr.push(walk(item));
      return arr;
    }
    if (v && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      if (seen.has(v)) return seen.get(v);
      const obj: Record<string, unknown> = {};
      seen.set(v, obj);
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) obj[k] = walk(item);
      return obj;
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: out, redactions };
}
