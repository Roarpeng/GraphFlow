/**
 * framework-routes.ts — Framework-aware route detection
 *
 * Detects web framework routes using lightweight regex matching.
 * Supports Express, NestJS, FastAPI, Flask, Django.
 */

export interface DetectedRoute {
  method: string;
  path: string;
  handler: string;
  line: number;
  framework: string;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

// ── Express -----------------------------------------------------------

function detectExpress(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const re =
    /(?:app|router)\.(get|post|put|patch|delete|head|options|all|use)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s+)?(?:function\s+)?(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, method, path, handler] = m;
    if (!method || !path || !handler) continue;
    routes.push({
      method: method.toUpperCase(),
      path,
      handler,
      line: lineOf(content, m.index),
      framework: "express",
    });
  }
  return routes;
}

// ── NestJS ------------------------------------------------------------

function extractNestJSClassBody(
  content: string,
  startIndex: number
): { body: string; bodyStart: number } | undefined {
  const sliced = content.slice(startIndex);
  const classMatch = sliced.match(/\bclass\s+\w+\s*\{/);
  if (!classMatch || classMatch.index === undefined) return undefined;
  const bodyStart = startIndex + classMatch.index + classMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < content.length && depth > 0) {
    const ch = content.charAt(i);
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    }
    i++;
  }
  return { body: content.slice(bodyStart, i - 1), bodyStart };
}

function detectNestJS(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const ctrlRe = /@Controller\s*(?:\(\s*['"`]([^'"`]*)['"`]\s*\))?/g;
  let cm: RegExpExecArray | null;
  while ((cm = ctrlRe.exec(content)) !== null) {
    const [, ctrlPath = ""] = cm;
    const base = ctrlPath ? `/${ctrlPath.replace(/^\/+/, "")}` : "";
    const classInfo = extractNestJSClassBody(content, cm.index);
    if (!classInfo) continue;
    const { body, bodyStart } = classInfo;

    const methodRe =
      /@(Get|Post|Put|Patch|Delete|Head|Options)\s*(?:\(\s*['"`]([^'"`]*)['"`]\s*\))?\s*(?:\r?\n\s*)*(?:async\s+)?(\w+)\s*\(/gi;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(body)) !== null) {
      const [, mtd, rawPath = "", handler] = mm;
      if (!mtd || !handler) continue;
      const sub = rawPath ? `/${rawPath.replace(/^\/+/, "")}` : "";
      const fullPath = (base + sub).replace(/\/+/g, "/") || "/";
      routes.push({
        method: mtd.toUpperCase(),
        path: fullPath,
        handler,
        line: lineOf(content, bodyStart + mm.index),
        framework: "nestjs",
      });
    }
  }
  return routes;
}

// ── FastAPI -----------------------------------------------------------

function detectFastAPI(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const re =
    /@(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)(?:\s*(?:\r?\n|\r)\s*(?:async\s+)?def\s+(\w+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, method, path, handler] = m;
    if (!method || !path) continue;
    routes.push({
      method: method.toUpperCase(),
      path,
      handler: handler ?? "unknown",
      line: lineOf(content, m.index),
      framework: "fastapi",
    });
  }
  return routes;
}

// ── Flask -------------------------------------------------------------

function detectFlask(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  // With explicit methods=[...]
  const reMethods =
    /@app\.route\s*\(\s*['"`]([^'"`]+)['"`][^)]*methods\s*=\s*\[([^\]]+)\][^)]*\)(?:\s*(?:\r?\n|\r)\s*(?:async\s+)?def\s+(\w+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = reMethods.exec(content)) !== null) {
    const [, path, methodsStr, handler] = m;
    if (!path) continue;
    const methods = methodsStr
      ? methodsStr
          .split(",")
          .map((s) => s.trim().replace(/['"`]/g, "").toUpperCase())
          .filter(Boolean)
      : ["GET"];
    const line = lineOf(content, m.index);
    for (const method of methods) {
      routes.push({
        method,
        path,
        handler: handler ?? "unknown",
        line,
        framework: "flask",
      });
    }
  }

  // Without methods (defaults to GET)
  const reNoMethods =
    /@app\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)(?:\s*(?:\r?\n|\r)\s*(?:async\s+)?def\s+(\w+))?/gi;
  while ((m = reNoMethods.exec(content)) !== null) {
    const [, path, handler] = m;
    if (!path) continue;
    const line = lineOf(content, m.index);
    // Skip duplicates produced by the methods regex at the same line
    if (routes.some((r) => r.line === line && r.path === path)) continue;
    routes.push({
      method: "GET",
      path,
      handler: handler ?? "unknown",
      line,
      framework: "flask",
    });
  }

  return routes;
}

// ── Django ------------------------------------------------------------

function detectDjango(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const re = /\b(?:path|re_path)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\w.]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, path, handlerRef] = m;
    if (!path || !handlerRef) continue;
    const handler = handlerRef.split(".").pop() ?? handlerRef;
    routes.push({
      method: "ANY",
      path,
      handler,
      line: lineOf(content, m.index),
      framework: "django",
    });
  }
  return routes;
}

// ── Public API --------------------------------------------------------

export function detectRoutes(filePath: string, content: string): DetectedRoute[] {
  const lower = filePath.toLowerCase();
  const routes: DetectedRoute[] = [];

  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx")
  ) {
    routes.push(...detectExpress(content));
    routes.push(...detectNestJS(content));
  } else if (lower.endsWith(".py")) {
    routes.push(...detectFastAPI(content));
    routes.push(...detectFlask(content));
    routes.push(...detectDjango(content));
  }

  return routes;
}
