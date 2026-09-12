import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFICIENCY_POLICY,
  resolveEfficiencyPolicy,
  toObservationPolicy,
} from "../src/config/resolve";
import { getDefaultConfig } from "../src/config/defaults";
import { validateConfig } from "../src/config/loader";

describe("resolveEfficiencyPolicy", () => {
  it("enables every mechanism by default (best config)", () => {
    const policy = resolveEfficiencyPolicy(undefined);
    expect(policy).toEqual(DEFAULT_EFFICIENCY_POLICY);
    expect(policy.observations.enabled).toBe(true);
    expect(policy.observations.reduce.enabled).toBe(true);
    expect(policy.contextPressure.enabled).toBe(true);
    expect(policy.actionFusion.enabled).toBe(true);
  });

  it("ships the default config with every mechanism on", () => {
    const policy = resolveEfficiencyPolicy(getDefaultConfig());
    expect(policy.observations.enabled).toBe(true);
    expect(policy.contextPressure.enabled).toBe(true);
    expect(policy.actionFusion.enabled).toBe(true);
  });

  it("honors an explicit per-mechanism disable", () => {
    const policy = resolveEfficiencyPolicy({
      efficiencyPolicy: {
        observations: { enabled: false },
        actionFusion: { enabled: false },
      },
    });
    expect(policy.observations.enabled).toBe(false);
    expect(policy.actionFusion.enabled).toBe(false);
    expect(policy.contextPressure.enabled).toBe(true);
  });

  it("defaults contextPressure.maxContextTokens to auto and accepts a pinned number", () => {
    expect(resolveEfficiencyPolicy({}).contextPressure.maxContextTokens).toBe("auto");
    expect(
      resolveEfficiencyPolicy({ efficiencyPolicy: { contextPressure: { enabled: true } } })
        .contextPressure.maxContextTokens
    ).toBe("auto");
    expect(
      resolveEfficiencyPolicy({ efficiencyPolicy: { contextPressure: { maxContextTokens: 900 } } })
        .contextPressure.maxContextTokens
    ).toBe(900);
  });

  it("downgrades an llm reducer without provider+model to fingerprint", () => {
    const noRoute = resolveEfficiencyPolicy({
      efficiencyPolicy: { observations: { reduce: { enabled: true, strategy: "llm" } } },
    }).observations.reduce;
    expect(noRoute.strategy).toBe("fingerprint");
    expect(noRoute.provider).toBeUndefined();

    const withRoute = resolveEfficiencyPolicy({
      efficiencyPolicy: {
        observations: { reduce: { enabled: true, strategy: "llm", provider: "deepseek", model: "deepseek-chat" } },
      },
    }).observations.reduce;
    expect(withRoute.strategy).toBe("llm");
    expect(withRoute.provider).toBe("deepseek");
    expect(withRoute.model).toBe("deepseek-chat");
  });

  it("clamps invalid numeric knobs to safe defaults", () => {
    const policy = resolveEfficiencyPolicy({
      efficiencyPolicy: {
        contextPressure: { cacheWriteReadRatio: -1, minSavingRatio: 5 },
        observations: { headBytes: 0, ttlDays: -3 },
      },
    });
    expect(policy.contextPressure.cacheWriteReadRatio).toBe(12.5);
    expect(policy.contextPressure.minSavingRatio).toBe(1);
    expect(policy.observations.headBytes).toBe(2048);
    expect(policy.observations.ttlDays).toBe(14);
  });

  it("projects onto the observation store policy shape", () => {
    const policy = resolveEfficiencyPolicy({
      efficiencyPolicy: {
        observations: {
          enabled: true,
          inlineThresholdBytes: 4096,
          redactOnStore: false,
          reduce: { enabled: true, maxReceiptTokens: 120 },
        },
      },
    });
    const observationPolicy = toObservationPolicy(policy);
    expect(observationPolicy.enabled).toBe(true);
    expect(observationPolicy.inlineThresholdBytes).toBe(4096);
    expect(observationPolicy.redactOnStore).toBe(false);
    expect(observationPolicy.reduce?.enabled).toBe(true);
    expect(observationPolicy.reduce?.maxReceiptTokens).toBe(120);
    expect(observationPolicy.reduce?.strategy).toBe("fingerprint");
  });
});

describe("efficiencyPolicy config validation", () => {
  it("accepts an explicit all-enabled section", () => {
    const config = validateConfig({
      ...getDefaultConfig(),
      efficiencyPolicy: {
        observations: { enabled: true, reduce: { enabled: true, strategy: "llm", provider: "deepseek", model: "m" } },
        contextPressure: { enabled: true, maxContextTokens: "auto", cacheWriteReadRatio: 12.5 },
        actionFusion: { enabled: true },
      },
    });
    const resolved = resolveEfficiencyPolicy(config);
    expect(resolved.observations.enabled).toBe(true);
    expect(resolved.observations.reduce.strategy).toBe("llm");
    expect(resolved.contextPressure.enabled).toBe(true);
    expect(resolved.actionFusion.enabled).toBe(true);
  });

  it("rejects an invalid cacheWriteReadRatio", () => {
    expect(() =>
      validateConfig({
        ...getDefaultConfig(),
        efficiencyPolicy: { contextPressure: { cacheWriteReadRatio: -1 } },
      })
    ).toThrow(/cacheWriteReadRatio/);
  });

  it('rejects a maxContextTokens that is neither positive nor "auto"', () => {
    expect(() =>
      validateConfig({
        ...getDefaultConfig(),
        efficiencyPolicy: { contextPressure: { maxContextTokens: 0 } },
      })
    ).toThrow(/maxContextTokens/);
  });

  it("rejects an out-of-range minSavingRatio", () => {
    expect(() =>
      validateConfig({
        ...getDefaultConfig(),
        efficiencyPolicy: { contextPressure: { minSavingRatio: 1.5 } },
      })
    ).toThrow(/minSavingRatio/);
  });
});
