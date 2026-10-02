import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";

// The indexer loads the compiler through a REAL require: `createRequire(__filename)("typescript")`.
// vi.mock("typescript") never intercepts that path, so we intercept node:module
// instead: the "typescript" id routes to a controllable stub, every other id
// delegates to the real require (selfcheck's import graph uses createRequire
// for gpt-tokenizer/sqlite/transformers too — those must keep working).
const { tsRequire } = vi.hoisted(() => ({ tsRequire: vi.fn() }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (filename: string) => {
      const realRequire = actual.createRequire(filename);
      return (id: string) => {
        if (id === "typescript") return tsRequire(id);
        return realRequire(id);
      };
    },
  };
});

// The indexer memoizes its backend decision at module scope; resetModules +
// dynamic import give each test a fresh instance in the wanted state.
async function importIndexer() {
  return import("../src/graph/language-indexers/typescript");
}

function writeTempConfig(providers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-ts-indexer-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...getDefaultConfig(),
        providers,
        graphPolicy: {
          ...getDefaultConfig().graphPolicy,
          workspaceRoot: root,
          transport: "memory" as const,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          embeddingProvider: "fnv" as const,
        },
        embeddingPolicy: { ...getDefaultConfig().embeddingPolicy, provider: "hash" as const },
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

describe("getTypescriptBackendStatus", () => {
  beforeEach(() => {
    tsRequire.mockReset();
    vi.resetModules();
  });

  it("reports 'compiler' once the optional typescript package resolves (memoized, required once)", async () => {
    tsRequire.mockImplementation(() => ({ version: "6.0.3-fake", ScriptKind: {}, ScriptTarget: {} }));
    const { getTypescriptBackendStatus } = await importIndexer();
    expect(getTypescriptBackendStatus()).toBe("compiler");
    // The require is attempted at most once per process, even across calls.
    getTypescriptBackendStatus();
    getTypescriptBackendStatus();
    expect(tsRequire).toHaveBeenCalledTimes(1);
  });

  it("reports 'regex' when the optional typescript package is missing (the silent fallback)", async () => {
    tsRequire.mockImplementation(() => {
      throw new Error("Cannot find module 'typescript'");
    });
    const { getTypescriptBackendStatus } = await importIndexer();
    expect(getTypescriptBackendStatus()).toBe("regex");
  });

  it("only ever returns one of the two documented values", async () => {
    const { getTypescriptBackendStatus } = await importIndexer();
    expect(["compiler", "regex"]).toContain(getTypescriptBackendStatus());
  });
});

describe("selfcheck ts-indexer item exposes the fallback", () => {
  beforeEach(() => {
    tsRequire.mockReset();
    vi.resetModules();
  });

  it("compiler backend: ts-indexer is ok and names the TypeScript compiler", async () => {
    tsRequire.mockImplementation(() => ({ version: "6.0.3-fake" }));
    const { runSelfcheck } = await import("../src/surfaces/cli/runtime/selfcheck");
    const configPath = writeTempConfig({});
    try {
      const result = await runSelfcheck(configPath);
      const tsItem = result.items.find((i) => i.name === "ts-indexer");
      expect(tsItem?.status).toBe("ok");
      expect(tsItem?.detail).toContain("TypeScript compiler");
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });

  it("regex fallback: ts-indexer warns that AST features are degraded", async () => {
    tsRequire.mockImplementation(() => {
      throw new Error("Cannot find module 'typescript'");
    });
    const { runSelfcheck } = await import("../src/surfaces/cli/runtime/selfcheck");
    const configPath = writeTempConfig({});
    try {
      const result = await runSelfcheck(configPath);
      const tsItem = result.items.find((i) => i.name === "ts-indexer");
      expect(tsItem?.status).toBe("warn");
      expect(tsItem?.detail).toContain("REGEX");
      expect(tsItem?.detail).toContain("typescript");
      // A warn must not flip the overall verdict (only failures do).
      expect(result.summary.warn).toBeGreaterThanOrEqual(1);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });
});
