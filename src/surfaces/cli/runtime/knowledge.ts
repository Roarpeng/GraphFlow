import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

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
  skillDirectoryFor,
  skillToSkillMarkdownBundle,
  toSpecName,
  validateSkillMarkdown,
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
  /** Progressive-disclosure reference files written under <skill>/references/. */
  referenceFileCount: number;
  /** agentskills.io validation violations across exported files (empty = all valid). */
  invalid: Array<{ file: string; violations: string[] }>;
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
  let referenceFileCount = 0;
  const invalid: Array<{ file: string; violations: string[] }> = [];
  const usedDirs = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.type !== "Skill") continue;
    const state = parseSkillState(node.content);
    if (!state) {
      if (node.content.includes('"kind":"composite"')) skippedComposites += 1;
      continue;
    }
    // agentskills.io layout: one directory per skill, SKILL.md inside, and
    // the directory name MUST equal the spec name. Oversized guidance moves
    // to references/ (progressive disclosure) so the body stays a pointer.
    let dirName = skillDirectoryFor(state);
    const base = toSpecName(state.name);
    let suffix = 2;
    while (usedDirs.has(dirName.toLowerCase())) {
      dirName = `${base}-${suffix}`;
      suffix += 1;
    }
    usedDirs.add(dirName.toLowerCase());
    const bundle = skillToSkillMarkdownBundle(state);
    const violations = validateSkillMarkdown(bundle.markdown);
    const relPath = `${dirName}/SKILL.md`;
    if (violations.length > 0) invalid.push({ file: relPath, violations });
    const skillDir = join(outputDir, dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), bundle.markdown, "utf8");
    bytes += Buffer.byteLength(bundle.markdown);
    fileCount += 1;
    for (const reference of bundle.references) {
      const refPath = join(skillDir, ...reference.path.split("/"));
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(refPath, reference.content, "utf8");
      bytes += Buffer.byteLength(reference.content);
      referenceFileCount += 1;
    }
  }
  return { outputDir, fileCount, bytes, skippedComposites, referenceFileCount, invalid };
}

export interface SkillMarkdownImportResult {
  inputPath: string;
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  /** Files rejected by agentskills.io validation (name/description/shape). */
  invalid: Array<{ file: string; violations: string[] }>;
}

/**
 * Collect importable skill markdown files. Spec layout is one directory per
 * skill with SKILL.md inside (plus references/*.md that are NOT skills), so a
 * directory scan only accepts files named SKILL.md. A single explicitly given
 * file may have any name (hand-written or third-party paths).
 */
function collectMarkdownFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return extname(path).toLowerCase() === ".md" ? [path] : [];
  }
  const entries = readdirSync(path, { withFileTypes: true });
  // agentskills.io layout: a directory owning SKILL.md IS a skill directory —
  // collect only that SKILL.md and never descend (references/ etc. are
  // resources of the skill, never importable skills themselves).
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")) {
    return [join(path, "SKILL.md")];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(child));
    // Legacy flat layout: any .md file below a directory that does not own a
    // SKILL.md stays importable.
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(child);
    }
  }
  return files.sort();
}

/** True when the file lives at `<dir>/SKILL.md` (spec layout, not flat legacy). */
function isSpecLayoutFile(file: string): boolean {
  return basename(file).toLowerCase() === "skill.md";
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
  const invalid: Array<{ file: string; violations: string[] }> = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    // Spec gate: reject files that violate agentskills.io shape before parsing.
    // Missing description is advisory (importable); bad name/shape is rejected.
    const violations = validateSkillMarkdown(raw).filter(
      (v) => !v.startsWith("description is required")
    );
    if (violations.length > 0) {
      invalid.push({ file, violations });
      skipped += 1;
      continue;
    }
    const state = parseSkillMarkdown(raw);
    if (!state) {
      skipped += 1;
      continue;
    }
    // agentskills.io: the parent directory name must equal the skill name.
    // Only enforced for spec-layout files; flat legacy exports (name.md at
    // the scan root) stay importable.
    if (isSpecLayoutFile(file)) {
      const parentDir = basename(dirname(file));
      const specName = toSpecName(state.name);
      if (parentDir.toLowerCase() !== specName.toLowerCase()) {
        invalid.push({
          file,
          violations: [
            `directory name "${parentDir}" must equal the skill name "${specName}" (agentskills.io)`,
          ],
        });
        skipped += 1;
        continue;
      }
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
  return { inputPath, imported, updated, skipped, total: files.length, invalid };
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
