/**
 * Workspace exclude rules for indexing.
 *
 * Two sources, same syntax, unioned:
 * - `graphPolicy.excludeGlobs`
 * - `<workspace>/.graphflowignore`
 *
 * This is intentionally smaller than `.gitignore`: no negation (`!`), no
 * nested ignore files, no character classes. A rule that does not match is
 * skipped rather than treated as a path.
 *
 *   name/            skip any directory named `name` at any depth
 *   path/to/dir/     skip that workspace-relative directory (anchored)
 *   *.ext            skip files whose basename matches the glob
 *   a path glob      `*` does not cross `/`; a double-star does
 *
 * Inline ` # comments` are stripped. `*` does not cross `/`; `**` does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_IGNORE_FILE = ".graphflowignore";

export type IgnoreMatch = (relPath: string, isDir: boolean) => boolean;

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        out += ".*";
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Parse ignore text. `undefined` when every line is blank or a comment. */
export function parseIgnoreRules(text: string): IgnoreMatch | undefined {
  const dirNames = new Set<string>();
  const relPrefixes: string[] = [];
  const basenameRes: RegExp[] = [];
  const relRes: RegExp[] = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    let rule = rawLine.trim().replace(/\\/g, "/");
    if (!rule || rule.startsWith("#") || rule.startsWith("!")) continue;
    rule = rule.replace(/\s+#.*$/, "").trim();
    if (!rule) continue;
    if (rule.startsWith("./")) rule = rule.slice(2);
    if (rule.startsWith("/")) rule = rule.slice(1);
    if (rule.endsWith("/")) rule = rule.slice(0, -1);
    if (!rule) continue;
    if (!/[*?]/.test(rule)) {
      if (rule.includes("/")) relPrefixes.push(rule);
      else dirNames.add(rule);
      continue;
    }
    const source = `^${globToRegexSource(rule)}$`;
    const re = new RegExp(source);
    if (rule.includes("/")) relRes.push(re);
    else basenameRes.push(re);
  }

  if (dirNames.size === 0 && relPrefixes.length === 0 && basenameRes.length === 0 && relRes.length === 0) {
    return undefined;
  }

  return function ignoreMatch(relPath: string, isDir: boolean): boolean {
    const rel = String(relPath).replace(/\\/g, "/");
    if (!rel || rel === ".") return false;
    const parts = rel.split("/");
    const dirParts = isDir ? parts : parts.slice(0, -1);
    for (const part of dirParts) {
      if (dirNames.has(part)) return true;
    }
    for (const prefix of relPrefixes) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
    }
    if (!isDir) {
      const base = parts[parts.length - 1] ?? "";
      for (const re of basenameRes) {
        if (re.test(base)) return true;
      }
    }
    for (const re of relRes) {
      if (re.test(rel)) return true;
    }
    return false;
  };
}

/**
 * Load `.graphflowignore` plus `options.excludeGlobs`. Unreadable or absent
 * file is the same as no file: indexing stays unchanged.
 */
export function loadWorkspaceIgnore(
  rootDir: string,
  options?: { excludeGlobs?: readonly string[] }
): IgnoreMatch | undefined {
  const extra = Array.isArray(options?.excludeGlobs) ? options.excludeGlobs : [];
  let text = extra.length > 0 ? `${extra.join("\n")}\n` : "";
  try {
    const filePath = join(rootDir, WORKSPACE_IGNORE_FILE);
    if (existsSync(filePath)) {
      text += `${readFileSync(filePath, "utf8")}\n`;
    }
  } catch {
    // Missing or unreadable: same as an unpatched walker.
  }
  if (!text.trim()) return undefined;
  return parseIgnoreRules(text);
}
