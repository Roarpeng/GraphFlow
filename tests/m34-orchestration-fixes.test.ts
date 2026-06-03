import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSimpleTask } from "../src/core/state-machine";
import { executeDag, type TaskExecutor } from "../src/core/dag-engine";
import type { TaskNode } from "../src/core/types";

// ── Worker / Validator mocks ──────────────────────────────────────

vi.mock("../src/agents/worker", () => ({
  runWorker: vi.fn(),
}));

vi.mock("../src/agents/validator", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agents/validator")>();
  return {
    ...original,
    validateTaskResultLlm: vi.fn(),
  };
});

import { runWorker } from "../src/agents/worker";
import { validateTaskResultLlm } from "../src/agents/validator";

const mockedRunWorker = vi.mocked(runWorker);
const mockedValidateTaskResultLlm = vi.mocked(validateTaskResultLlm);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Task 1: state-machine retry feedback injection ────────────────

describe("state-machine: retry feedback injection", () => {
  it("should inject previous validation feedback into the task on retry", async () => {
    // 第 1 次调用返回不满足条件的输出
    mockedRunWorker.mockResolvedValueOnce("incomplete answer");
    // 第 2 次调用返回满足条件的输出
    mockedRunWorker.mockResolvedValueOnce("complete answer with implement auth and add tests");

    const result = await runSimpleTask({
      task: "implement auth and add tests",
      maxRetries: 3,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.attempts).toBe(2);

    // 验证第 2 次 worker 调用中包含 feedback 信息
    const secondCallArgs = mockedRunWorker.mock.calls[1]?.[0];
    expect(secondCallArgs).toBeDefined();
    expect(secondCallArgs!.task).toContain("[Retry feedback]");
    expect(secondCallArgs!.task).toContain("Missing criteria:");
  });

  it("should use real validation summary on final failure, not hardcoded values", async () => {
    // 所有 3 次重试都返回不满足条件的输出
    mockedRunWorker.mockResolvedValue("bad output");

    const result = await runSimpleTask({
      task: "implement auth and add tests",
      maxRetries: 3,
    });

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(result.attempts).toBe(3);
    // 应使用真实 validation 结果，而非硬编码 {matched:0, missing:1}
    expect(result.validationSummary).toBeDefined();
    expect(result.validationSummary!.riskTags).toContain("criteria_mismatch");
  });
});

// ── Task 1: LLM validator activation ──────────────────────────────

describe("state-machine: LLM validator activation", () => {
  it("should use LLM validator when validatorSelection is provided", async () => {
    mockedRunWorker.mockResolvedValue("llm output");
    mockedValidateTaskResultLlm.mockResolvedValue({
      passed: true,
      feedback: "LLM says OK",
      matchedCriteria: ["auth"],
      missingCriteria: [],
      riskTags: [],
    });

    const validatorSelection = { provider: "openai", model: "gpt-4o", tier: "smart" as const };
    const result = await runSimpleTask({
      task: "implement auth",
      validatorSelection,
      maxRetries: 2,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.feedback).toBe("LLM says OK");
    expect(mockedValidateTaskResultLlm).toHaveBeenCalledTimes(1);
    expect(mockedValidateTaskResultLlm).toHaveBeenCalledWith(
      "implement auth",
      "llm output",
      validatorSelection,
      undefined,
    );
  });

  it("should fall back to rule validator when no validatorSelection", async () => {
    mockedRunWorker.mockResolvedValue("Simulated change for task: implement auth and add tests");

    const result = await runSimpleTask({
      task: "implement auth and add tests",
      maxRetries: 1,
    });

    // 规则验证器被使用，LLM 验证器不被调用
    expect(mockedValidateTaskResultLlm).not.toHaveBeenCalled();
    expect(result.attempts).toBe(1);
  });
});

// ── Task 2: DAG blocked propagation ───────────────────────────────

describe("dag-engine: blocked propagation", () => {
  it("should mark downstream nodes of failed nodes as blocked", async () => {
    const plan: TaskNode[] = [
      { id: "A", description: "step A", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "B", description: "step B", dependencies: ["A"], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "C", description: "step C", dependencies: ["B"], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "D", description: "step D", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
    ];

    const executor: TaskExecutor = async (task) => {
      // A 失败, D 成功
      return task.id !== "A";
    };

    const result = await executeDag(plan, executor);

    expect(result.failed).toContain("A");
    expect(result.blocked).toContain("B");
    expect(result.blocked).toContain("C");
    expect(result.completed).toContain("D");
    expect(result.completed).not.toContain("B");
    expect(result.completed).not.toContain("C");
  });

  it("should handle transitive blocked propagation", async () => {
    const plan: TaskNode[] = [
      { id: "root", description: "root", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "mid", description: "mid", dependencies: ["root"], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "leaf", description: "leaf", dependencies: ["mid"], status: "PENDING", contextQuery: "", retryCount: 0 },
    ];

    const executor: TaskExecutor = async () => false; // root fails

    const result = await executeDag(plan, executor);

    expect(result.failed).toContain("root");
    expect(result.blocked).toContain("mid");
    expect(result.blocked).toContain("leaf");
  });
});

// ── Task 2: DAG timeout ──────────────────────────────────────────

describe("dag-engine: node timeout", () => {
  it("should mark node as failed when it exceeds nodeTimeoutMs", async () => {
    const plan: TaskNode[] = [
      { id: "slow", description: "slow task", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "fast", description: "fast task", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
    ];

    const executor: TaskExecutor = async (task) => {
      if (task.id === "slow") {
        // 超时：等待比 nodeTimeoutMs 更长的时间
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      }
      return true;
    };

    const result = await executeDag(plan, executor, { nodeTimeoutMs: 50 });

    expect(result.failed).toContain("slow");
    expect(result.completed).toContain("fast");
  });
});

// ── Task 2: DAG concurrency limit ────────────────────────────────

describe("dag-engine: concurrency limit", () => {
  it("should limit parallel execution to concurrencyLimit", async () => {
    const plan: TaskNode[] = [
      { id: "A", description: "A", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "B", description: "B", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "C", description: "C", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
      { id: "D", description: "D", dependencies: [], status: "PENDING", contextQuery: "", retryCount: 0 },
    ];

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const executor: TaskExecutor = async () => {
      currentConcurrent += 1;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      // 模拟异步工作
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentConcurrent -= 1;
      return true;
    };

    const result = await executeDag(plan, executor, { concurrencyLimit: 2 });

    expect(result.completed).toHaveLength(4);
    expect(result.failed).toHaveLength(0);
    // 最大并行数不应超过 concurrencyLimit
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
