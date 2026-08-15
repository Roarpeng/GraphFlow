import type { GraphEdge, GraphNode } from "../core/types.js";
import {
  discoverWorkspacePackages,
  findWorkspacePackageRoot,
  packageLabelForPath,
  workspacePackageForPath,
} from "../config/workspace-packages.js";
import { isDialogueSessionNode, isDialogueTurnNode, parseDialogueTurn } from "../learning/dialogue-thread.js";
import { isWorkbenchTopicNode, parseWorkbenchTopic } from "../learning/workbench-topic.js";

export type SnapshotViewLayer = "code" | "learning";

export interface SnapshotWorkspaceContext {
  rootDir: string;
  packageRoots?: string[];
}

export { discoverWorkspacePackages };

export interface GraphSnapshotSampleNode {
  id: string;
  type: GraphNode["type"];
  contentPreview: string;
  displayLabel: string;
  displayPath?: string;
  folderGroup?: string;
  workspacePackage?: string;
  sourcePath?: string;
  sourceLine?: number;
  viewLayer: SnapshotViewLayer;
  /** Dialogue-turn id to pass as resumeFromTurnId on the next context preview. */
  resumeFromTurnId?: string;
  /** Workbench topic id to pass as topicId when continuing from this canvas node. */
  resumeFromTopicId?: string;
}

export interface GraphSnapshotSampleEdge {
  from: string;
  relation: GraphEdge["relation"];
  to: string;
}

/** Relations shown first in snapshot edge sampling (call graph visibility). */
const SNAPSHOT_EDGE_PRIORITY: GraphEdge["relation"][] = [
  "calls",
  "defines",
  "imports",
  "depends_on",
  "references",
  "inherits",
  "documents",
  "implements",
  "derived_from",
  "next_section",
  "part_of",
  "co_occurs",
  "improves",
  "prerequisite",
];

function snapshotEdgeRank(relation: GraphEdge["relation"]): number {
  const index = SNAPSHOT_EDGE_PRIORITY.indexOf(relation);
  return index === -1 ? SNAPSHOT_EDGE_PRIORITY.length : index;
}

function sortSnapshotEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) => snapshotEdgeRank(a.relation) - snapshotEdgeRank(b.relation));
}

function compactPreview(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function folderGroupFromPath(relPath: string, workspace?: SnapshotWorkspaceContext): string {
  if (workspace?.rootDir) {
    const packageRoots = workspace.packageRoots ?? discoverWorkspacePackages(workspace.rootDir);
    const pkgRoot = findWorkspacePackageRoot(relPath, packageRoots);
    if (pkgRoot) {
      return packageLabelForPath(workspace.rootDir, relPath);
    }
  }

  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  return parts[0] ?? ".";
}

export function viewLayerForType(type: GraphNode["type"]): SnapshotViewLayer {
  if (type === "Skill" || type === "TaskRun" || type === "Decision") {
    return "learning";
  }
  // Concept/Requirement are doc-domain but surface with code for unified engineering KG views.
  return "code";
}

function isMetaFile(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes(".md") ||
    lower.includes(".json") ||
    lower.includes(".yml") ||
    lower.includes(".yaml") ||
    lower.includes(".github") ||
    lower.includes(".claude") ||
    lower.includes(".codex")
  );
}

function buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    if (!adj.has(edge.to)) adj.set(edge.to, []);
    adj.get(edge.from)!.push(edge.to);
    adj.get(edge.to)!.push(edge.from);
  }
  return adj;
}

function applyPathSnapshotMetadata(
  path: string,
  workspace?: SnapshotWorkspaceContext
): { folderGroup: string; workspacePackage?: string } {
  const folderGroup = folderGroupFromPath(path, workspace);
  const workspacePackage = workspace?.rootDir
    ? workspacePackageForPath(workspace.rootDir, path, workspace.packageRoots)
    : undefined;
  return workspacePackage ? { folderGroup, workspacePackage } : { folderGroup };
}

