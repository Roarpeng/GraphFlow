import { describe, expect, it } from "vitest";
import {
  deriveTurnSummary,
  deriveTurnTitle,
  distillTurnHeuristic,
  distillTurnWithLlm,
  isDecisionTurn,
} from "../src/learning/turn-distillation";

describe("turn distillation LLM path (Conversation Graph W1b)", () => {
  it("keeps the existing heuristic titles/summaries intact", () => {
    expect(deriveTurnTitle("帮我看看这个报错怎么解决")).toBe("这个报错怎么解决");
    expect(deriveTurnSummary("前置说明。\n因此，默认是 sqlite。")).toContain("因此");
  });

  it("heuristics now also expose decisionTurn classification", () => {
    const plain = distillTurnHeuristic("什么是 FTS5", "FTS5 是 SQLite 的全文索引扩展。");
    expect(plain.source).toBe("heuristic");
    expect(plain.decisionTurn).toBe(false);

    const decision = distillTurnHeuristic(
      "选 file 还是 sqlite",
      "建议用 sqlite：FTS5 支持、并发友好。"
    );
    expect(decision.decisionTurn).toBe(true);
    expect(isDecisionTurn("选哪个", "推荐 A 方案")).toBe(true);
  });

  it("uses the LLM output when the generator answers in the labeled format", async () => {
    const generate = async () =>
      "Title: MCP 默认传输\nSummary: 更正：默认 transport 是 auto，sqlite 优先。\nDecision: yes";
    const result = await distillTurnWithLlm(
      "graphflow 的 MCP 传输默认是什么",
      "更正：graphPolicy.transport 默认 auto，sqlite 优先、file 回退。",
      generate
    );
    expect(result.source).toBe("llm");
    expect(result.title).toContain("MCP 默认传输");
    expect(result.summary).toContain("auto");
    expect(result.decisionTurn).toBe(true);
  });

  it("falls back to the heuristic when the generator is missing, throws, or answers garbage", async () => {
    const query = "graphflow 的 MCP 传输默认是什么";
    const reply = "因此，默认是 sqlite。";

    const noGenerate = await distillTurnWithLlm(query, reply, undefined);
    expect(noGenerate.source).toBe("heuristic");

    const throwing = await distillTurnWithLlm(query, reply, async () => {
      throw new Error("provider down");
    });
    expect(throwing.source).toBe("heuristic");
    expect(throwing.title).toBe(deriveTurnTitle(query));

    const garbage = await distillTurnWithLlm(query, reply, async () => "完全 unrelated text");
    expect(garbage.source).toBe("heuristic");

    const empty = await distillTurnWithLlm(query, reply, async () => "   ");
    expect(empty.source).toBe("heuristic");
  });

  it("fills only the missing field from the LLM when one line is absent", async () => {
    const generate = async () => "Summary: 只给了结论行";
    const result = await distillTurnWithLlm("问题是什么", "回答正文很长很长。", generate);
    expect(result.source).toBe("llm");
    expect(result.summary).toContain("只给了结论行");
    // title falls back to the heuristic derivation
    expect(result.title).toBe(deriveTurnTitle("问题是什么"));
  });

  it("skips the LLM entirely when query or reply is empty", async () => {
    let called = 0;
    const generate = async () => {
      called += 1;
      return "Title: x\nSummary: y";
    };
    const result = await distillTurnWithLlm("", "有回答但没有问题", generate);
    expect(result.source).toBe("heuristic");
    expect(called).toBe(0);
  });
});
