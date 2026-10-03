import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, validateConfigDetailed } from "../src/config/loader";
import { buildFallbackChain } from "../src/routing/provider-health";
import { resolveConfig } from "../src/config/resolve";
import { getDefaultConfig } from "../src/config/defaults";

/**
 * providerPriority is open-ended: the five built-in adapters PLUS any key
 * configured under `providers` (custom OpenAI-compatible endpoints). The
 * closed five-name enum bricked whole workspaces under the project-layer
 * fail-fast (live: an Ele workspace with an openbmb localhost endpoint in
 * its priority list could not load its config at all).
 */
function baseConfig(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "x" },
      economy: { provider: "openai", model: "x" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: { transport: "file" },
    ...extra,
  };
}

describe("providerPriority accepts configured custom providers", () => {
  it("a priority entry that is a configured provider key validates (live regression)", () => {
    const config = validateConfig(
      baseConfig({
        providers: {
          openbmb: { mode: "openai-compat", baseUrl: "http://localhost:8000" },
        },
        routingPolicy: {
          providerPriority: ["openai", "anthropic", "bailian", "doubao", "openbmb"],
        },
      }) as never
    );
    expect(config.routingPolicy?.providerPriority).toContain("openbmb");
  });

  it("a priority entry that is neither built-in nor configured still fails — with the name in the error", () => {
    expect(() =>
      validateConfig(
        baseConfig({
          routingPolicy: { providerPriority: ["openai", "nonexistent"] },
        }) as never
      )
    ).toThrow(/nonexistent/);
    expect(() =>
      validateConfig(
        baseConfig({
          routingPolicy: { providerPriority: ["openai", "nonexistent"] },
        }) as never
      )
    ).toThrow(/built-in/);
  });

  it("config validate (detailed) reports the unknown names instead of a generic string", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-prio-"));
    const path = join(root, "graphflow.config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify(
          baseConfig({
            providers: { mylocal: { mode: "openai-compat", baseUrl: "http://127.0.0.1:9" } },
            routingPolicy: { providerPriority: ["mylocal", "ghost"] },
          })
        ),
        "utf8"
      );
      const result = validateConfigDetailed(path);
      const issue = result.issues.find((i) => i.field === "routingPolicy.providerPriority");
      // mylocal is configured -> accepted; ghost is not -> named in the issue.
      expect(issue?.message).toContain("ghost");
      expect(issue?.message).not.toContain("mylocal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveConfig loads a project layer whose priority lists a custom provider (no fail-fast)", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-prio-resolve-"));
    const path = join(root, "graphflow.config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify(
          baseConfig({
            providers: { openbmb: { mode: "openai-compat", baseUrl: "http://localhost:8000" } },
            routingPolicy: {
              providerPriority: ["openai", "anthropic", "bailian", "doubao", "openbmb"],
            },
          })
        ),
        "utf8"
      );
      const config = resolveConfig(path);
      expect(config.routingPolicy?.providerPriority).toContain("openbmb");
      // The fallback chain carries the custom name through.
      expect(buildFallbackChain(config)).toContain("openbmb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("built-in-only priorities and the default chain are unchanged", () => {
    const config = validateConfig(
      baseConfig({ routingPolicy: { providerPriority: ["deepseek", "openai"] } }) as never
    );
    expect(buildFallbackChain(config).slice(0, 2)).toEqual(["deepseek", "openai"]);
    expect(buildFallbackChain(getDefaultConfig()).slice(0, 2)).toEqual(["openai", "deepseek"]);
  });
});
