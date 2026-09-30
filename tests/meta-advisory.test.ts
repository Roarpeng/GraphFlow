import { describe, expect, it, vi } from "vitest";
import {
  type AdvisoryInput,
  evaluateMetaAdvisory,
  isGrayZoneSimilarity,
  type MetaReflector,
  SIMILARITY_FAST_PATH_HIGH,
  SIMILARITY_FAST_PATH_LOW,
} from "../src/core/efficiency-advisory.js";

function makeInput(overrides: Partial<AdvisoryInput> = {}): AdvisoryInput {
  return {
    task: "优化机械臂回零动作参数并校验 build",
    taskComplexity: "simple",
    executionMode: "bridge",
    durationMs: 2,
    similarEpisodes: [],
    ...overrides,
  };
}

describe("Layer B Meta-Advisory Engine (HTML §4)", () => {
  describe("Gray-zone boundary checks", () => {
    it("correctly identifies gray zone boundaries (0.3 <= similarity <= 0.7)", () => {
      expect(isGrayZoneSimilarity(undefined)).toBe(false);
      expect(isGrayZoneSimilarity(Number.NaN)).toBe(false);
      expect(isGrayZoneSimilarity(0.1)).toBe(false);
      expect(isGrayZoneSimilarity(0.29)).toBe(false);
      expect(isGrayZoneSimilarity(0.3)).toBe(true);
      expect(isGrayZoneSimilarity(0.5)).toBe(true);
      expect(isGrayZoneSimilarity(0.7)).toBe(true);
      expect(isGrayZoneSimilarity(0.71)).toBe(false);
      expect(isGrayZoneSimilarity(0.95)).toBe(false);
      expect(SIMILARITY_FAST_PATH_LOW).toBe(0.3);
      expect(SIMILARITY_FAST_PATH_HIGH).toBe(0.7);
    });
  });

  describe("High confidence fast-path (>0.7 or <0.3)", () => {
    it("routes high similarity (>0.7) to deterministic Layer A without LLM calls", async () => {
      const reflector = vi.fn();
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-1", task: "优化机械臂回零动作参数", score: 0.9, similarity: 0.85 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(advisory.reuseMode).toBe("ADAPT");
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(reflector).not.toHaveBeenCalled();
    });

    it("routes low similarity (<0.3) to deterministic Layer A without LLM calls", async () => {
      const reflector = vi.fn();
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-2", task: "完全无关的任务日志导出", score: 0.2, similarity: 0.15 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(advisory.reuseMode).toBe("FRESH");
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(reflector).not.toHaveBeenCalled();
    });

    it("routes episodes without similarity signal to Layer A", async () => {
      const reflector = vi.fn();
      const input = makeInput({
        similarEpisodes: [{ id: "ep-3", task: "旧版任务无相似度", score: 0.6 }],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(advisory.reuseMode).toBe("ADAPT"); // Legacy score-based
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(reflector).not.toHaveBeenCalled();
    });
  });

  describe("Gray zone decision (0.3 ~ 0.7 similarity)", () => {
    it("calls lightweight economy model for meta-reflection and adopts verdict", async () => {
      const reflector: MetaReflector = vi.fn().mockResolvedValue({
        reuseMode: "FRESH",
        confidence: 0.88,
        suggestedTier: "standard",
        reasoning: "Task parameters changed safety bounds; full re-plan required.",
      });

      const input = makeInput({
        similarEpisodes: [
          { id: "ep-4", task: "优化机械臂微调参数", score: 0.8, similarity: 0.55 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(reflector).toHaveBeenCalledTimes(1);
      expect(advisory.reuseMode).toBe("FRESH");
      expect(advisory.confidence).toBe(0.88);
      expect(advisory.worker.modelTier).toBe("standard");
      expect(advisory.decision.provenance).toBe("llm");
      expect(advisory.decision.llmCalls).toBe(1);
      expect(advisory.decision.metaReflection?.fallback).toBe(false);
      expect(advisory.decision.metaReflection?.reasoning).toContain("Task parameters changed");
    });

    it("supports bypassMetaReflection option to force Layer A in gray zone", async () => {
      const reflector = vi.fn();
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-5", task: "优化参数", score: 0.8, similarity: 0.6 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, {
        metaReflector: reflector,
        bypassMetaReflection: true,
      });

      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(reflector).not.toHaveBeenCalled();
    });
  });

  describe("Smooth degradation and missing model fallback", () => {
    it("gracefully falls back to Layer A when no metaReflector is provided", async () => {
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-6", task: "模糊匹配", score: 0.5, similarity: 0.5 },
        ],
      });

      // No metaReflector option provided
      const advisory = await evaluateMetaAdvisory(input);
      expect(advisory.reuseMode).toBe("ADAPT");
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(advisory.decision.metaReflection?.fallback).toBe(true);
      expect(advisory.decision.metaReflection?.reasoning).toContain("no metaReflector provided");
    });

    it("gracefully falls back to Layer A when metaReflector returns undefined/null", async () => {
      const reflector = vi.fn().mockResolvedValue(null);
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-7", task: "模糊匹配空结果", score: 0.5, similarity: 0.45 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(reflector).toHaveBeenCalledTimes(1);
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(advisory.decision.metaReflection?.fallback).toBe(true);
      expect(advisory.decision.metaReflection?.reasoning).toContain("returned empty verdict");
    });

    it("gracefully catches reflector exceptions and falls back without throwing", async () => {
      const reflector = vi.fn().mockRejectedValue(new Error("LLM provider rate limit exceeded (429)"));
      const input = makeInput({
        similarEpisodes: [
          { id: "ep-8", task: "模糊匹配异常", score: 0.5, similarity: 0.4 },
        ],
      });

      const advisory = await evaluateMetaAdvisory(input, { metaReflector: reflector });
      expect(reflector).toHaveBeenCalledTimes(1);
      expect(advisory.decision.provenance).toBe("deterministic");
      expect(advisory.decision.llmCalls).toBe(0);
      expect(advisory.decision.metaReflection?.fallback).toBe(true);
      expect(advisory.decision.metaReflection?.reasoning).toContain("LLM provider rate limit exceeded");
    });
  });
});
