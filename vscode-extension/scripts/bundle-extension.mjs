import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");

await esbuild.build({
  entryPoints: [join(extensionRoot, "src", "extension.ts")],
  bundle: true,
  outfile: join(extensionRoot, "dist", "extension.js"),
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

console.log("[bundle-extension] wrote dist/extension.js");
