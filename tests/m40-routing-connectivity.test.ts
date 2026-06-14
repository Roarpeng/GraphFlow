import { describe, expect, it } from "vitest";
import { validateSettingsForGraphIndex, validateSettingsForRouting } from "../src/surfaces/cli/runtime";

const readySettings = {
  provider: "openai",
  smartModel: "deepseek-v4-pro",
  economyModel: "deepseek-v4-flash",
  apiKeyEnvVar: "sk-test-key-12345678",
  baseUrl: "https://api.deepseek.com",
  maxContextTokens: 1200,
  layerQuota: { l1: 6, l2: 4, l3: 3 },
  enableNearLosslessMode: true,
  autoIndexOnPreview: true,
  autoIndexOnRun: true,
  autoIndexOnSave: true,
  transport: "file" as const,
  graphStorePath: "tmp/graphflow-graph.json",
  enrichmentBackend: "inherit" as const,
  enrichmentProvider: "",
  enrichmentModel: "",
  openbmbMode: "embedded" as const,
  openbmbEngine: "command" as const,
  openbmbModel: "",
  openbmbAutoDownload: false,
};

describe("M40 graph index validation", () => {
  it("allows structural graph index with only graph store path", () => {
    expect(validateSettingsForGraphIndex(readySettings)).toEqual([]);
    expect(
      validateSettingsForGraphIndex({
        ...readySettings,
        provider: "",
        apiKeyEnvVar: "",
        enableNearLosslessMode: false,
      })
    ).toEqual([]);
  });

  it("requires graph store path for structural index", () => {
    const issues = validateSettingsForGraphIndex({
      ...readySettings,
      graphStorePath: "",
    });
    expect(issues.some((issue) => issue.field === "graphStorePath")).toBe(true);
  });
});

describe("M40 routing connectivity validation", () => {
  it("accepts complete cloud LLM settings", () => {
    expect(validateSettingsForRouting(readySettings)).toEqual([]);
  });

  it("reports missing api key and feature toggles", () => {
    const issues = validateSettingsForRouting({
      ...readySettings,
      apiKeyEnvVar: "",
      enableNearLosslessMode: false,
      autoIndexOnPreview: false,
    });
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["apiKeyEnvVar", "enableNearLosslessMode", "autoIndexOnPreview"])
    );
  });

  it("requires auto index on save for routing readiness", () => {
    const issues = validateSettingsForRouting({
      ...readySettings,
      autoIndexOnSave: false,
    });
    expect(issues.some((issue) => issue.field === "autoIndexOnSave")).toBe(true);
  });

  it("requires base url for openai-compatible providers", () => {
    const issues = validateSettingsForRouting({
      ...readySettings,
      baseUrl: "",
    });
    expect(issues.some((issue) => issue.field === "baseUrl")).toBe(true);
  });
});
