/**
 * Smoke-test that the bundled vendor runtime can resolve MCP SDK imports.
 * Catches packaging regressions like MODULE_NOT_FOUND for
 * `@modelcontextprotocol/sdk/server/index.js`.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const vendorRoot = join(extensionRoot, "vendor", "graphflow");
const serverPath = join(vendorRoot, "dist", "surfaces", "mcp", "server.js");
const sdkEntry = join(
  vendorRoot,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "cjs",
  "server",
  "index.js",
);

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

if (!existsSync(serverPath)) {
  fail(`MCP server missing: ${serverPath}`);
} else {
  console.log(`[PASS] MCP server present: ${serverPath}`);
}

if (!existsSync(sdkEntry)) {
  // Fall back to package exports resolution via createRequire from vendor.
  const requireFromVendor = createRequire(join(vendorRoot, "package.json"));
  try {
    const resolved = requireFromVendor.resolve("@modelcontextprotocol/sdk/server/index.js");
    console.log(`[PASS] MCP SDK resolve: ${resolved}`);
  } catch (err) {
    fail(
      `Cannot resolve @modelcontextprotocol/sdk/server/index.js from vendor: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
} else {
  console.log(`[PASS] MCP SDK entry present: ${sdkEntry}`);
}

// Require the compiled server module without starting stdio (import side effects
 // construct Server but do not listen until main). Use a child so a hard crash
 // cannot take down the parent test harness.
const probe = `
const path = ${JSON.stringify(serverPath)};
try {
  require(path);
  // Server module may call main() when GRAPHFLOW_MCP_STDIO is set; ensure unset.
  process.stdout.write("ok\\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\\n");
  process.exit(1);
}
`;

const result = spawnSync(process.execPath, ["-e", probe], {
  cwd: vendorRoot,
  env: {
    ...process.env,
    GRAPHFLOW_MCP_STDIO: "",
    GRAPHFLOW_LOG_JSON: "1",
  },
  encoding: "utf8",
  timeout: 15_000,
});

if (result.status !== 0) {
  fail(
    `requiring MCP server from vendor failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
  );
} else {
  console.log("[PASS] vendor MCP server module loads without MODULE_NOT_FOUND");
}

if (!process.exitCode) {
  console.log("\nAll MCP vendor checks passed.");
}
