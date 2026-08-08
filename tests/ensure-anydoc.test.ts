import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ANYDOC_PINNED_VERSION,
  applyAnydocRequireEnv,
  ensureAnydocInstalled,
  isAnydocPresent,
  resolveAnydocNodeModules,
  resolveAnydocOptionalDepsRoot,
} from "../src/integrations/ensure-anydoc";

describe("ensure-anydoc", () => {
  it("resolves optional-deps under ~/.graphflow", () => {
    const home = "/tmp/gf-home-test";
    expect(resolveAnydocOptionalDepsRoot(home)).toBe(join(home, ".graphflow", "optional-deps"));
    expect(resolveAnydocNodeModules(home)).toBe(
      join(home, ".graphflow", "optional-deps", "node_modules")
    );
  });

  it("skips when disabled", async () => {
    const result = await ensureAnydocInstalled({ enabled: false });
    expect(result.status).toBe("skipped");
  });

  it("installs via inject into a custom home when not otherwise resolvable", async () => {
    const home = mkdtempSync(join(tmpdir(), "gf-anydoc-home-"));
    const prevEnv = process.env.GRAPHFLOW_ANYDOC_NODE_MODULES;
    delete process.env.GRAPHFLOW_ANYDOC_NODE_MODULES;
    try {
      let installed = false;
      const result = await ensureAnydocInstalled({
        enabled: true,
        home,
        version: ANYDOC_PINNED_VERSION,
        installFn: async (depsRoot, version) => {
          installed = true;
          const pkgDir = join(depsRoot, "node_modules", "@firecrawl", "anydoc");
          mkdirSync(pkgDir, { recursive: true });
          writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: "@firecrawl/anydoc", version, main: "index.js" }),
            "utf8"
          );
          writeFileSync(
            join(pkgDir, "index.js"),
            "module.exports = { toMarkdown: async () => '# x' };\n",
            "utf8"
          );
        },
      });

      if (result.status === "already") {
        // Machine already has anydoc on NODE_PATH / npm root — inject skipped by design.
        expect(installed).toBe(false);
        return;
      }

      expect(installed).toBe(true);
      expect(result.status).toBe("installed");
      expect(isAnydocPresent(resolveAnydocNodeModules(home))).toBe(true);
      expect(applyAnydocRequireEnv(resolveAnydocNodeModules(home))).toBe(true);
      expect(process.env.GRAPHFLOW_ANYDOC_NODE_MODULES).toBe(resolveAnydocNodeModules(home));
      expect(existsSync(join(resolveAnydocOptionalDepsRoot(home), ".anydoc-version"))).toBe(true);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.GRAPHFLOW_ANYDOC_NODE_MODULES;
      } else {
        process.env.GRAPHFLOW_ANYDOC_NODE_MODULES = prevEnv;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
