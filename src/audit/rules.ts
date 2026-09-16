/**
 * Minimal glob → RegExp for audit rules (no external dependency).
 * Supports: ** (any depth incl. /), * (within one segment), ? (one char),
 * {a,b} alternation, character classes, and exact literals. Everything else
 * matches literally.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // "**" swallows separators; tolerate a following "/" (consumed here so
        // "a/**/b" also matches "a/b").
        re += "(?:.*)";
        i += 2;
        if (pattern[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        re += "(?:" + alts.join("|") + ")";
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end > i) {
        re += "[" + pattern.slice(i + 1, end).replace(/\\/g, "\\\\") + "]";
        i = end + 1;
        continue;
      }
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(re + "$");
}

/** Match a posix relative path against a glob. */
export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Load `graphflow.audit.json` from the project root. Returns an empty rule
 * set (never throws) when the file is missing or malformed.
 */
export function loadAuditRuleSet(root: string, readFile?: (p: string) => string): { rules: import("./types.js").AuditRule[]; source?: string } {
  const read = readFile ?? ((p: string) => require("node:fs").readFileSync(p, "utf8") as string);
  try {
    const path = require("node:path").join(root, "graphflow.audit.json") as string;
    const raw = read(path);
    const parsed = JSON.parse(raw) as { rules?: import("./types.js").AuditRule[] };
    const rules = Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && typeof r.filePattern === "string" && Array.isArray(r.mustBeReferencedBy)) : [];
    return { rules, source: path };
  } catch {
    return { rules: [] };
  }
}
