import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const artifactsDir = join(extensionRoot, "..", "artifacts");
const version = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8")).version;
const outFile = join(artifactsDir, `graphflow-vscode-${version}.vsix`);

mkdirSync(artifactsDir, { recursive: true });

execFileSync(
  "npx",
  ["@vscode/vsce", "package", "--no-dependencies", "--out", outFile],
  { cwd: extensionRoot, stdio: "inherit", shell: process.platform === "win32" }
);

console.log(`Packaged ${outFile}`);
