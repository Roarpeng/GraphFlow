import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";
import { extractNodeSourcePath } from "./graph-utils";

export interface ImpactResult {
  seed: string;
  impacted: Array<{
    node: { id: string; type: GraphNode["type"]; content: string };
    depth: number;
    path: string[];
  }>;
  totalCount: number;
  maxDepthReached: number;
}

export interface AffectedResult {
  changedFiles: string[];
  affected: Array<{
    node: { id: string; type: GraphNode["type"]; content: string };
    depth: number;
    isTest: boolean;
    path: string[];
  }>;
  testFiles: string[];
  totalCount: number;
}

const IMPACT_RELATIONS: GraphEdge["relation"][] = ["calls", "references", "imports"];

function isTestFile(nodeId: string): boolean {
  const lower = nodeId.toLowerCase();
  return (
    lower.includes("test") ||
    lower.includes("spec") ||
    lower.includes("__tests__") ||
    lower.includes(".test.") ||
    lower.includes(".spec.")
  );
}

/**
 * 正向影响追踪：从指定符号出发，沿 calls / references / imports 边做多跳正向 BFS 传播。
 *
 * @param client   GraphClient 实例
 * @param symbolName 种子节点 id
 * @param options  maxDepth 默认 5
 */
export async function impactAnalysis(
  client: GraphClient,
  symbolName: string,
  options?: { maxDepth?: number }
): Promise<ImpactResult> {
  if (typeof client.getNeighbors !== "function") {
    return { seed: symbolName, impacted: [], totalCount: 0, maxDepthReached: 0 };
  }

  const maxDepth = Math.max(1, options?.maxDepth ?? 5);
  const visited = new Map<string, { depth: number; path: string[]; node: GraphNode }>();
  visited.set(symbolName, {
    depth: 0,
    path: [symbolName],
    node: { id: symbolName, type: "Symbol", content: symbolName },
  });

  let maxDepthReached = 0;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const frontier = Array.from(visited.entries())
      .filter(([, v]) => v.depth === depth - 1)
      .map(([id]) => id);

    if (frontier.length === 0) {
      break;
    }

    for (const nodeId of frontier) {
      const parent = visited.get(nodeId);
      if (!parent) {
        continue;
      }

      const neighbors = await client.getNeighbors([nodeId], IMPACT_RELATIONS, "out");
      for (const { node } of neighbors) {
        if (visited.has(node.id)) {
          continue;
        }
        const path = [...parent.path, node.id];
        visited.set(node.id, { depth, path, node });
        maxDepthReached = Math.max(maxDepthReached, depth);
      }
    }
  }

  const impacted: ImpactResult["impacted"] = [];
  for (const [id, info] of visited) {
    if (id === symbolName) {
      continue;
    }
    impacted.push({
      node: { id: info.node.id, type: info.node.type, content: info.node.content },
      depth: info.depth,
      path: info.path,
    });
  }

  impacted.sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));

  return {
    seed: symbolName,
    impacted,
    totalCount: impacted.length,
    maxDepthReached,
  };
}

/**
 * 反向影响追踪：从变更文件出发，沿所有边的反方向（direction: "in"）传播，
 * 找出受影响的测试文件、调用方、下游模块。
 *
 * @param client       GraphClient 实例
 * @param changedFiles 种子节点 id 列表
 * @param options      maxDepth 默认 5
 */
export async function affectedAnalysis(
  client: GraphClient,
  changedFiles: string[],
  options?: { maxDepth?: number }
): Promise<AffectedResult> {
  if (typeof client.getNeighbors !== "function") {
    return { changedFiles, affected: [], testFiles: [], totalCount: 0 };
  }

  const maxDepth = Math.max(1, options?.maxDepth ?? 5);
  const visited = new Map<string, { depth: number; path: string[]; node: GraphNode }>();

  for (const file of changedFiles) {
    if (!visited.has(file)) {
      visited.set(file, {
        depth: 0,
        path: [file],
        node: { id: file, type: "File", content: file },
      });
    }
  }

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const frontier = Array.from(visited.entries())
      .filter(([, v]) => v.depth === depth - 1)
      .map(([id]) => id);

    if (frontier.length === 0) {
      break;
    }

    for (const nodeId of frontier) {
      const parent = visited.get(nodeId);
      if (!parent) {
        continue;
      }

      const neighbors = await client.getNeighbors([nodeId], undefined, "in");
      for (const { node } of neighbors) {
        if (visited.has(node.id)) {
          continue;
        }
        const path = [...parent.path, node.id];
        visited.set(node.id, { depth, path, node });
      }
    }
  }

  const affected: AffectedResult["affected"] = [];
  const testFilesSet = new Set<string>();

  for (const [id, info] of visited) {
    if (changedFiles.includes(id)) {
      continue;
    }
    const test = isTestFile(id);
    if (test) {
      testFilesSet.add(id);
    }
    affected.push({
      node: { id: info.node.id, type: info.node.type, content: info.node.content },
      depth: info.depth,
      isTest: test,
      path: info.path,
    });
  }

  affected.sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));

  return {
    changedFiles,
    affected,
    testFiles: Array.from(testFilesSet).sort((a, b) => a.localeCompare(b)),
    totalCount: affected.length,
  };
}

export interface CallChainResult {
  from: string;
  to: string;
  found: boolean;
  path: Array<{ symbol: string; file: string; line?: number | undefined }>;
  depth: number;
}

