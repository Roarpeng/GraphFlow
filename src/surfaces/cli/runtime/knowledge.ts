import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

import type { GraphEdge } from "../../../core/types";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { resolveConfig } from "../../../config/resolve";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import {
  extractEngineeringKnowledgeGraphFragment,
  type KnowledgeTurnRecord,
} from "../../../graph/knowledge-extraction";
import {
  parseSkillMarkdown,
  skillToSkillMarkdown,
} from "../../../learning/skill-markdown";
import { parseSkillState, serializeAtomic } from "../../../learning/skill-store";
import { dialogueSessionIdFor, listDialogueTurns } from "../../../learning/dialogue-thread";

function resolveRuntimeConfig(
  configPath?: string,
  rootDir?: string
) {
  const resolved = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  return bindRuntimeWorkspaceRoot(
    resolved,
    rootDir
      ? { rootDir }
      : resolved.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolved.graphPolicy.workspaceRoot }
        : undefined
  );
}

export interface SkillMarkdownExportResult {
  outputDir: string;
  fileCount: number;
  bytes: number;
  skippedComposites: number;
}

export async function exportSkillsToMarkdownRuntime(
  configPath?: string,
  options?: { rootDir?: string; outputDir?: string }
): Promise<SkillMarkdownExportResult> {
  const config = resolveRuntimeConfig(configPath, options?.rootDir);
  const client = createGraphClient(config);
  const snapshot = client.readSnapshot?.() ?? { nodes: [], edges: [] };
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const outputDir = options?.outputDir
    ? (isAbsolute(options.outputDir)
      ? options.outputDir
      : join(workspaceRoot, options.outputDir))
    : join(workspaceRoot, ".graphflow", "skills", "markdown");
  mkdirSync(outputDir, { recursive: true });

  let bytes = 0;
  let fileCount = 0;
  let skippedComposites = 0;
  const usedNames = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.type !== "Skill") continue;
    const state = parseSkillState(node.content);
    if (!state) {
      if (node.content.includes('"kind":"composite"')) skippedComposites += 1;
      continue;
    }
    const base = state.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
    let fileName = `${base}.md`;
    let suffix = 2;
    while (usedNames.has(fileName.toLowerCase())) {
      fileName = `${base}-${suffix}.md`;
      suffix += 1;
    }
    usedNames.add(fileName.toLowerCase());
    const markdown = skillToSkillMarkdown(state);
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, markdown, "utf8");
    bytes += Buffer.byteLength(markdown);
    fileCount += 1;
  }
  return { outputDir, fileCount, bytes, skippedComposites };
}

export interface SkillMarkdownImportResult {
  inputPath: string;
  imported: number;
  updated: number;
  skipped: number;
  total: number;
}

function collectMarkdownFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(child));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(child);
  }
  return files.sort();
}

async function existingSkillUpdatedAt(client: GraphClient, id: string): Promise<number | undefined> {
  const hits = await (client.getNodesByIds?.([id]) ?? client.queryByKeyword(id));
  const node = hits.find((item) => item.id === id && item.type === "Skill");
  if (!node) return undefined;
  const parsed = parseSkillState(node.content);
  return parsed?.updatedAt;
}

export async function importSkillsFromMarkdownRuntime(
  configPath?: string,
  options?: { rootDir?: string; inputPath?: string; force?: boolean }
): Promise<SkillMarkdownImportResult> {
  const config = resolveRuntimeConfig(configPath, options?.rootDir);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const rawInput = options?.inputPath ?? join(workspaceRoot, ".graphflow", "skills", "markdown");
  const inputPath = isAbsolute(rawInput) ? rawInput : join(workspaceRoot, rawInput);
  if (!existsSync(inputPath)) {
    throw new Error(`SKILL.md input path does not exist: ${inputPath}`);
  }

  const files = collectMarkdownFiles(inputPath);
  const client = createGraphClient(config);
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const file of files) {
    const state = parseSkillMarkdown(readFileSync(file, "utf8"));
    if (!state) {
      skipped += 1;
      continue;
    }
    const previousUpdatedAt = await existingSkillUpdatedAt(client, state.id);
    if (
      previousUpdatedAt !== undefined &&
      !options?.force &&
      previousUpdatedAt >= state.updatedAt
    ) {
      skipped += 1;
      continue;
    }
    await client.upsertNodes([{ id: state.id, type: "Skill", content: serializeAtomic(state) }]);
    if (previousUpdatedAt === undefined) imported += 1;
    else updated += 1;
  }
  return { inputPath, imported, updated, skipped, total: files.length };
}

export interface DialogueKnowledgeExtractionResult {
  scannedTurns: number;
  requirements: number;
  concepts: number;
  edges: number;
  applied: boolean;
}

export async function extractDialogueKnowledgeRuntime(
  configPath?: string,
  options?: {
    rootDir?: string;
    sessionId?: string;
    all?: boolean;
    limit?: number;
    apply?: boolean;
  }
): Promise<DialogueKnowledgeExtractionResult> {
  const config = resolveRuntimeConfig(configPath, options?.rootDir);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const sessionId = options?.all || !options?.sessionId
    ? undefined
    : options.sessionId.startsWith("dialogue-session:")
      ? options.sessionId
      : dialogueSessionIdFor(options.sessionId, workspaceRoot);
  const client = createGraphClient(config);
  const turns = await listDialogueTurns(client, {
    ...(sessionId ? { sessionId } : {}),
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
  });
  const records: KnowledgeTurnRecord[] = turns.map((turn) => ({
    turnId: turn.id,
    query: turn.userQuery,
    reply: turn.assistantReply,
  }));
  const fragment = extractEngineeringKnowledgeGraphFragment({ turns: records });

  // The extractor records source turn IDs in metadata. Emit one provenance
  // edge per actual dialogue-turn node so Concept/Requirement remain auditable.
  const edges: GraphEdge[] = [];
  for (const node of fragment.nodes) {
    const metadata = node.metadata as {
      sourceTurnIds?: string[];
    };
    for (const sourceId of metadata.sourceTurnIds ?? []) {
      edges.push({ from: node.id, to: sourceId, relation: "derived_from" });
    }
  }

  const apply = options?.apply ?? true;
  if (apply) {
    if (fragment.nodes.length > 0) await client.upsertNodes(fragment.nodes);
    if (edges.length > 0) await client.upsertEdges(edges);
  }
  return {
    scannedTurns: turns.length,
    requirements: fragment.nodes.filter((node) => node.type === "Requirement").length,
    concepts: fragment.nodes.filter((node) => node.type === "Concept").length,
    edges: edges.length,
    applied: apply,
  };
}
