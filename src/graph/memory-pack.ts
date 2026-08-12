import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode } from "../core/types";
import type { GraphFlowConfig } from "../config/schema";
import type { SkillOutcomeKind } from "../learning/skill-types";
import { loadGraphStore } from "../surfaces/cli/runtime/helpers";
import { logger } from "../utils/logger";

/**
 * Human-readable engineering-memory pack — companion to the binary graph
 * artifact. Exports Skills + recent Episodes as Markdown for review, onboarding,
 * and git-friendly organizational memory (not a substitute for skill sync /
 * graph artifact import).
 */

const DEFAULT_EPISODE_LIMIT = 40;
const TASK_TRUNCATE = 160;
const GUIDANCE_TRUNCATE = 240;

export interface MemoryPackSkillRow {
  name: string;
  score: number;
  uses: number;
  outcomeKind: SkillOutcomeKind | "unknown";
  guidance: string;
}

export interface MemoryPackEpisodeRow {
  id: string;
  task: string;
  outcome: string;
  lessons: string[];
  updatedAt: number;
}

export interface MemoryPackContent {
  skills: MemoryPackSkillRow[];
  episodes: MemoryPackEpisodeRow[];
  generatedAt: string;
}

export interface MemoryPackExportResult {
  path: string;
  files: string[];
  skillCount: number;
  episodeCount: number;
}

function truncate(text: string, max: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= max) return compacted;
  return `${compacted.slice(0, Math.max(0, max - 1))}…`;
}

function parseOutcomeKind(value: unknown): SkillOutcomeKind | "unknown" {
  if (
    value === "proven" ||
    value === "correctable" ||
    value === "anti-pattern" ||
    value === "noise"
  ) {
    return value;
  }
  return "unknown";
}

/** Collect skill + episode rows from a graph node list (pure; test-friendly). */
export function collectMemoryPackFromNodes(
  nodes: GraphNode[],
  options?: { episodeLimit?: number }
): MemoryPackContent {
  const skills: MemoryPackSkillRow[] = [];
  for (const node of nodes) {
    if (node.type !== "Skill") continue;
    try {
      const parsed = JSON.parse(node.content) as {
        name?: unknown;
        score?: unknown;
        uses?: unknown;
        outcomeKind?: unknown;
        guidance?: unknown;
        hidden?: unknown;
      };
      if (parsed.hidden === true) continue;
      if (typeof parsed.name !== "string" || !parsed.name.trim()) continue;
      skills.push({
        name: parsed.name.trim(),
        score: typeof parsed.score === "number" ? parsed.score : 0,
        uses: typeof parsed.uses === "number" ? parsed.uses : 0,
        outcomeKind: parseOutcomeKind(parsed.outcomeKind),
        guidance:
          typeof parsed.guidance === "string" && parsed.guidance.trim()
            ? truncate(parsed.guidance, GUIDANCE_TRUNCATE)
            : "",
      });
    } catch {
      // skip malformed skill payloads
    }
  }
  skills.sort((a, b) => b.uses - a.uses || b.score - a.score || a.name.localeCompare(b.name));

  const episodes: MemoryPackEpisodeRow[] = [];
  for (const node of nodes) {
    if (node.type !== "Decision") continue;
    const kind = typeof node.metadata?.kind === "string" ? node.metadata.kind : undefined;
    if (kind !== "episode") continue;
    try {
      const record = JSON.parse(
        typeof node.metadata?.record === "string" ? node.metadata.record : "{}"
      ) as {
        id?: unknown;
        task?: unknown;
        outcome?: unknown;
        lessons?: unknown;
        updatedAt?: unknown;
      };
      const lessons = Array.isArray(record.lessons)
        ? record.lessons.filter((l): l is string => typeof l === "string").slice(0, 4)
        : [];
      const taskRaw =
        typeof record.task === "string" && record.task.trim()
          ? record.task
          : typeof node.content === "string"
            ? node.content
            : "";
      episodes.push({
        id: typeof record.id === "string" ? record.id : node.id,
        task: truncate(taskRaw, TASK_TRUNCATE),
        outcome: typeof record.outcome === "string" ? record.outcome : "pending",
        lessons,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      });
    } catch {
      // skip malformed episode payloads
    }
  }
  episodes.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = options?.episodeLimit ?? DEFAULT_EPISODE_LIMIT;

  return {
    skills,
    episodes: episodes.slice(0, limit),
    generatedAt: new Date().toISOString(),
  };
}

