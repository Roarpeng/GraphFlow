/**
 * Package version resolution, kept free of any MCP dependency (`src/version.ts`).
 *
 * The CLI needs the version string for `graphflow version` and the help banner. Importing
 * it from `mcp-server` dragged the whole `@modelcontextprotocol/sdk` graph into every CLI
 * invocation — measured at ~240 ms, about 86% of a cold start — for a string that only
 * needs `package.json`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function resolvePackageVersion(): string {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ];

  for (const packageJsonPath of candidates) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // try next candidate
    }
  }

  return "3.7.0";
}

export const PACKAGE_VERSION = resolvePackageVersion();
