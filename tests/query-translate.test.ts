import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/routing/provider-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routing/provider-executor")>();
  return { ...actual, executeRolePrompt: vi.fn() };
});

vi.mock("../src/surfaces/cli/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/surfaces/cli/runtime")>();
  return { ...actual, previewContext: vi.fn() };
});

import { executeRolePrompt } from "../src/routing/provider-executor";
import { previewContext } from "../src/surfaces/cli/runtime";
import { executeToolCall } from "../src/surfaces/mcp/tool-handlers";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";
import {
  autoTranslateQuery,
  buildQueryTranslateWorkItem,
  parseQueryTranslateReply,
} from "../src/graph/query-translate";
import { getDefaultConfig } from "../src/config/defaults";
import type { GraphFlowConfig } from "../src/config/schema";

const mockedExec = vi.mocked(executeRolePrompt);
const mockedPreview = vi.mocked(previewContext);

const CJK_QUERY = "摄像头锻炼人物角色选择和攻击护盾特效";
const TRANSLATED_QUERY = "camera exercise avatar selection attack shield effects";
const TRANSLATED_KEYWORDS = ["camera", "avatar", "shield"];

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

beforeEach(() => {
  mockedExec.mockReset();
  mockedPreview.mockReset();
});

/** Config object for direct autoTranslateQuery unit calls (no disk round-trip). */
function unitConfig(withProvider: boolean): GraphFlowConfig {
  const config = getDefaultConfig();
  config.providers = withProvider
    ? { openai: { apiKey: "sk-test-literal", baseUrl: "https://example.invalid" } }
    : {};
  config.tiers.economy.model = "econ-model-x";
  config.tiers.smart.model = "smart-model-x";
  return config;
}

/** Isolated on-disk config for handler tests (resolveConfig reads this file). */
function writeConfig(root: string, withProvider: boolean): string {
  const config = unitConfig(withProvider);
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      graphPolicy: {
        ...config.graphPolicy,
        transport: "memory",
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        workspaceRoot: root,
        embeddingProvider: "fnv",
      },
    }),
    "utf8"
  );
  return configPath;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePreview(overrides: Partial<ContextPreviewResult>): ContextPreviewResult {
  return {
    query: CJK_QUERY,
    summaryCount: 0,
    anchorCount: 0,
    tokenEstimate: 0,
    truncated: false,
    anchorsByLayer: { l1: 0, l2: 0, l3: 0 },
    refillPreview: [],
    summary: [],
    anchors: [],
    tokenBudget: {
      maxContextTokens: 1500,
      estimatedRawTokens: 0,
      compressedTokens: 0,
      estimatedSavingsPercent: 0,
      budgetUsedPercent: 0,
    },
    ...overrides,
  };
}

function bridgePreview(root: string): ContextPreviewResult {
  return makePreview({
    agentWorkItems: [buildQueryTranslateWorkItem(CJK_QUERY, root)],
    agentInstructions: "[GraphFlow CJK] Low symbol match for Chinese query.",
    agentMode: "delegated-llm",
  });
}

describe("parseQueryTranslateReply (defensive JSON parsing)", () => {
  it("parses a bare JSON object", () => {
    expect(
      parseQueryTranslateReply(
        `{"englishQuery": "${TRANSLATED_QUERY}", "keywords": ${JSON.stringify(TRANSLATED_KEYWORDS)}}`
      )
    ).toEqual({ englishQuery: TRANSLATED_QUERY, keywords: TRANSLATED_KEYWORDS });
  });

  it("parses fenced markdown JSON (```json and bare fences)", () => {
    const fenced = "```json\n" +
      `{"englishQuery": "${TRANSLATED_QUERY}", "keywords": ["shield"]}\n` +
      "```";
    expect(parseQueryTranslateReply(fenced)).toEqual({
      englishQuery: TRANSLATED_QUERY,
      keywords: ["shield"],
    });
    const bareFence = "```\n" +
      `{"englishQuery": "battle page", "keywords": ["battle"]}\n` +
      "```";
    expect(parseQueryTranslateReply(bareFence)).toEqual({
      englishQuery: "battle page",
      keywords: ["battle"],
    });
  });

  it("parses a JSON object surrounded by prose", () => {
    const noisy = `Sure! Here is the translation:\n{"englishQuery": "pose detection page", "keywords": ["pose"]}\nHope that helps.`;
    expect(parseQueryTranslateReply(noisy)).toEqual({
      englishQuery: "pose detection page",
      keywords: ["pose"],
    });
  });

  it("derives keywords from englishQuery when keywords is missing or malformed", () => {
    expect(parseQueryTranslateReply(`{"englishQuery": "battle page shield"}`)).toEqual({
      englishQuery: "battle page shield",
      keywords: ["battle", "page", "shield"],
    });
    expect(
      parseQueryTranslateReply(`{"englishQuery": "battle page", "keywords": ["ok", 42, null, "  "]}`)
    ).toEqual({ englishQuery: "battle page", keywords: ["ok"] });
  });

  it("returns null for empty englishQuery, non-JSON, or empty input", () => {
    expect(parseQueryTranslateReply(`{"englishQuery": "  ", "keywords": ["x"]}`)).toBeNull();
    expect(parseQueryTranslateReply("no json here at all")).toBeNull();
    expect(parseQueryTranslateReply("   ")).toBeNull();
    expect(parseQueryTranslateReply(`{"keywords": ["x"]}`)).toBeNull();
  });
});

