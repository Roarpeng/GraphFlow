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
const DEFAULT_DIALOGUE_LIMIT = 30;
const TASK_TRUNCATE = 160;
const GUIDANCE_TRUNCATE = 240;
const QUERY_TRUNCATE = 200;
const REPLY_TRUNCATE = 280;

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

/** Conversation Graph W4b: one dialogue turn row in the exported subgraph. */
export interface MemoryPackDialogueRow {
  id: string;
  sessionId: string;
  seq: number;
  title?: string;
  userQuery: string;
  assistantReply: string;
  jumped: boolean;
  /** Turn ids this answer supersedes (correction chain). */
  supersedesTurnIds?: string[];
  /** Present when this turn's conclusion is no longer current. */
  invalidAt?: number;
  updatedAt: number;
}

/** Conversation Graph W4b: one multi-agent trajectory event row. */
export interface MemoryPackTraceRow {
  id: string;
  sessionId: string;
  turnSeq: number;
  agentKind: string;
  label: string;
  status: string;
  createdAt: number;
}

export interface MemoryPackContent {
  skills: MemoryPackSkillRow[];
  episodes: MemoryPackEpisodeRow[];
  /** Conversation Graph W4b: dialogue-turn subgraph (effective + superseded). */
  dialogues: MemoryPackDialogueRow[];
  /** Conversation Graph W4b: multi-agent trajectory events. */
  traces: MemoryPackTraceRow[];
  generatedAt: string;
}

