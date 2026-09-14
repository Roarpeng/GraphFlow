/**
 * tests/m89-working-set.test.ts — 工作集预取（computeWorkingSet）单元测试。
 *
 * 手工 stub GraphClient（对象字面量实现需要的方法，语义对齐
 * src/graph/graphify-client.ts：getNeighbors 的 out/in 方向、按节点 id 去重；
 * queryByKeyword 为子串匹配）。夹具使用真实节点/边格式：
 * File id = `file:{relPath}`（metadata.path），Symbol id = `symbol:{relPath}:{hash}`
 * （metadata.name / metadata.file），defines: File→Symbol，calls: caller→callee，
 * references: File→Symbol，validates: 测试侧校验边。
 */
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import { computeWorkingSet } from "../src/graph/working-set";

type Neighbor = { node: GraphNode; via: GraphEdge["relation"] };
interface StubEdge {
  from: string;
  to: string;
  relation: GraphEdge["relation"];
}
interface StubOptions {
  omitGetNodesByIds?: boolean;
  omitGetNeighbors?: boolean;
  failGetNeighbors?: boolean;
  failQueryByKeyword?: boolean;
}
type StubClient = GraphClient & { keywordCalls: string[] };

function makeStubClient(nodes: GraphNode[], edges: StubEdge[], options: StubOptions = {}): StubClient {
  const keywordCalls: string[] = [];
  const base: GraphClient = {
    async upsertNodes() {},
    async upsertEdges() {},
    async queryByKeyword(query: string): Promise<GraphNode[]> {
      keywordCalls.push(query);
      if (options.failQueryByKeyword) {
        throw new Error("keyword backend down");
      }
      const q = query.toLowerCase();
      return nodes.filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          JSON.stringify(n.metadata ?? {}).toLowerCase().includes(q)
      );
    },
  };
  const client: GraphClient = {
    ...base,
    ...(options.omitGetNodesByIds
      ? {}
      : {
          async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
            return nodes.filter((n) => ids.includes(n.id));
          },
        }),
    ...(options.omitGetNeighbors
      ? {}
      : {
          async getNeighbors(
            ids: string[],
            relations?: GraphEdge["relation"][],
            direction: "out" | "in" | "both" = "both"
          ): Promise<Neighbor[]> {
            if (options.failGetNeighbors) {
              throw new Error("neighbors backend down");
            }
            const relFilter = relations && relations.length > 0 ? new Set(relations) : null;
            const seen = new Set<string>();
            const out: Neighbor[] = [];
            for (const id of ids) {
              if (direction === "out" || direction === "both") {
                for (const edge of edges) {
                  if (edge.from !== id) continue;
                  if (relFilter && !relFilter.has(edge.relation)) continue;
                  if (seen.has(edge.to)) continue;
                  const node = nodes.find((n) => n.id === edge.to);
                  if (!node) continue;
                  seen.add(edge.to);
                  out.push({ node, via: edge.relation });
                }
              }
              if (direction === "in" || direction === "both") {
                for (const edge of edges) {
                  if (edge.to !== id) continue;
                  if (relFilter && !relFilter.has(edge.relation)) continue;
                  if (seen.has(edge.from)) continue;
                  const node = nodes.find((n) => n.id === edge.from);
                  if (!node) continue;
                  seen.add(edge.from);
                  out.push({ node, via: edge.relation });
                }
              }
            }
            return out;
          },
        }),
  };
  return Object.assign(client, { keywordCalls });
}

function fileNode(relPath: string): GraphNode {
  return {
    id: `file:${relPath}`,
    type: "File",
    content: relPath,
    metadata: { path: relPath, language: "ts", symbolCount: 1, sizeBytes: 128 },
  };
}

function symbolNode(relPath: string, hash: string, name: string): GraphNode {
  return {
    id: `symbol:${relPath}:${hash}`,
    type: "Symbol",
    content: `function ${name} (exported) @${relPath}:10`,
    metadata: {
      name,
      kind: "function",
      exported: true,
      line: 10,
      file: relPath,
      signature: `function ${name}()`,
    },
  };
}

function defines(fileRelPath: string, symbolId: string): StubEdge {
  return { from: `file:${fileRelPath}`, to: symbolId, relation: "defines" };
}

// —— 夹具：touched = src/app/main.ts ——
const RUN_MAIN = "symbol:src/app/main.ts:a1";
const HELPER_MAIN = "symbol:src/app/main.ts:a2";
const LOAD_CONFIG = "symbol:src/config/loader.ts:b1";
const VALIDATE_CONFIG = "symbol:src/config/loader.ts:b2";
const LOG_INFO = "symbol:src/utils/log.ts:c1";
const CLI_RUN = "symbol:src/cli/run.ts:d1";
const TEST_RUN_MAIN = "symbol:tests/main.test.ts:e1";
const FORMAT_OUTPUT = "symbol:src/other/format.ts:f1";