export interface InheritanceNode {
  symbol: string;
  file: string;
  line?: number | undefined;
  parents: InheritanceNode[];
  children: InheritanceNode[];
}

export interface InheritanceChainResult {
  symbol: string;
  parents: InheritanceNode[];
  children: InheritanceNode[];
  depth: number;
}

/**
 * 调用链追踪：从 fromSymbol 出发，沿 calls 边做 BFS，搜索到 toSymbol 的最短路径。
 *
 * @param client     GraphClient 实例
 * @param fromSymbol 起始符号 id
 * @param toSymbol   目标符号 id
 * @param options    maxDepth 默认 10
 */
export async function callChain(
  client: GraphClient,
  fromSymbol: string,
  toSymbol: string,
  options?: { maxDepth?: number }
): Promise<CallChainResult> {
  if (typeof client.getNeighbors !== "function") {
    return { from: fromSymbol, to: toSymbol, found: false, path: [], depth: 0 };
  }

  const maxDepth = Math.max(1, options?.maxDepth ?? 10);
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: GraphNode[] }> = [];

  const startNodes = await client.getNodesByIds?.([fromSymbol]) ?? [];
  const startNode =
    startNodes.find((n) => n.id === fromSymbol) ?? {
      id: fromSymbol,
      type: "Symbol",
      content: fromSymbol,
    };

  queue.push({ id: fromSymbol, path: [startNode] });
  visited.add(fromSymbol);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = current.path.length - 1;

    if (current.id === toSymbol) {
      const path = current.path.map((node) => {
        const entry: { symbol: string; file: string; line?: number } = {
          symbol: node.id,
          file: extractNodeSourcePath(node),
        };
        if (typeof node.metadata?.line === "number") {
          entry.line = node.metadata.line;
        }
        return entry;
      });
      return {
        from: fromSymbol,
        to: toSymbol,
        found: true,
        path,
        depth: currentDepth,
      };
    }

    if (currentDepth >= maxDepth) {
      continue;
    }

    const neighbors = await client.getNeighbors?.([current.id], ["calls"], "out") ?? [];
    for (const { node } of neighbors) {
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      queue.push({
        id: node.id,
        path: [...current.path, node],
      });
    }
  }

  return { from: fromSymbol, to: toSymbol, found: false, path: [], depth: 0 };
}

async function buildInheritanceTree(
  client: GraphClient,
  rootSymbol: string,
  allowUp: boolean,
  allowDown: boolean,
  maxDepth: number,
  visited: Set<string>
): Promise<{ node: InheritanceNode; maxDepthReached: number } | null> {
  if (typeof client.getNeighbors !== "function") {
    return null;
  }
  if (visited.has(rootSymbol)) {
    return null;
  }
  visited.add(rootSymbol);

  const nodes = await client.getNodesByIds?.([rootSymbol]) ?? [];
  const rootNode =
    nodes.find((n) => n.id === rootSymbol) ?? {
      id: rootSymbol,
      type: "Symbol",
      content: rootSymbol,
    };

  const result: InheritanceNode = {
    symbol: rootSymbol,
    file: extractNodeSourcePath(rootNode),
    parents: [],
    children: [],
  };
  if (typeof rootNode.metadata?.line === "number") {
    result.line = rootNode.metadata.line;
  }

  if (maxDepth <= 0) {
    return { node: result, maxDepthReached: 0 };
  }

  let maxSubDepth = 0;

  if (allowUp) {
    const parentNeighbors = await client.getNeighbors?.([rootSymbol], ["inherits"], "out") ?? [];
    for (const { node } of parentNeighbors) {
      const subTree = await buildInheritanceTree(client, node.id, true, false, maxDepth - 1, visited);
      if (subTree) {
        result.parents.push(subTree.node);
        maxSubDepth = Math.max(maxSubDepth, subTree.maxDepthReached + 1);
      }
    }
  }

  if (allowDown) {
    const childNeighbors = await client.getNeighbors?.([rootSymbol], ["inherits"], "in") ?? [];
    for (const { node } of childNeighbors) {
      const subTree = await buildInheritanceTree(client, node.id, false, true, maxDepth - 1, visited);
      if (subTree) {
        result.children.push(subTree.node);
        maxSubDepth = Math.max(maxSubDepth, subTree.maxDepthReached + 1);
      }
    }
  }

  return { node: result, maxDepthReached: maxSubDepth };
}

/**
 * 继承层次追踪：沿 inherits 边追踪继承树。
 *
 * @param client     GraphClient 实例
 * @param symbolName 起始符号 id
 * @param options    maxDepth 默认 5；direction 默认 both
 */
export async function inheritanceChain(
  client: GraphClient,
  symbolName: string,
  options?: { maxDepth?: number; direction?: "up" | "down" | "both" }
): Promise<InheritanceChainResult> {
  if (typeof client.getNeighbors !== "function") {
    return { symbol: symbolName, parents: [], children: [], depth: 0 };
  }

  const maxDepth = Math.max(1, options?.maxDepth ?? 5);
  const direction = options?.direction ?? "both";

  const allowUp = direction === "up" || direction === "both";
  const allowDown = direction === "down" || direction === "both";

  const visited = new Set<string>();
  const tree = await buildInheritanceTree(client, symbolName, allowUp, allowDown, maxDepth, visited);

  if (!tree) {
    return { symbol: symbolName, parents: [], children: [], depth: 0 };
  }

  return {
    symbol: symbolName,
    parents: tree.node.parents,
    children: tree.node.children,
    depth: tree.maxDepthReached,
  };
}
