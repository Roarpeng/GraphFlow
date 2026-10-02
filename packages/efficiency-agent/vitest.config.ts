import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config so the package runs with cwd = packages/efficiency-agent.
// It deliberately has no setupFiles: the root tests/helpers/setup.ts belongs to
// the GraphFlow core suite and the package must not depend on it.
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "artifacts/**", "graphflow-out/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