function buildFixture(): { nodes: GraphNode[]; edges: StubEdge[] } {
  const nodes: GraphNode[] = [
    fileNode("src/app/main.ts"),
    fileNode("src/config/loader.ts"),
    fileNode("src/utils/log.ts"),
    fileNode("src/cli/run.ts"),
    fileNode("tests/main.test.ts"),
    fileNode("src/other/format.ts"),
    fileNode("src/web/server.ts"),
    fileNode("src/guard.ts"),
    symbolNode("src/app/main.ts", "a1", "runMain"),
    symbolNode("src/app/main.ts", "a2", "helperMain"),
    symbolNode("src/config/loader.ts", "b1", "loadConfig"),
    symbolNode("src/config/loader.ts", "b2", "validateConfig"),
    symbolNode("src/utils/log.ts", "c1", "logInfo"),
    symbolNode("src/cli/run.ts", "d1", "cliRun"),
    symbolNode("tests/main.test.ts", "e1", "testRunMain"),
    symbolNode("src/other/format.ts", "f1", "formatOutput"),
  ];
  const edges: StubEdge[] = [
    defines("src/app/main.ts", RUN_MAIN),
    defines("src/app/main.ts", HELPER_MAIN),
    defines("src/config/loader.ts", LOAD_CONFIG),
    defines("src/config/loader.ts", VALIDATE_CONFIG),
    defines("src/utils/log.ts", LOG_INFO),
    defines("src/cli/run.ts", CLI_RUN),
    defines("tests/main.test.ts", TEST_RUN_MAIN),
    defines("src/other/format.ts", FORMAT_OUTPUT),
    // 出边 calls：runMain 调用 loadConfig / validateConfig / logInfo → callee
    { from: RUN_MAIN, to: LOAD_CONFIG, relation: "calls" },
    { from: RUN_MAIN, to: VALIDATE_CONFIG, relation: "calls" },
    { from: RUN_MAIN, to: LOG_INFO, relation: "calls" },
    // 入边 calls：cliRun / testRunMain 调用 runMain → caller
    { from: CLI_RUN, to: RUN_MAIN, relation: "calls" },
    { from: TEST_RUN_MAIN, to: RUN_MAIN, relation: "calls" },
    // 同文件自调用：邻居落回 touched 文件本身 → 必须被排除
    { from: HELPER_MAIN, to: RUN_MAIN, relation: "calls" },
    // validates：测试文件与非 test 路径文件都校验 runMain → test-for
    { from: "file:tests/main.test.ts", to: RUN_MAIN, relation: "validates" },
    { from: "file:src/guard.ts", to: RUN_MAIN, relation: "validates" },
    // references 出边：touched 文件引用 format.ts 的符号
    { from: "file:src/app/main.ts", to: FORMAT_OUTPUT, relation: "references" },
    // references 入边：server.ts 引用 touched 符号
    { from: "file:src/web/server.ts", to: RUN_MAIN, relation: "references" },
  ];
  return { nodes, edges };
}