export function enrichNodeForSnapshot(
  node: GraphNode,
  previewLength = 160,
  workspace?: SnapshotWorkspaceContext
): GraphSnapshotSampleNode {
  const contentPreview = compactPreview(node.content, previewLength);
  const meta = node.metadata ?? {};

  let displayLabel = node.id;
  let displayPath: string | undefined;
  let sourcePath: string | undefined;
  let sourceLine: number | undefined;
  let folderGroup: string | undefined;
  let workspacePackage: string | undefined;

  if (node.type === "File") {
    const path = node.id.startsWith("file:")
      ? node.id.slice(5)
      : String(meta.path ?? node.content.split("#")[0]?.trim() ?? node.id);
    displayLabel = basename(path);
    displayPath = path;
    sourcePath = path;
    ({ folderGroup, workspacePackage } = applyPathSnapshotMetadata(path, workspace));
  } else if (node.type === "Module") {
    const path = node.id.startsWith("module:") ? node.id.slice(7) : node.content;
    displayLabel = basename(path) || path;
    displayPath = path;
    ({ folderGroup, workspacePackage } = applyPathSnapshotMetadata(path, workspace));
  } else if (node.type === "Symbol") {
    const name = typeof meta.name === "string" ? meta.name : undefined;
    const file = typeof meta.file === "string" ? meta.file : undefined;
    const line = typeof meta.line === "number" ? meta.line : undefined;
    const kind = typeof meta.kind === "string" ? meta.kind : "";
    if (name) {
      displayLabel = kind ? `${kind} ${name}` : name;
    } else {
      const named = node.content.match(
        /^(function|class|interface|type|method|variable|const|let|enum)\s+([A-Za-z0-9_$]+)/
      );
      const fallback = node.content.split("@")[0]?.trim();
      displayLabel = named?.[2] ?? (fallback && fallback.length > 0 ? fallback : node.id);
      if (displayLabel.length > 48) {
        displayLabel = `${displayLabel.slice(0, 47)}…`;
      }
    }
    displayPath = file;
    sourcePath = file;
    sourceLine = line;
    if (file) {
      ({ folderGroup, workspacePackage } = applyPathSnapshotMetadata(file, workspace));
    }
  } else if (node.type === "Skill") {
    displayLabel =
      typeof meta.name === "string" ? meta.name : node.id.replace(/^skill:/, "") || "Skill";
    displayPath = node.id;
  } else if (node.type === "Concept") {
    displayLabel = compactPreview(node.content, 48) || "Concept";
    const sourcePathMeta = typeof meta.sourcePath === "string" ? meta.sourcePath : undefined;
    displayPath = sourcePathMeta;
    sourcePath = sourcePathMeta;
    if (sourcePathMeta) {
      ({ folderGroup, workspacePackage } = applyPathSnapshotMetadata(sourcePathMeta, workspace));
    }
  } else if (node.type === "Requirement") {
    displayLabel = compactPreview(node.content, 48) || "Requirement";
    const sourcePathMeta = typeof meta.sourcePath === "string" ? meta.sourcePath : undefined;
    displayPath = sourcePathMeta;
    sourcePath = sourcePathMeta;
    if (sourcePathMeta) {
      ({ folderGroup, workspacePackage } = applyPathSnapshotMetadata(sourcePathMeta, workspace));
    }
  } else if (node.type === "TaskRun") {
    displayLabel = compactPreview(node.content, 48) || node.id.replace(/^taskrun:/, "") || "TaskRun";
  } else if (node.type === "Decision") {
    const topic = isWorkbenchTopicNode(node) ? parseWorkbenchTopic(node) : undefined;
    const turn = isDialogueTurnNode(node) ? parseDialogueTurn(node) : undefined;
    if (topic) {
      displayLabel = `${topic.isolated ? "旁支" : "主线"}: ${compactPreview(topic.title, 32)}`;
      folderGroup = "workbench";
      displayPath = topic.id;
    } else if (turn) {
      displayLabel = `对话#${turn.seq}: ${compactPreview(turn.userQuery, 36)}`;
      folderGroup = "dialogue";
      displayPath = turn.id;
    } else if (isDialogueSessionNode(node)) {
      displayLabel = compactPreview(node.content, 48) || "对话主线";
      folderGroup = "dialogue";
    } else {
      displayLabel = compactPreview(node.content, 48) || node.id.replace(/^decision:/, "") || "Decision";
    }
  }

  return {
    id: node.id,
    type: node.type,
    contentPreview,
    displayLabel,
    viewLayer: viewLayerForType(node.type),
    ...(displayPath ? { displayPath } : {}),
    ...(folderGroup ? { folderGroup } : {}),
    ...(workspacePackage ? { workspacePackage } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceLine !== undefined ? { sourceLine } : {}),
    ...(isDialogueTurnNode(node) ? { resumeFromTurnId: node.id } : {}),
    ...(isWorkbenchTopicNode(node) ? { resumeFromTopicId: node.id } : {}),
  };
}

