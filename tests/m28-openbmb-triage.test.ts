import { describe, expect, it } from "vitest";
import { openbmbGenerateText } from "../src/routing/provider-adapters/openbmb";
import { resolveModelWithFallback } from "../src/routing/model-router";
import { triageTaskLlm } from "../src/core/triage";

describe("OpenBMB 1B Triage & Integration", () => {
  it("openbmbGenerateText adapter returns expected format", async () => {
    const res = await openbmbGenerateText({ prompt: "hello", model: "minicpm-1b" });
    expect(res).toBe("[openbmb:minicpm-1b] hello");
  });

  it("model-router resolves openbmb and fallback priority", () => {
    const fallback = resolveModelWithFallback("planner", { openbmb: true, openai: false, anthropic: false, bailian: false, doubao: false }, ["openbmb"]);
    expect(fallback.provider).toBe("openbmb");
    expect(fallback.model).toBe("minicpm5-1b");
  });

  it("triageTaskLlm classifies task-1 simple successfully", async () => {
    const selection = { provider: "openbmb" as const, model: "minicpm-1b", tier: "economy" as const, fallbackApplied: false };
    const res = await triageTaskLlm("print hello world", selection);
    expect(res).toBe("simple");
  });

  it("triageTaskLlm classifies task-2 complex successfully due to prompt output", async () => {
    const selection = { provider: "openbmb" as const, model: "minicpm-1b", tier: "economy" as const, fallbackApplied: false };
    // 由于在 provider-executor 中，执行返回 "[openbmb:minicpm-1b] [role:planner] ... complex"
    // 其内包含 "complex"，因此会被解析成 complex
    const res = await triageTaskLlm("Refactor architecture and database module", selection);
    expect(res).toBe("complex");
  });

  it("triageTaskLlm falls back to heuristic rule when provider throws error", async () => {
    // 强制传一个会抛错的配置（如 null/undefined 驱动）来验证优雅降级
    const selection = { provider: "invalid-provider" as any, model: "minicpm-1b", tier: "economy" as const, fallbackApplied: false };
    const res = await triageTaskLlm("Refactor module A and update module B", selection);
    expect(res).toBe("complex"); // 启发式规则判定为 complex
  });
});