describe("computeWorkingSet", () => {
  it("空 touched 返回空结构且不发起任何图查询", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: [] });
    expect(report).toEqual({
      touchedFiles: [],
      files: [],
      symbols: [],
      potentiallyAvoidedReads: 0,
      budgetHintTokens: 0,
    });
    expect(client.keywordCalls).toEqual([]);
  });

  it("沿 calls 双向扩展出 callee/caller，并报告 touched 文件定义的活跃符号", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: ["src/app/main.ts"] });

    // 活跃符号：main.ts defines 的 runMain / helperMain，带真实 id 与 file
    expect(report.symbols.map((s) => s.name)).toEqual(["runMain", "helperMain"]);
    expect(report.symbols[0]).toMatchObject({ id: RUN_MAIN, file: "src/app/main.ts" });

    // callee：被 runMain 调用的符号所在文件
    const loader = report.files.find((f) => f.path === "src/config/loader.ts");
    expect(loader?.reason).toBe("callee");
    expect(loader?.viaSymbols).toEqual(["loadConfig", "validateConfig"]);
    const log = report.files.find((f) => f.path === "src/utils/log.ts");
    expect(log?.reason).toBe("callee");
    expect(log?.viaSymbols).toEqual(["logInfo"]);

    // caller：调用了 runMain 的符号所在文件
    const run = report.files.find((f) => f.path === "src/cli/run.ts");
    expect(run?.reason).toBe("caller");
    expect(run?.viaSymbols).toEqual(["cliRun"]);

    // touched 文件自身（含同文件自调用邻居）绝不进候选
    expect(report.files.some((f) => f.path === "src/app/main.ts")).toBe(false);
  });

  it("图无数据（touched 路径不在图中）返回空候选不抛错", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: ["src/nope/ghost.ts"] });
    expect(report.touchedFiles).toEqual(["src/nope/ghost.ts"]);
    expect(report.files).toEqual([]);
    expect(report.symbols).toEqual([]);
    expect(report.potentiallyAvoidedReads).toBe(0);
    expect(report.budgetHintTokens).toBe(0);
  });

  it("maxFiles 截断：按 viaSymbols 数量降序、并列按路径升序", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: ["src/app/main.ts"], maxFiles: 2 });
    expect(report.files).toHaveLength(2);
    // loader 有 2 个 viaSymbols 排最前；计数并列时路径升序（src/cli < src/other < src/utils < tests）
    expect(report.files[0]?.path).toBe("src/config/loader.ts");
    expect(report.files[1]?.path).toBe("src/cli/run.ts");
  });

  it("test-for 识别：路径含 test/spec 或经 validates 边；其余引用类回退 same-file", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: ["src/app/main.ts"] });

    // tests/ 路径 + validates 边双重命中 → test-for
    const test = report.files.find((f) => f.path === "tests/main.test.ts");
    expect(test?.reason).toBe("test-for");
    expect(test?.viaSymbols).toContain("testRunMain");
    // 仅 validates 边（路径无 test 标记）→ 同样 test-for，但无 via 符号
    const guard = report.files.find((f) => f.path === "src/guard.ts");
    expect(guard?.reason).toBe("test-for");
    expect(guard?.viaSymbols).toEqual([]);
    // references 出边邻居（touched 文件引用的外部符号）→ same-file
    const format = report.files.find((f) => f.path === "src/other/format.ts");
    expect(format?.reason).toBe("same-file");
    expect(format?.viaSymbols).toEqual(["formatOutput"]);
    // references 入边邻居（引用 touched 符号的文件）→ same-file，File 邻居不贡献 via
    const server = report.files.find((f) => f.path === "src/web/server.ts");
    expect(server?.reason).toBe("same-file");
    expect(server?.viaSymbols).toEqual([]);
  });

  it("无 getNeighbors/getNodesByIds 时降级 queryByKeyword：仍得活跃符号，files 为空，不抛错", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges, { omitGetNeighbors: true, omitGetNodesByIds: true });
    const report = await computeWorkingSet(client, { touchedFiles: ["src/app/main.ts"] });
    expect(client.keywordCalls).toContain("src/app/main.ts");
    expect(report.symbols.map((s) => s.name).sort()).toEqual(["helperMain", "runMain"]);
    expect(report.files).toEqual([]);
    expect(report.potentiallyAvoidedReads).toBe(0);
    expect(report.budgetHintTokens).toBe(0);
  });

  it("计数诚实：potentiallyAvoidedReads = files.length，budgetHintTokens = files.length × 800", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, { touchedFiles: ["src/app/main.ts"] });
    // 默认 maxFiles=8，本夹具共 7 个候选文件
    expect(report.files.map((f) => f.path)).toEqual([
      "src/config/loader.ts",
      "src/cli/run.ts",
      "src/other/format.ts",
      "src/utils/log.ts",
      "tests/main.test.ts",
      "src/guard.ts",
      "src/web/server.ts",
    ]);
    expect(report.files).toHaveLength(7);
    expect(report.potentiallyAvoidedReads).toBe(7);
    expect(report.budgetHintTokens).toBe(7 * 800);
  });

  it("fail-open：getNeighbors 抛错退化为空 files；连关键词也挂掉则全空，均不抛错", async () => {
    const { nodes, edges } = buildFixture();
    const failing = makeStubClient(nodes, edges, { failGetNeighbors: true });
    const report = await computeWorkingSet(failing, { touchedFiles: ["src/app/main.ts"] });
    // 扩展失败 → files 空；符号经 queryByKeyword 降级仍可得
    expect(report.files).toEqual([]);
    expect(report.symbols.map((s) => s.name)).toEqual(["runMain", "helperMain"]);

    const allDown = makeStubClient([], [], {
      omitGetNeighbors: true,
      omitGetNodesByIds: true,
      failQueryByKeyword: true,
    });
    const empty = await computeWorkingSet(allDown, { touchedFiles: ["src/app/main.ts"] });
    expect(empty.touchedFiles).toEqual(["src/app/main.ts"]);
    expect(empty.files).toEqual([]);
    expect(empty.symbols).toEqual([]);
  });

  it("touched 路径归一化：反斜杠与 ./ 前缀去重后结果一致", async () => {
    const { nodes, edges } = buildFixture();
    const client = makeStubClient(nodes, edges);
    const report = await computeWorkingSet(client, {
      touchedFiles: ["./src/app/main.ts", "src\\app\\main.ts"],
    });
    expect(report.touchedFiles).toEqual(["src/app/main.ts"]);
    expect(report.files[0]?.path).toBe("src/config/loader.ts");
    expect(report.potentiallyAvoidedReads).toBe(7);
  });
});