export function sampleGraphForSnapshot(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeLimit: number,
  edgeLimit: number,
  rootDir?: string
): { sampleNodes: GraphSnapshotSampleNode[]; sampleEdges: GraphSnapshotSampleEdge[] } {
  if (nodes.length === 0) {
    return { sampleNodes: [], sampleEdges: [] };
  }

  const workspace = rootDir
    ? { rootDir, packageRoots: discoverWorkspacePackages(rootDir) }
    : undefined;

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adj = buildAdjacency(edges);
  const degree = (id: string) => adj.get(id)?.length ?? 0;

  const learningNodes = nodes.filter((node) => viewLayerForType(node.type) === "learning");
  const learningBudget = Math.min(learningNodes.length, Math.max(4, Math.floor(nodeLimit * 0.15)));
  const codeBudget = Math.max(1, nodeLimit - learningBudget);

  const selected: GraphNode[] = [];
  const visited = new Set<string>();

  const countLayer = (layer: SnapshotViewLayer) =>
    selected.filter((node) => viewLayerForType(node.type) === layer).length;

  const fileCandidates = nodes
    .filter((node) => node.type === "File" && !isMetaFile(node.id))
    .sort((a, b) => degree(b.id) - degree(a.id));

  const byFolder = new Map<string, GraphNode[]>();
  for (const file of fileCandidates) {
    const path = file.id.startsWith("file:") ? file.id.slice(5) : file.content.split("#")[0]?.trim() ?? file.id;
    const group = folderGroupFromPath(path, workspace);
    const bucket = byFolder.get(group) ?? [];
    bucket.push(file);
    byFolder.set(group, bucket);
  }

  const folderBuckets = Array.from(byFolder.values());
  let round = 0;
  while (countLayer("code") < codeBudget && round < 5000) {
    let pickedAny = false;
    for (const bucket of folderBuckets) {
      if (countLayer("code") >= codeBudget) {
        break;
      }
      const root = bucket[round];
      if (!root || visited.has(root.id)) {
        continue;
      }
      pickedAny = true;
      const queue = [root.id];
      while (queue.length > 0 && countLayer("code") < codeBudget) {
        const id = queue.shift()!;
        if (visited.has(id)) {
          continue;
        }
        visited.add(id);
        const node = nodeMap.get(id);
        if (!node || viewLayerForType(node.type) !== "code") {
          continue;
        }
        selected.push(node);
        for (const neighbor of adj.get(id) ?? []) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }
    round += 1;
    if (!pickedAny) {
      break;
    }
  }

  if (countLayer("code") < codeBudget) {
    const fallbackRoots = fileCandidates.filter((node) => !visited.has(node.id));
    for (const root of fallbackRoots) {
      if (countLayer("code") >= codeBudget) {
        break;
      }
      const queue = [root.id];
      while (queue.length > 0 && countLayer("code") < codeBudget) {
        const id = queue.shift()!;
        if (visited.has(id)) {
          continue;
        }
        visited.add(id);
        const node = nodeMap.get(id);
        if (!node || viewLayerForType(node.type) !== "code") {
          continue;
        }
        selected.push(node);
        for (const neighbor of adj.get(id) ?? []) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }
  }

  const sortedLearning = [...learningNodes].sort((a, b) => {
    const aTopic = isWorkbenchTopicNode(a) ? 2 : isDialogueTurnNode(a) ? 1 : 0;
    const bTopic = isWorkbenchTopicNode(b) ? 2 : isDialogueTurnNode(b) ? 1 : 0;
    if (aTopic !== bTopic) return bTopic - aTopic;
    const aSeq = typeof a.metadata?.seq === "number" ? a.metadata.seq : 0;
    const bSeq = typeof b.metadata?.seq === "number" ? b.metadata.seq : 0;
    if (aSeq !== bSeq) return bSeq - aSeq;
    return degree(b.id) - degree(a.id);
  });
  for (const node of sortedLearning) {
    if (countLayer("learning") >= learningBudget || selected.length >= nodeLimit) {
      break;
    }
    if (visited.has(node.id)) {
      continue;
    }
    visited.add(node.id);
    selected.push(node);
  }

  if (selected.length === 0) {
    const fallbackPool = [
      ...nodes
        .filter((node) => node.type === "File")
        .sort((a, b) => degree(b.id) - degree(a.id)),
      ...nodes
        .filter((node) => node.type === "Module")
        .sort((a, b) => degree(b.id) - degree(a.id)),
      ...nodes
        .filter((node) => viewLayerForType(node.type) === "code" && node.type !== "File" && node.type !== "Module")
        .sort((a, b) => degree(b.id) - degree(a.id)),
    ];
    for (const node of fallbackPool) {
      if (selected.length >= nodeLimit) {
        break;
      }
      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);
      selected.push(node);
    }
  }

  const sampleNodeIds = new Set(selected.map((node) => node.id));

  const visibleEdges = sortSnapshotEdges(
    edges.filter((edge) => sampleNodeIds.has(edge.from) && sampleNodeIds.has(edge.to))
  );

  return {
    sampleNodes: selected.map((node) => enrichNodeForSnapshot(node, 160, workspace)),
    sampleEdges: visibleEdges.slice(0, edgeLimit).map((edge) => ({
        from: edge.from,
        relation: edge.relation,
        to: edge.to,
      })),
  };
}