export function formatMemoryPackReadme(content: MemoryPackContent): string {
  return [
    "# GraphFlow experience memory pack",
    "",
    "Human-readable export of **organizational engineering memory** from this workspace:",
    "",
    "- **skills.md** — learned Skill nodes (name, score, uses, outcomeKind, short guidance)",
    "- **episodes.md** — recent task episodes (outcome + lessons)",
    "",
    "This pack is for review, onboarding, and sharing narrative memory. It does **not** replace:",
    "",
    "- `graphflow artifact export` / `import` — full graph snapshot",
    "- `graphflow skill sync` — scored skill package with MERGE semantics",
    "",
    "See [docs/experience-memory.md](../../docs/experience-memory.md) for Storage → Reflection → Experience framing.",
    "",
    `| Generated | ${content.generatedAt} |`,
    `| Skills | ${content.skills.length} |`,
    `| Episodes (listed) | ${content.episodes.length} |`,
    "",
  ].join("\n");
}

export function formatSkillsMarkdown(skills: MemoryPackSkillRow[]): string {
  const lines = [
    "# Skills",
    "",
    "Learned Skill nodes from the Experience layer (hidden skills omitted).",
    "",
  ];
  if (skills.length === 0) {
    lines.push("_No Skill nodes in the graph store._", "");
    return lines.join("\n");
  }
  lines.push("| Name | Score | Uses | Outcome | Guidance |", "| --- | ---: | ---: | --- | --- |");
  for (const s of skills) {
    const guidance = s.guidance ? s.guidance.replace(/\|/g, "\\|") : "—";
    lines.push(
      `| ${s.name.replace(/\|/g, "\\|")} | ${s.score} | ${s.uses} | ${s.outcomeKind} | ${guidance} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function formatEpisodesMarkdown(episodes: MemoryPackEpisodeRow[]): string {
  const lines = [
    "# Episodes",
    "",
    "Recent episodic memory (task truncated; newest first).",
    "",
  ];
  if (episodes.length === 0) {
    lines.push("_No episode Decision nodes in the graph store._", "");
    return lines.join("\n");
  }
  for (const ep of episodes) {
    lines.push(`## ${ep.id}`);
    lines.push("");
    lines.push(`- **Outcome:** ${ep.outcome}`);
    if (ep.updatedAt > 0) {
      lines.push(`- **Updated:** ${new Date(ep.updatedAt).toISOString()}`);
    }
    lines.push(`- **Task:** ${ep.task || "—"}`);
    if (ep.lessons.length > 0) {
      lines.push("- **Lessons:**");
      for (const lesson of ep.lessons) {
        lines.push(`  - ${lesson}`);
      }
    } else {
      lines.push("- **Lessons:** _(none)_");
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Write a Markdown experience-memory pack under `graphflow-out/memory-pack/`
 * (or a custom output directory).
 */
export function exportExperienceMemoryPack(
  config: GraphFlowConfig,
  outputDir?: string,
  options?: { episodeLimit?: number; clientSnapshot?: { nodes: GraphNode[] } }
): MemoryPackExportResult {
  const store = options?.clientSnapshot ?? loadGraphStore(config);
  const content = collectMemoryPackFromNodes(
    store.nodes,
    options?.episodeLimit !== undefined ? { episodeLimit: options.episodeLimit } : undefined
  );

  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const targetDir = outputDir
    ? outputDir.startsWith("/") || /^[A-Za-z]:/.test(outputDir)
      ? outputDir
      : join(root, outputDir)
    : join(root, "graphflow-out", "memory-pack");

  mkdirSync(targetDir, { recursive: true });

  const files = ["README.md", "skills.md", "episodes.md"] as const;
  const payloads: Record<(typeof files)[number], string> = {
    "README.md": formatMemoryPackReadme(content),
    "skills.md": formatSkillsMarkdown(content.skills),
    "episodes.md": formatEpisodesMarkdown(content.episodes),
  };

  for (const name of files) {
    writeFileSync(join(targetDir, name), payloads[name], "utf8");
  }

  logger.info(
    { path: targetDir, skills: content.skills.length, episodes: content.episodes.length },
    "Experience memory pack exported"
  );

  return {
    path: targetDir,
    files: [...files],
    skillCount: content.skills.length,
    episodeCount: content.episodes.length,
  };
}