describe("autoTranslateQuery (local economy-tier translation)", () => {
  it("executes the shared prompt on the economy tier and parses the reply", async () => {
    mockedExec.mockResolvedValue(
      `{"englishQuery": "${TRANSLATED_QUERY}", "keywords": ${JSON.stringify(TRANSLATED_KEYWORDS)}}`
    );

    const result = await autoTranslateQuery(CJK_QUERY, { config: unitConfig(true) });

    expect(result).toEqual({
      englishQuery: TRANSLATED_QUERY,
      keywords: TRANSLATED_KEYWORDS,
    });
    expect(mockedExec).toHaveBeenCalledTimes(1);
    const [role, prompt, selection, , signal, opts] = mockedExec.mock.calls[0]!;
    // Economy tier, never the smart tier — assert on the actual selection.
    expect(role).toBe("planner");
    expect(selection.tier).toBe("economy");
    expect(selection.model).toBe("econ-model-x");
    expect(selection.model).not.toBe("smart-model-x");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(opts?.disableTools).toBe(true);
    // Prompt reuse: the direct call carries the SAME shared instruction text
    // the bridge work item hands the host agent — the two cannot drift.
    const bridgePrompt = buildQueryTranslateWorkItem(CJK_QUERY).prompt;
    expect(prompt).toContain("translate the user's intent into English CODE SEARCH terms");
    expect(prompt).toContain(`Original query: ${CJK_QUERY}`);
    for (const sharedLine of [
      "Prefer exact file/class/function/component names",
      "Return ONLY a JSON object (no markdown fences):",
      '"englishQuery": "space separated english keywords for graph search"',
    ]) {
      expect(prompt).toContain(sharedLine);
      expect(bridgePrompt).toContain(sharedLine);
    }
  });

  it("returns null without a usable provider (and never calls the executor)", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    try {
      const result = await autoTranslateQuery(CJK_QUERY, { config: unitConfig(false) });
      expect(result).toBeNull();
      expect(mockedExec).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null on provider error instead of throwing", async () => {
    mockedExec.mockRejectedValue(new Error("provider exploded"));
    await expect(autoTranslateQuery(CJK_QUERY, { config: unitConfig(true) })).resolves.toBeNull();
  });

  it("returns null when the reply is unparseable", async () => {
    mockedExec.mockResolvedValue("I cannot help with that.");
    await expect(autoTranslateQuery(CJK_QUERY, { config: unitConfig(true) })).resolves.toBeNull();
  });

  it("returns null on timeout (hard wall-clock cap, default ~15s)", async () => {
    mockedExec.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("never in time"), 2_000))
    );
    const started = Date.now();
    await expect(
      autoTranslateQuery(CJK_QUERY, { config: unitConfig(true), timeoutMs: 50 })
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("accepts fenced markdown JSON from the provider", async () => {
    mockedExec.mockResolvedValue(
      "```json\n" + `{"englishQuery": "battle page", "keywords": ["battle", "page"]}` + "\n```"
    );
    await expect(autoTranslateQuery(CJK_QUERY, { config: unitConfig(true) })).resolves.toEqual({
      englishQuery: "battle page",
      keywords: ["battle", "page"],
    });
  });

  it("returns null for an empty task", async () => {
    await expect(autoTranslateQuery("   ", { config: unitConfig(true) })).resolves.toBeNull();
    expect(mockedExec).not.toHaveBeenCalled();
  });
});

