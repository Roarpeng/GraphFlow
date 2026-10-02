import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KVStore } from "../../src/caches/context-cache.js";
import type { ExperienceRecord, ExperienceStore } from "../../src/agent/experience.js";
import type { PipelineDeps } from "../../src/agent/pipeline.js";
import type { CollectedProjectFacts } from "../../src/host/project-facts.js";
import type { GraphFlowContextResult } from "../../src/host/graphflow-mcp-client.js";
import type { TaskTrace } from "../../src/trace.js";

export function memoryKv(initial: Record<string, string> = {}): KVStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value;
    },
  };
}

export function memoryExperience(initial: ExperienceRecord[] = []): ExperienceStore & { records: ExperienceRecord[] } {
  const records = [...initial];
  return { records, read: () => [...records], append: (r) => void records.push(r) };
}

export function fakeFacts(root: string, overrides: { gitHead?: string; fileHash?: string } = {}): CollectedProjectFacts {
  return {
    twinFacts: {
      root,
      packageJson: { name: "fixture", scripts: { test: "vitest run", build: "tsc" }, dependencies: [] },
      fileMap: [
        { path: "src/index.ts", symbols: ["main"] },
        { path: "src/util.ts", symbols: ["helper"] },
      ],
      recentCommits: ["init"],
    },
    projectState: {
      gitHead: overrides.gitHead ?? "a".repeat(40),
      relevantFileHashes: { "src/index.ts": overrides.fileHash ?? "h1" },
    },
    relevantFiles: ["src/index.ts"],
    symbolsByFile: new Map([["src/index.ts", ["main"]]]),
    isGitRepo: true,
  };
}

export const FAKE_CONTEXT: GraphFlowContextResult = {
  ok: true,
  context: {
    summary: ["src/index.ts exports main"],
    anchors: [{ id: "file:src/index.ts", relevance: 0.9 }],
    anchorFiles: ["src/index.ts"],
    compressedTokens: 120,
    dialogueHits: 0,
    durationMs: 5,
  },
};

export interface FixtureDeps extends PipelineDeps {
  cacheStore: ReturnType<typeof memoryKv>;
  toolStore: ReturnType<typeof memoryKv>;
  policyKv: ReturnType<typeof memoryKv>;
  experience: ReturnType<typeof memoryExperience>;
  traces: TaskTrace[];
}

export function fixtureDeps(root: string, overrides: Partial<PipelineDeps> = {}): FixtureDeps {
  const traces: TaskTrace[] = [];
  return {
    collectFacts: () => fakeFacts(root),
    fetchContext: async () => FAKE_CONTEXT,
    graphVersion: () => "graph:1",
    cacheStore: memoryKv(),
    toolStore: memoryKv(),
    policyKv: memoryKv(),
    experience: memoryExperience(),
    traceSink: (t) => void traces.push(t),
    ...overrides,
    traces,
  } as FixtureDeps;
}

/** A scratch dir with a stand-in agent CLI (reads the prompt on stdin, prints an answer). */
export function scratchWorkspace(agentBody?: string): { dir: string; agentScript: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "eff-agent-fixture-"));
  const agentScript = join(dir, "fake-agent.cjs");
  writeFileSync(
    agentScript,
    agentBody ??
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        "  console.log('ANSWER: handled task; prompt chars=' + input.length);",
        "});",
      ].join("\n")
  );
  writeFileSync(join(dir, "pass.cjs"), "process.exit(0);\n");
  writeFileSync(join(dir, "fail.cjs"), "console.error('assertion failed'); process.exit(1);\n");
  return { dir, agentScript, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
