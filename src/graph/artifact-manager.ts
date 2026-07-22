import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";
import { loadGraphStore } from "../surfaces/cli/runtime/helpers";
import type { GraphFlowConfig } from "../config/schema";

import { logger } from "../utils/logger";

/**
 * Team artifact sharing — borrowed from codebase-memory-mcp's graph.db.zst pattern.
 *
 * Exports the graph store as a compressed JSON artifact that can be committed
 * to git and shared with teammates. Teammates import the artifact on first run
 * to avoid a full workspace re-index.
 *
 * The .gitattributes file should mark the artifact as `merge=ours` to avoid
 * binary merge conflicts when multiple team members push updated artifacts.
 *
 * Compression: uses gzip (Node.js built-in zlib) to produce a binary artifact
 * (.artifact.gz) analogous to codebase-memory-mcp's graph.db.zst. This keeps
 * the artifact small enough to commit without bloating the git history.
 */

const ARTIFACT_VERSION = 2;

export interface GraphArtifact {
  version: number;
  createdAt: string;
  workspaceRoot: string;
  nodeCount: number;
  edgeCount: number;
  sha256: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExportResult {
  path: string;
  nodeCount: number;
  edgeCount: number;
  bytes: number;
  uncompressedBytes: number;
  sha256: string;
  compression: "none" | "gzip";
}

export interface ImportResult {
  path: string;
  nodeCount: number;
  edgeCount: number;
  imported: boolean;
  skipped: boolean;
  reason?: string;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function isGzipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1];
}

/**
 * Export the current graph store to a portable artifact file.
 *
 * The artifact is a gzip-compressed JSON file (analogous to codebase-memory-mcp's
 * graph.db.zst). This allows teammates to skip the initial full workspace index
 * by importing the artifact instead.
 *
 * @param config GraphFlow config
 * @param outputPath Optional output path (defaults to graphflow-out/graphflow-graph.artifact.gz)
 * @param client Optional graph client (if not provided, reads from store file)
 * @param options Optional export options (compression: "gzip" | "none")
 */
export function exportGraphArtifact(
  config: GraphFlowConfig,
  outputPath?: string,
  client?: GraphClient,
  options?: { compression?: "gzip" | "none"; includeEpisodes?: boolean }
): ExportResult {
  const store = client?.readSnapshot
    ? client.readSnapshot()
    : loadGraphStore(config);

  if (store.nodes.length === 0) {
    throw new Error(
      "Graph store is empty. Run `graphflow graph index` before exporting."
    );
  }

  const includeEpisodes = options?.includeEpisodes ?? false;
  const nodes = includeEpisodes
    ? store.nodes
    : store.nodes.filter((n) => !n.id.startsWith("episode:"));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = includeEpisodes
    ? store.edges
    : store.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const compression = options?.compression ?? "gzip";
  const defaultExt = compression === "gzip" ? "graphflow-graph.artifact.gz" : "graphflow-graph.artifact.json";
  const targetPath = outputPath
    ? (outputPath.startsWith("/") || /^[A-Za-z]:/.test(outputPath)
      ? outputPath
      : join(root, outputPath))
    : join(root, "graphflow-out", defaultExt);

  mkdirSync(dirname(targetPath), { recursive: true });

  const artifact: GraphArtifact = {
    version: ARTIFACT_VERSION,
    createdAt: new Date().toISOString(),
    workspaceRoot: root,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    sha256: "",
    nodes,
    edges,
  };

  const contentForHash = JSON.stringify({
    version: artifact.version,
    nodes: artifact.nodes,
    edges: artifact.edges,
  });
  artifact.sha256 = createHash("sha256").update(contentForHash).digest("hex");

  const json = JSON.stringify(artifact, null, 0);
  const uncompressedBytes = Buffer.byteLength(json, "utf8");

  if (compression === "gzip") {
    const compressed = gzipSync(Buffer.from(json, "utf8"));
    writeFileSync(targetPath, compressed);
  } else {
    writeFileSync(targetPath, json, "utf8");
  }

  const bytes = statSync(targetPath).size;
  const ratio = uncompressedBytes > 0 ? (bytes / uncompressedBytes).toFixed(3) : "0";
  logger.info(
    { path: targetPath, nodes: nodes.length, edges: edges.length, bytes, uncompressedBytes, ratio, compression },
    "Graph artifact exported"
  );

  return {
    path: targetPath,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    bytes,
    uncompressedBytes,
    sha256: artifact.sha256,
    compression,
  };
}

