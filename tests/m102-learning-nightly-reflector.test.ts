import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphifyClient } from "../src/graph/graphify-client";
import { validateConfig } from "../src/config/loader";
import type { GraphFlowConfig } from "../src/config/schema";
import { FeedbackCollector } from "../src/learning/feedback-collector";
import {
  appendFeedbackEvent,
  readFeedbackEvents,
} from "../src/learning/learning-events";
import { buildRankingSamples } from "../src/learning/sample-builder";
import { runNightlyLearning } from "../src/learning/nightly-trainer";
import { reflectOnEpisodes } from "../src/learning/reflector";
import { recordEpisode } from "../src/learning/episodic-memory";

function makeConfig(dir: string): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    learningPolicy: {
      enableFlywheel: false,
      trainingCadence: "nightly",
      eventsPath: join(dir, "events.jsonl"),
      exportPath: join(dir, "dataset.jsonl"),
      summaryPath: join(dir, "summary.json"),
    },
    embeddingPolicy: { enabled: false },
    graphPolicy: { transport: "memory" },
  });
}

describe("M102 learning events + nightly trainer + reflector", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gf-m102-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appendFeedbackEvent + readFeedbackEvents roundtrip", () => {
    const path = join(dir, "nested", "events.jsonl");
    appendFeedbackEvent(path, { query: "a", passed: true, tokenCost: 10, retries: 0 });
    appendFeedbackEvent(path, { query: "b", passed: false, tokenCost: 20, retries: 2 });
    const events = readFeedbackEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ query: "a", passed: true });
    expect(events[1]).toMatchObject({ query: "b", passed: false, retries: 2 });
  });

  it("readFeedbackEvents skips corrupted lines instead of throwing", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ query: "good", passed: true, tokenCost: 1, retries: 0 }),
        '{"query": "trunc', // crash mid-append
        "not json at all",
        "",
        JSON.stringify({ query: "also good", passed: false, tokenCost: 2, retries: 1 }),
        JSON.stringify({ nonsense: true }), // wrong shape → skipped
      ].join("\n"),
      "utf8"
    );
    const events = readFeedbackEvents(path);
    expect(events.map((e) => e.query)).toEqual(["good", "also good"]);
  });

  it("readFeedbackEvents returns [] for missing file", () => {
    expect(readFeedbackEvents(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("appendFeedbackEvent rotates oversized .jsonl files to .1.jsonl", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, "x".repeat(10 * 1024 * 1024), "utf8");
    appendFeedbackEvent(path, { query: "fresh", passed: true, tokenCost: 1, retries: 0 });
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);
    expect(readFeedbackEvents(path)).toHaveLength(1);
    expect(readFeedbackEvents(join(dir, "events.1.jsonl"))).toHaveLength(0);
  });

  it("appendFeedbackEvent rotates non-jsonl suffixes to <path>.1", () => {
    const path = join(dir, "events.log");
    writeFileSync(path, "x".repeat(10 * 1024 * 1024), "utf8");
    appendFeedbackEvent(path, { query: "fresh", passed: true, tokenCost: 1, retries: 0 });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("buildRankingSamples labels positive only for pass with <=1 retry", () => {
    const samples = buildRankingSamples([
      { query: "ok", passed: true, tokenCost: 1, retries: 0 },
      { query: "ok-retried", passed: true, tokenCost: 1, retries: 1 },
      { query: "too-many-retries", passed: true, tokenCost: 1, retries: 2 },
      { query: "failed", passed: false, tokenCost: 1, retries: 0 },
    ]);
    expect(samples).toEqual([
      { prompt: "ok", label: "positive" },
      { prompt: "ok-retried", label: "positive" },
      { prompt: "too-many-retries", label: "negative" },
      { prompt: "failed", label: "negative" },
    ]);
  });

  it("FeedbackCollector.list returns a defensive copy", () => {
    const collector = new FeedbackCollector();
    collector.add({ query: "q", passed: true, tokenCost: 1, retries: 0 });
    const listed = collector.list();
    listed.pop();
    expect(collector.list()).toHaveLength(1);
  });

  it("runNightlyLearning sync path computes metrics and writes the summary", () => {
    const config = makeConfig(dir);
    const eventsPath = config.learningPolicy.eventsPath as string;
    appendFeedbackEvent(eventsPath, { query: "a", passed: true, tokenCost: 10, retries: 0 });
    appendFeedbackEvent(eventsPath, { query: "b", passed: false, tokenCost: 30, retries: 1 });

    const summary = runNightlyLearning(config) as Extract<
      ReturnType<typeof runNightlyLearning>,
      { totalEvents: number }
    >;
    expect(summary.totalEvents).toBe(2);
    expect(summary.passRate).toBeCloseTo(0.5);
    expect(summary.averageTokenCost).toBeCloseTo(20);
    expect(summary.exportedPath).toBe(config.learningPolicy.exportPath);
    expect(existsSync(config.learningPolicy.exportPath as string)).toBe(true);

    const written = JSON.parse(
      readFileSync(config.learningPolicy.summaryPath as string, "utf8")
    ) as { totalEvents: number };
    expect(written.totalEvents).toBe(2);
  });

  it("runNightlyLearning with a graph client synthesizes lessons and reports count", async () => {
    const config = makeConfig(dir);
    const client = new GraphifyClient();
    await recordEpisode(client, {
      task: "refactor planner and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["keep modules pure"],
      lessons: [],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "refactor planner tests further",
      plan: [],
      outcome: "pass",
      keyDecisions: ["keep modules pure"],
      lessons: [],
      attempts: 1,
    });

    const summary = await runNightlyLearning(config, client);
    expect(summary.lessonsSynthesized).toBeGreaterThan(0);
    expect(summary.totalEvents).toBe(0);

    const written = JSON.parse(
      readFileSync(config.learningPolicy.summaryPath as string, "utf8")
    ) as { lessonsSynthesized: number };
    expect(written.lessonsSynthesized).toBe(summary.lessonsSynthesized);
  });

  it("reflectOnEpisodes clusters similar tasks and writes lesson nodes + improves edges", async () => {
    const client = new GraphifyClient();
    await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["extract pure functions"],
      lessons: [],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "refactor planner module again with tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["extract pure functions"],
      lessons: [],
      attempts: 1,
    });

    const lessons = await reflectOnEpisodes(client, { minCluster: 2, maxLessons: 3 });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.lesson).toBe("extract pure functions");
    expect(lessons[0]?.outcomes).toEqual({ pass: 2, fail: 0 });

    const lessonNodes = client.snapshot().nodes.filter((n) => n.id.startsWith("lesson:"));
    expect(lessonNodes).toHaveLength(1);
    expect(lessonNodes[0]?.content).toContain("lesson");
    const improves = client.snapshot().edges.filter((e) => e.relation === "improves");
    expect(improves).toHaveLength(2);
  });

  it("reflectOnEpisodes ignores decisions without positive evidence", async () => {
    const client = new GraphifyClient();
    await recordEpisode(client, {
      task: "deploy worker cron jobs",
      plan: [],
      outcome: "fail",
      keyDecisions: ["skip the smoke test"],
      lessons: [],
      attempts: 2,
    });
    await recordEpisode(client, {
      task: "deploy worker cron jobs again",
      plan: [],
      outcome: "fail",
      keyDecisions: ["skip the smoke test"],
      lessons: [],
      attempts: 2,
    });

    const lessons = await reflectOnEpisodes(client, { minCluster: 2 });
    expect(lessons).toHaveLength(0);
  });

  it("reflectOnEpisodes respects taskCluster filtering", async () => {
    const client = new GraphifyClient();
    await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: ["extract pure functions"],
      lessons: [],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "refactor planner module tests once more",
      plan: [],
      outcome: "pass",
      keyDecisions: ["extract pure functions"],
      lessons: [],
      attempts: 1,
    });
    await recordEpisode(client, {
      task: "cook dinner for the family tonight",
      plan: [],
      outcome: "pass",
      keyDecisions: ["extract pure functions"],
      lessons: [],
      attempts: 1,
    });

    const lessons = await reflectOnEpisodes(client, {
      taskCluster: "refactor planner module and add tests",
      minCluster: 2,
    });
    expect(lessons).toHaveLength(1);
  });
});