export interface MemoryPackExportResult {
  path: string;
  files: string[];
  skillCount: number;
  episodeCount: number;
  dialogueCount: number;
  traceCount: number;
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

/** Collect skill + episode + dialogue-subgraph rows from a graph node list (pure; test-friendly). */
export function collectMemoryPackFromNodes(
  nodes: GraphNode[],
  options?: { episodeLimit?: number; dialogueLimit?: number }
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

  // Conversation Graph W4b: dialogue-turn subgraph rows (both effective and
  // superseded turns — the correction chain is the point) plus agent traces.
  const dialogues: MemoryPackDialogueRow[] = [];
  const traces: MemoryPackTraceRow[] = [];
  for (const node of nodes) {
    const kind = typeof node.metadata?.kind === "string" ? node.metadata.kind : "";
    const raw = typeof node.metadata?.record === "string" ? node.metadata.record : undefined;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (kind === "dialogue-turn") {
        if (typeof parsed.id !== "string" || typeof parsed.userQuery !== "string") continue;
        dialogues.push({
          id: parsed.id,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
          seq: typeof parsed.seq === "number" ? parsed.seq : 0,
          ...(typeof parsed.title === "string" ? { title: truncate(parsed.title, 60) } : {}),
          userQuery: truncate(parsed.userQuery, QUERY_TRUNCATE),
          assistantReply:
            typeof parsed.assistantReply === "string"
              ? truncate(parsed.assistantReply, REPLY_TRUNCATE)
              : "",
          jumped: parsed.jumped === true,
          ...(Array.isArray(parsed.supersedesTurnIds)
            ? {
                supersedesTurnIds: parsed.supersedesTurnIds.filter(
                  (id): id is string => typeof id === "string"
                ),
              }
            : {}),
          ...(typeof parsed.invalidAt === "number" ? { invalidAt: parsed.invalidAt } : {}),
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        });
      } else if (kind === "agent-trace") {
        if (typeof parsed.id !== "string" || typeof parsed.label !== "string") continue;
        traces.push({
          id: parsed.id,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
          turnSeq: typeof parsed.turnSeq === "number" ? parsed.turnSeq : 0,
          agentKind: typeof parsed.agentKind === "string" ? parsed.agentKind : "",
          label: truncate(parsed.label, 120),
          status: typeof parsed.status === "string" ? parsed.status : "",
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        });
      }
    } catch {
      // skip malformed dialogue/trace payloads
    }
  }
  dialogues.sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq);
  traces.sort((a, b) => b.createdAt - a.createdAt);
  const dialogueLimit = options?.dialogueLimit ?? DEFAULT_DIALOGUE_LIMIT;

  return {
    skills,
    episodes: episodes.slice(0, limit),
    dialogues: dialogues.slice(0, dialogueLimit),
    traces: traces.slice(0, dialogueLimit * 2),
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
    "- **dialogues.md** — conversation-graph subgraph: dialogue turns (with correction chains) + multi-agent traces",
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
    `| Dialogue turns (listed) | ${content.dialogues.length} |`,
    `| Agent traces (listed) | ${content.traces.length} |`,
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
 * Conversation Graph W4b: render the dialogue subgraph — turns grouped by
 * session spine order, correction chains annotated, agent traces listed per
 * session. Newest sessions first; superseded turns keep their historical
 * text but are explicitly marked so onboarding readers see current truth.
 */
export function formatDialoguesMarkdown(content: {
  dialogues: MemoryPackDialogueRow[];
  traces: MemoryPackTraceRow[];
}): string {
  const lines = [
    "# Dialogue graph",
    "",
    "Conversation-graph subgraph: dialogue turns (correction chains marked) + multi-agent traces. Superseded turns are historical context — the latest turn on a chain carries the current conclusion.",
    "",
  ];
  const { dialogues, traces } = content;
  if (dialogues.length === 0 && traces.length === 0) {
    lines.push("_No dialogue-turn or agent-trace nodes in the graph store._", "");
    return lines.join("\n");
  }

  const bySession = new Map<string, MemoryPackDialogueRow[]>();
  for (const turn of dialogues) {
    const list = bySession.get(turn.sessionId) ?? [];
    list.push(turn);
    bySession.set(turn.sessionId, list);
  }
  const sessionOrder = [...bySession.keys()];
  const sessionLatest = (sid: string) =>
    Math.max(...(bySession.get(sid) ?? []).map((t) => t.updatedAt), 0);
  sessionOrder.sort((a, b) => sessionLatest(b) - sessionLatest(a));

  for (const sessionId of sessionOrder) {
    const turns = (bySession.get(sessionId) ?? []).slice().sort((a, b) => a.seq - b.seq);
    lines.push(`## Session \`${sessionId}\``, "");
    for (const turn of turns) {
      const marks: string[] = [];
      if (turn.invalidAt !== undefined) marks.push("superseded");
      if (turn.jumped) marks.push("jump");
      if (turn.supersedesTurnIds && turn.supersedesTurnIds.length > 0) marks.push("corrects earlier");
      const mark = marks.length > 0 ? ` _(${marks.join(", ")})_` : "";
      lines.push(`- **#${turn.seq}${mark}** ${turn.userQuery || "(pending)"}`);
      if (turn.assistantReply) {
        lines.push(`  - A: ${turn.assistantReply}`);
      }
    }
    const sessionTraces = traces.filter((t) => t.sessionId === sessionId);
    if (sessionTraces.length > 0) {
      lines.push("", `**Agent traces:**`);
      for (const trace of sessionTraces.slice(0, 12)) {
        lines.push(`- T#${trace.turnSeq} ${trace.agentKind}/${trace.status}: ${trace.label}`);
      }
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
  options?: {
    episodeLimit?: number;
    dialogueLimit?: number;
    clientSnapshot?: { nodes: GraphNode[] };
  }
): MemoryPackExportResult {
  const store = options?.clientSnapshot ?? loadGraphStore(config);
  const content = collectMemoryPackFromNodes(store.nodes, {
    ...(options?.episodeLimit !== undefined ? { episodeLimit: options.episodeLimit } : {}),
    ...(options?.dialogueLimit !== undefined ? { dialogueLimit: options.dialogueLimit } : {}),
  });

  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const targetDir = outputDir
    ? outputDir.startsWith("/") || /^[A-Za-z]:/.test(outputDir)
      ? outputDir
      : join(root, outputDir)
    : join(root, "graphflow-out", "memory-pack");

  mkdirSync(targetDir, { recursive: true });

  const files = ["README.md", "skills.md", "episodes.md", "dialogues.md"] as const;
  const payloads: Record<(typeof files)[number], string> = {
    "README.md": formatMemoryPackReadme(content),
    "skills.md": formatSkillsMarkdown(content.skills),
    "episodes.md": formatEpisodesMarkdown(content.episodes),
    "dialogues.md": formatDialoguesMarkdown(content),
  };

  for (const name of files) {
    writeFileSync(join(targetDir, name), payloads[name], "utf8");
  }

  logger.info(
    {
      path: targetDir,
      skills: content.skills.length,
      episodes: content.episodes.length,
      dialogues: content.dialogues.length,
      traces: content.traces.length,
    },
    "Experience memory pack exported"
  );

  return {
    path: targetDir,
    files: [...files],
    skillCount: content.skills.length,
    episodeCount: content.episodes.length,
    dialogueCount: content.dialogues.length,
    traceCount: content.traces.length,
  };
}