describe("graphflow_context query-translate auto-retry loop", () => {
  it("rebuilds once with englishQuery when a provider is configured", async () => {
    const root = tempRoot("gf-qtr-ok-");
    const configPath = writeConfig(root, true);
    const rebuilt = makePreview({
      englishQuery: TRANSLATED_QUERY,
      anchors: [{ id: "file:src/pages/BattlePage.tsx", type: "File", layer: "L1" }],
    });
    mockedPreview
      .mockResolvedValueOnce(bridgePreview(root))
      .mockResolvedValueOnce(rebuilt);
    mockedExec.mockResolvedValue(
      `{"englishQuery": "${TRANSLATED_QUERY}", "keywords": ${JSON.stringify(TRANSLATED_KEYWORDS)}}`
    );

    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: {
        query: CJK_QUERY,
        configPath,
        rootDir: root,
        sessionId: "sess-qtr",
        contextPressure: { usedTokens: 1000, maxTokens: 200000 },
      },
    });

    // Exactly one retry, never a loop.
    expect(mockedPreview).toHaveBeenCalledTimes(2);
    expect(mockedExec).toHaveBeenCalledTimes(1);

    const firstCall = mockedPreview.mock.calls[0]!;
    const retryCall = mockedPreview.mock.calls[1]!;
    // Same query + budget plumbing on the rebuild; only englishQuery is added.
    expect(retryCall[0]).toBe(CJK_QUERY);
    expect(retryCall[0]).toBe(firstCall[0]);
    expect(retryCall[1]).toBe(firstCall[1]);
    expect(retryCall[2]).toBe(firstCall[2]);
    expect(retryCall[3]).toBe(TRANSLATED_QUERY);
    expect(firstCall[3]).toBeUndefined();
    expect(retryCall[4]).toEqual(firstCall[4]); // dialogue options identical
    expect(retryCall[5]).toEqual(firstCall[5]); // observed pressure identical

    const structured = response.structuredContent as Record<string, unknown>;
    // Transparency payload.
    expect(structured.queryTranslation).toEqual({
      englishQuery: TRANSLATED_QUERY,
      keywords: TRANSLATED_KEYWORDS,
      tier: "economy",
    });
    // The rebuilt package replaced the bridge: no work item, auto note instead.
    expect(structured.agentWorkItems).toBeUndefined();
    expect(String(structured.agentInstructions)).toContain("Auto-translated query (economy tier)");
    expect(structured.englishQuery).toBe(TRANSLATED_QUERY);
    // Economy tier was selected for the utility call, not smart.
    const selection = mockedExec.mock.calls[0]![2];
    expect(selection.tier).toBe("economy");
    expect(selection.model).toBe("econ-model-x");
    // The stable-face text copy defers volatile fields: the translation fact
    // lives in structuredContent only.
    const textParsed = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(textParsed.queryTranslation).toBeUndefined();
  });

  it("keeps the bridge work item when no LLM provider is configured", async () => {
    const root = tempRoot("gf-qtr-noprov-");
    const configPath = writeConfig(root, false);
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    mockedPreview.mockResolvedValue(bridgePreview(root));

    try {
      const response = await executeToolCall({
        name: "graphflow_context",
        arguments: { query: CJK_QUERY, configPath, rootDir: root },
      });

      // Existing behavior unchanged: one build, bridge item delivered.
      expect(mockedPreview).toHaveBeenCalledTimes(1);
      expect(mockedExec).not.toHaveBeenCalled();
      const structured = response.structuredContent as Record<string, unknown>;
      expect(
        (structured.agentWorkItems as Array<{ id: string }>)?.map((item) => item.id)
      ).toContain("query-translate-en");
      expect(structured.queryTranslation).toEqual({ skipped: "no-llm-provider" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the bridge work item when the local translation fails to parse", async () => {
    const root = tempRoot("gf-qtr-badreply-");
    const configPath = writeConfig(root, true);
    const bridged = bridgePreview(root);
    mockedPreview.mockResolvedValue(bridged);
    mockedExec.mockResolvedValue("totally not json");

    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { query: CJK_QUERY, configPath, rootDir: root },
    });

    expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(mockedExec).toHaveBeenCalledTimes(1);
    const structured = response.structuredContent as Record<string, unknown>;
    expect(
      (structured.agentWorkItems as Array<{ id: string }>)?.map((item) => item.id)
    ).toContain("query-translate-en");
    expect(structured.queryTranslation).toEqual({ skipped: "auto-translate-failed" });
    // The handler still returned a package (never throws on translation failure).
    expect(structured.query).toBe(CJK_QUERY);
  });

  it("does not retry when the first package carries no bridge work item", async () => {
    const root = tempRoot("gf-qtr-noBridge-");
    const configPath = writeConfig(root, true);
    mockedPreview.mockResolvedValue(makePreview({ anchorCount: 5 }));

    const response = await executeToolCall({
      name: "graphflow_context",
      arguments: { query: CJK_QUERY, configPath, rootDir: root },
    });

    expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(mockedExec).not.toHaveBeenCalled();
    const structured = response.structuredContent as Record<string, unknown>;
    expect(structured.queryTranslation).toBeUndefined();
  });

  it("does not retry when the caller already supplied englishQuery", async () => {
    const root = tempRoot("gf-qtr-explicit-");
    const configPath = writeConfig(root, true);
    mockedPreview.mockResolvedValue(makePreview({ englishQuery: "explicit query" }));

    await executeToolCall({
      name: "graphflow_context",
      arguments: { query: CJK_QUERY, englishQuery: "explicit query", configPath, rootDir: root },
    });

    expect(mockedPreview).toHaveBeenCalledTimes(1);
    // The single build was threaded with the caller's englishQuery.
    expect(mockedPreview.mock.calls[0]![3]).toBe("explicit query");
    expect(mockedExec).not.toHaveBeenCalled();
  });
});
