import { readFileSync } from "node:fs";
import { join } from "node:path";

export function resolvePackageVersion(): string {
  const candidates = [
    join(__dirname, "..", "..", "..", "package.json"),
    join(__dirname, "..", "..", "..", "..", "package.json"),
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

  return "0.0.0";
}

export const PACKAGE_VERSION = resolvePackageVersion();