/**
 * Import a graph artifact file into the current graph store.
 *
 * Teammates can run this after cloning a repo to skip the initial full
 * workspace index. The artifact is merged into the existing store (upsert).
 * Supports both gzip-compressed (.gz) and plain JSON (.json) artifacts.
 *
 * @param config GraphFlow config
 * @param client Graph client for writing
 * @param inputPath Optional input path (defaults to graphflow-out/graphflow-graph.artifact.gz)
 */
export async function importGraphArtifact(
  config: GraphFlowConfig,
  client: GraphClient,
  inputPath?: string
): Promise<ImportResult> {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const sourcePath = inputPath
    ? (inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)
      ? inputPath
      : join(root, inputPath))
    : join(root, "graphflow-out", "graphflow-graph.artifact.gz");

  if (!existsSync(sourcePath)) {
    // Fallback: try .json extension if .gz not found
    const jsonFallback = sourcePath.replace(/\.gz$/, ".json");
    if (jsonFallback !== sourcePath && existsSync(jsonFallback)) {
      return importGraphArtifact(config, client, jsonFallback);
    }
    return {
      path: sourcePath,
      nodeCount: 0,
      edgeCount: 0,
      imported: false,
      skipped: true,
      reason: "Artifact file not found",
    };
  }

  const raw = readFileSync(sourcePath);
  let jsonText: string;

  // Auto-detect gzip vs plain JSON
  if (isGzipBuffer(raw)) {
    try {
      jsonText = gunzipSync(raw).toString("utf8");
    } catch {
      throw new Error(`Failed to decompress gzip artifact: ${sourcePath}`);
    }
  } else {
    jsonText = raw.toString("utf8");
  }

  let artifact: GraphArtifact;
  try {
    artifact = JSON.parse(jsonText) as GraphArtifact;
  } catch {
    throw new Error(`Failed to parse artifact file: ${sourcePath}`);
  }

  if (artifact.version !== ARTIFACT_VERSION) {
    logger.warn(
      { expected: ARTIFACT_VERSION, got: artifact.version },
      "Artifact version mismatch — attempting import anyway"
    );
  }

  // Verify checksum
  const contentForHash = JSON.stringify({
    version: artifact.version,
    nodes: artifact.nodes,
    edges: artifact.edges,
  });
  const computedHash = createHash("sha256").update(contentForHash).digest("hex");
  if (artifact.sha256 && computedHash !== artifact.sha256) {
    throw new Error(
      `Artifact checksum mismatch — file may be corrupted. Expected ${artifact.sha256}, got ${computedHash}`
    );
  }

  // Upsert nodes and edges into the graph store
  if (client.upsertNodes) {
    await client.upsertNodes(artifact.nodes);
  }
  if (client.upsertEdges) {
    await client.upsertEdges(artifact.edges);
  }

  logger.info(
    { path: sourcePath, nodes: artifact.nodes.length, edges: artifact.edges.length },
    "Graph artifact imported"
  );

  return {
    path: sourcePath,
    nodeCount: artifact.nodes.length,
    edgeCount: artifact.edges.length,
    imported: true,
    skipped: false,
  };
}

/**
 * Generate a .gitattributes file that marks the graph artifact as merge=ours.
 *
 * This prevents merge conflicts when multiple team members push updated
 * graph artifacts — git will always keep the local version during merges.
 *
 * @param workspaceRoot Workspace root path
 * @param artifactRelativePath Relative path to the artifact (e.g. "graphflow-out/graphflow-graph.artifact.gz")
 */
export function ensureGitAttributesForArtifact(
  workspaceRoot: string,
  artifactRelativePath = "graphflow-out/graphflow-graph.artifact.gz"
): { path: string; created: boolean; content: string } {
  const gitattributesPath = join(workspaceRoot, ".gitattributes");
  const entry = `${artifactRelativePath} merge=ours`;

  let existingContent = "";
  if (existsSync(gitattributesPath)) {
    existingContent = readFileSync(gitattributesPath, "utf8");
    if (existingContent.includes(artifactRelativePath)) {
      return {
        path: gitattributesPath,
        created: false,
        content: existingContent,
      };
    }
  }

  const newContent = existingContent
    ? `${existingContent.trimEnd()}\n${entry}\n`
    : `${entry}\n`;

  writeFileSync(gitattributesPath, newContent, "utf8");

  logger.info({ path: gitattributesPath, entry }, "Added merge=ours to .gitattributes");

  return {
    path: gitattributesPath,
    created: !existingContent,
    content: newContent,
  };
}
