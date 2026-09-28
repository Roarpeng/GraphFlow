import { createHash } from "node:crypto";
import type { GraphEdge, GraphNode } from "../core/types";
import { buildRefResolver } from "../learning/memory-freshness.js";
import { estimateTokens } from "./context-slicer-utils.js";

/**
 * Project Brief — the stable prefix GraphFlow actually owns.
 *
 * The previous commit made the Prefix Cache Planner declare which of our lines
 * are stable, and a live run found only 2 of 39 lines were: 19 of 790 tokens.
 * A correct declaration of "almost nothing here is stable" is not a
 * cache strategy. The stable segment has to be *made* stable, or the host has
 * nothing worth putting before its breakpoint.
 *
 * The Brief is that segment. It is derived from the repository itself — module
 * map, exports, reference hotspots, file inventory, entry points — none of which
 * is a function of the current question. It is built once, then REUSED until
 * validation says the repository moved under it.
 *
 * ## What is deliberately NOT in here
 *
 * The graph is full of genuinely useful nodes that would destroy this segment if
 * included, and the temptation is real because they are exactly what an agent
 * might want:
 *
 *  - **Decision and dialogue nodes.** They accumulate as a session runs, so a
 *    brief built from them would change on every turn — reproducing the exact
 *    churn this segment exists to eliminate. Stable is not the same as useful.
 *  - **Per-turn query anchors.** By definition a function of the question.
 *
 * So the brief draws only on code structure, which changes when the code
 * changes and not when the agent asks something new.
 *
 * ## Why "validate then reuse" and not "recompute every time"
 *
 * Rebuilding the brief on every call would be self-defeating for the same
 * reason abstention was: it would produce a fresh package per turn, which is
 * precisely the churn that costs the host its cache. Worse, recomputation is
 * the expensive part — a module walk and an export scan per call.
 *
 * So reuse is gated on evidence, in the same spirit as the freshness oracle:
 * a brief is a claim about the repository, and symbol node ids embed a content
 * hash, so if every ref the brief was built from still resolves, the claim
 * still holds. When it does not, the brief is recomputed — loudly, with the
 * reason attached, because a silently-stale brief is a wrong map of the project
 * and a much worse failure than a slightly larger token count.
 *
 * ## The plugin boundary
 *
 * The Brief is content, not a decision. It does not set breakpoints, reorder a
 * host's prompt, or gate a tool call. A host that ignores it loses a cache
 * optimisation and nothing else.
 */

export const PROJECT_BRIEF_ENV = "GRAPHFLOW_PROJECT_BRIEF";

/** Node types the brief is allowed to derive claims from. */
const BRIEF_NODE_TYPES: ReadonlySet<GraphNode["type"]> = new Set(["Module", "File", "Concept"]);

export interface ProjectBrief {
  /**
   * The stable lines, in a deterministic order. Ordering is part of the
   * contract: byte-identical output is what lets a host's cache hit, so this
   * must never depend on iteration order, timestamps or counts.
   */
  lines: string[];
  tokens: number;
  /**
   * Paths dropped because they resolve outside the workspace. Reported, never
   * silently: a brief that maps someone else's directories is not a wrong
   * answer, it is a misleading one, and the caller deserves to know the map was
   * filtered rather than complete.
   */
  outOfScopePaths: number;
  /**
   * Ids the brief was derived from. Every one must still resolve for the brief
   * to be reusable — this is the validation surface, and it is deliberately the
   * same trick the freshness oracle uses: symbol ids embed content hashes, so a
   * moved or edited symbol retires its id and the brief's claim fails loudly.
   */
  refs: string[];
  /** Fingerprint of the brief's own bytes. Equal fingerprints => equal content. */
  fingerprint: string;
}

export interface BriefValidity {
  valid: boolean;
  /** Refs from the stored brief that no longer resolve. */
  deadRefs: string[];
  reason: string;
}

/**
 * Does this brief still describe the repository?
 *
 * Reuses the freshness oracle's resolver rather than inventing a second one:
 * the question ("does this ref still name something in the graph?") is the same
 * question, and two resolvers would eventually disagree — which is the kind of
 * drift that turns a cache into a source of wrong answers.
 */
export function validateProjectBrief(
  brief: ProjectBrief,
  nodes: ReadonlyArray<{ id: string; type?: string; label?: string }>
): BriefValidity {
  if (brief.refs.length === 0) {
    return { valid: false, deadRefs: [], reason: "brief has no refs to validate against" };
  }
  const resolves = buildRefResolver(nodes);
  const deadRefs = brief.refs.filter((ref) => !resolves(ref));
  if (deadRefs.length === 0) {
    return {
      valid: true,
      deadRefs: [],
      reason: `all ${brief.refs.length} refs still resolve — brief is reusable as-is`,
    };
  }
  return {
    valid: false,
    deadRefs,
    reason: `${deadRefs.length}/${brief.refs.length} refs no longer resolve (e.g. ${deadRefs
      .slice(0, 2)
      .join(", ")}) — repository moved under the brief, rebuild required`,
  };
}

/** Stable, sorted, content-derived. No Date, no Math.random, no iteration order. */
function fingerprintOf(lines: readonly string[]): string {
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Build the brief from a node snapshot.
 *
 * Three sections, in this order and always all three (a brief that changes shape
 * between calls is worse than a brief that changes content):
 *   1. module inventory  — one line per module with its path
 *   2. file inventory    — file count by directory
 *   3. entry points      — the files a newcomer would open first
 *
 * The exports-per-module detail lives in the repo map already; repeating it
 * here would trade cache stability for tokens the delta can supply on demand.
 */
export function buildProjectBrief(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = [],
  options: { maxModules?: number; maxFiles?: number; maxPerDirectory?: number; maxExportsPerModule?: number; maxExportLines?: number; maxHotspots?: number } = {}
): ProjectBrief {
  const maxModules = options.maxModules ?? 60;
  const maxFiles = options.maxFiles ?? 40;
  const maxPerDirectory = options.maxPerDirectory ?? 3;
  const maxExportsPerModule = options.maxExportsPerModule ?? 8;
  const maxExportLines = options.maxExportLines ?? 40;
  const maxHotspots = options.maxHotspots ?? 24;

  const briefNodes = nodes.filter((node) => BRIEF_NODE_TYPES.has(node.type));
  const modules = briefNodes.filter((node) => node.type === "Module");
  const files = briefNodes.filter((node) => node.type === "File");

  // A graph can carry nodes from outside the workspace — sibling checkouts, a
  // user's dotfile skill directory, a path that was indexed before the root was
  // set. Those paths are stable too, so they would sail through the stability
  // check while quietly becoming the bulk of the map. A project map that
  // describes other projects is worse than no map: the host caches it, trusts
  // it, and it is confidently wrong.
  let outOfScopePaths = 0;
  const inScope = <T extends GraphNode>(list: T[], pathOf: (node: T) => string): T[] =>
    list.filter((node) => {
      const path = pathOf(node);
      if (path.length > 0 && isOutOfScope(path)) {
        outOfScopePaths += 1;
        return false;
      }
      return true;
    });

  const scopedModules = inScope(modules, modulePathOf);
  const scopedFiles = inScope(files, filePathOf);

  // File counts come first because they double as the module selection's weight
  // function below.
  const byDirectory = new Map<string, number>();
  for (const node of scopedFiles) {
    const path = filePathOf(node);
    if (path.length === 0) continue;
    const dir = directoryOf(path);
    byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + 1);
  }
  const directories = [...byDirectory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const lines: string[] = ["brief: project map (stable across turns)"];

  // ── 1. module inventory ────────────────────────────────────────────────
  // Ranked, not alphabetical. A cap taken in name order spends its whole budget
  // on whichever directory happens to sort first: on this repo that was 60+
  // lines of `.agents/skills/*`, so the "project map" described the user's
  // agent config rather than the project. Dotfile directories are deprioritised
  // — they are tooling configuration, not project structure — and the count is
  // reported rather than dropped.
  const modulePaths = scopedModules
    .map((node) => modulePathOf(node))
    .filter((path) => path.length > 0)
    .sort(compareModulePaths);
  const uniqueModules = [...new Set(modulePaths)];
  // Only paths that look like project structure are listed. A bare name
  // (`argparse`, `AUDIT.md`, `AGENTS`) is not a place in this repository — it is
  // a module node the indexer derived from something that was never a directory
  // here. Those nodes are the majority on a real graph, so listing them would
  // make the map confidently wrong.
  const projectModules = uniqueModules.filter(looksLikeProjectPath);
  const unclassifiable = uniqueModules.length - projectModules.length;
  lines.push(`brief: modules=${uniqueModules.length}`);

  // Selection is by WEIGHT, not by name. Three successive attempts to fix this
  // by ordering alone all failed the same way: any name-ordered cap is consumed
  // by whichever directory happens to sort first, and on this repo that was
  // `benchmarks/*` and `docs/*` — so `src/*`, the part a reader actually needs,
  // never appeared. The file counts already say where the code is, so the map
  // leads with the heaviest directories and spends its budget there. Still
  // capped per directory, so no single corner can dominate even when it is the
  // heaviest.
  const modulesByDirectory = new Map<string, string[]>();
  for (const path of projectModules) {
    const dir = directoryOf(path);
    const bucket = modulesByDirectory.get(dir);
    if (bucket) bucket.push(path);
    else modulesByDirectory.set(dir, [path]);
  }
  const directoryOrder = [...new Set([...modulesByDirectory.keys(), ...byDirectory.keys()])].sort((a, b) => {
    // Heaviest first; unknown directories (modules with no files under them)
    // sink to the bottom rather than inheriting a weight they never earned.
    const weight = (byDirectory.get(b) ?? 0) - (byDirectory.get(a) ?? 0);
    return weight !== 0 ? weight : a.localeCompare(b);
  });

  const selected: string[] = [];
  let overflow = 0;
  for (const dir of directoryOrder) {
    const bucket = modulesByDirectory.get(dir);
    if (!bucket) continue;
    for (const path of bucket.slice(0, maxPerDirectory)) {
      if (selected.length >= maxModules) {
        overflow += 1;
        continue;
      }
      selected.push(path);
    }
    if (selected.length >= maxModules) break;
  }
  overflow += projectModules.length - selected.length - overflow;
  for (const path of selected) {
    lines.push(`module: ${path}`);
  }
  if (overflow > 0) {
    lines.push(`brief: +${overflow} more modules (max ${maxPerDirectory} per directory)`);
  }
  if (unclassifiable > 0) {
    lines.push(`brief: ${unclassifiable} module node(s) not project paths, omitted`);
  }

  // ── 2. file inventory by directory ─────────────────────────────────────
  lines.push(`brief: files=${scopedFiles.length} dirs=${directories.length}`);
  for (const [dir, count] of directories.slice(0, maxFiles)) {
    lines.push(`files: ${dir} (${count})`);
  }

  // ── 3. exports of the heaviest modules ─────────────────────────────────
  // The single most useful thing a brief can say, and the part an earlier
  // version left out to keep itself small. Measured: growing the stable segment
  // from 678 to 2500 tokens roughly triples its per-turn saving, because every
  // token placed before the host's breakpoint is read at 0.1x instead of 1x.
  // "What does this module offer" is what an agent would otherwise spend a file
  // read to learn, so this is the cheapest possible way to hand it over.
  const exportsByFile = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.type !== "Symbol") continue;
    const name = typeof node.metadata?.name === "string" ? node.metadata.name.trim() : "";
    if (name.length === 0 || node.metadata?.exported !== true) continue;
    const file = filePathOf(node);
    if (file.length === 0 || isOutOfScope(file)) continue;
    const bucket = exportsByFile.get(file);
    if (bucket) bucket.add(name);
    else exportsByFile.set(file, new Set([name]));
  }
  // Emitted per file, not per directory: a directory's worth of exports says
  // nothing an agent can act on, whereas "this file offers these symbols" is
  // exactly what it would otherwise spend a file read to learn. Files are walked
  // in directory-weight order so the heaviest code leads, and the cap keeps the
  // section bounded.
  const filesByDirectory = new Map<string, string[]>();
  for (const node of scopedFiles) {
    const file = filePathOf(node);
    if (file.length === 0) continue;
    const dir = directoryOf(file);
    const bucket = filesByDirectory.get(dir);
    if (bucket) bucket.push(file);
    else filesByDirectory.set(dir, [file]);
  }
  let exportLines = 0;
  for (const [dir] of directories) {
    for (const file of (filesByDirectory.get(dir) ?? []).sort()) {
      if (exportLines >= maxExportLines) break;
      const names = exportsByFile.get(file);
      if (!names || names.size === 0) continue;
      lines.push(
        `exports: ${file} -> ${[...names].sort().slice(0, maxExportsPerModule).join(", ")}`
      );
      exportLines += 1;
    }
    if (exportLines >= maxExportLines) break;
  }

  // ── 4. reference hotspots ──────────────────────────────────────────────
  // Where the code actually depends on other code. Derived from edges, so it is
  // as stable as the code, and it tells an agent which modules are load-bearing
  // before it edits anything.
  if (edges.length > 0) {
    const inbound = new Map<string, number>();
    for (const edge of edges) {
      if (edge.relation !== "references" && edge.relation !== "calls" && edge.relation !== "imports") {
        continue;
      }
      const target = moduleKeyOf(edge.to);
      if (target.length === 0 || isOutOfScope(target)) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
    const hotspots = [...inbound.entries()]
      .filter(([path]) => looksLikeProjectPath(path))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxHotspots);
    if (hotspots.length > 0) {
      lines.push(`brief: hotspots=${hotspots.map(([path, count]) => `${path}(${count})`).join(" ")}`);
    }
  }

  // ── 3. entry points ────────────────────────────────────────────────────
  // The conventional openings, in a fixed order. A fixed list (not a heuristic
  // rank) keeps the section byte-stable when the repo changes in ways that do
  // not affect it.
  const ENTRY_CANDIDATES = [
    "package.json",
    "README.md",
    "AGENTS.md",
    "graphflow.config.json",
    "src/index.ts",
    "tsconfig.json",
  ] as const;
  const filePathSet = new Set(scopedFiles.map((node) => filePathOf(node)).filter(Boolean));
  const present = ENTRY_CANDIDATES.filter((candidate) => filePathSet.has(candidate));
  if (present.length > 0) {
    lines.push(`brief: entry points=${present.join(",")}`);
  }
  if (outOfScopePaths > 0) {
    lines.push(`brief: skipped ${outOfScopePaths} path(s) outside the workspace`);
  }

  // Refs are recorded in the vocabulary `buildRefResolver` actually indexes, so
  // the brief and the freshness oracle cannot disagree about whether a ref is
  // alive. That vocabulary is not uniform: the resolver indexes a file node by
  // its stripped path and everything else by raw id (see buildRefResolver). We
  // record both forms per node rather than duplicating those rules, and
  // `validates in the resolver's own vocabulary` pins the coupling so a change
  // there fails here instead of silently making every brief look stale.
  const refs = [
    ...new Set(scopedModules.flatMap(briefRefForms).concat(scopedFiles.flatMap(briefRefForms))),
  ].sort();

  return {
    lines,
    tokens: estimateTokens(lines.join("\n")),
    outOfScopePaths,
    refs,
    fingerprint: fingerprintOf(lines),
  };
}

/**
 * Tooling, configuration and third-party dependency paths, not project
 * structure. Ranked last so the module budget describes the codebase.
 *
 * All three cases showed up live on this repo: a dotfile skill library
 * (`.agents/skills/*`), npm scoped packages (`@modelcontextprotocol/sdk/*`,
 * which sorts before every `src/` path), and out-of-workspace siblings. Each was
 * stable, so each sailed through the stability check while crowding the map out
 * of describing the thing the map is for.
 */
function isToolingPath(path: string): boolean {
  const first = path.replace(/\\/g, "/").split("/")[0] ?? "";
  if (first.length === 0) return true;
  if (first.startsWith(".")) return true;
  if (first === "node_modules") return true;
  // npm scoped package roots: @scope/name[/subpath]
  if (first.startsWith("@")) return true;
  return false;
}

function compareModulePaths(a: string, b: string): number {
  const tooling = Number(isToolingPath(a)) - Number(isToolingPath(b));
  if (tooling !== 0) return tooling;
  return a.localeCompare(b);
}

/**
 * Does this module path denote a place in the repository?
 *
 * Requires a directory separator and a real path segment. The live graph carried
 * 888 module nodes for a repo with a few dozen source directories — the rest were
 * bare names like `argparse` or `AUDIT.md` that the indexer derived from things
 * which were never directories here. A brief that lists them is not a worse map,
 * it is a different one, so they are omitted and counted.
 */
function looksLikeProjectPath(path: string): boolean {
  if (path.length === 0) return false;
  if (isToolingPath(path)) return false;
  if (!path.includes("/")) return false;
  // A path made only of a file extension is a document, not a directory.
  if (/\.[A-Za-z0-9]{1,8}$/.test(path)) return false;
  return true;
}

/**
 * Does this path escape the workspace?
 *
 * Only the unambiguous escapes count. A path that merely looks absolute is left
 * alone: on Windows `C:\...` is normal, and guessing wrong here would silently
 * empty a legitimate map, which is a worse failure than including a stray path.
 */
function isOutOfScope(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("../") || normalized === ".." || normalized.includes("/../");
}

function modulePathOf(node: GraphNode): string {
  const explicit = node.metadata?.sourcePath;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const content = node.content.trim();
  const match = content.match(/^(?:module|file):\s*(.+)$/i);
  if (match?.[1]) return match[1].trim();
  return node.id.startsWith("module:") ? node.id.slice("module:".length) : node.id;
}

function directoryOf(path: string): string {
  const slash = path.replace(/\\/g, "/").lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : ".";
}

/** `src/core/agent-delegation.ts` -> `src/core/agent-delegation`. */
function moduleKeyFor(filePath: string): string {
  return filePath.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

/** Which module a node id belongs to, for edge endpoints. */
function moduleKeyOf(nodeId: string): string {
  if (nodeId.startsWith("file:")) return moduleKeyFor(nodeId.slice("file:".length));
  if (nodeId.startsWith("symbol:")) {
    // Observed ids are `symbol:<path>:<hash>`; the documented form also allows a
    // name segment (`symbol:<path>:<name>:<hash>`). Both are disambiguated by the
    // trailing content hash rather than by counting segments — counting is what
    // dropped the path entirely on the 3-part form.
    const parts = nodeId.slice("symbol:".length).split(":");
    const last = parts[parts.length - 1] ?? "";
    const isHash = /^[0-9a-f]{4,}$/i.test(last);
    if (!isHash) return "";
    const rest = parts.slice(0, -1);
    // A name segment is a bare identifier, never a path; drop it if present.
    return rest.length >= 2 && !rest[rest.length - 1]!.includes("/") && !rest[rest.length - 1]!.includes(".")
      ? moduleKeyFor(rest.slice(0, -1).join(":"))
      : moduleKeyFor(rest.join(":"));
  }
  if (nodeId.startsWith("module:")) return nodeId.slice("module:".length);
  return "";
}

function filePathOf(node: GraphNode): string {
  // Symbol nodes do not carry `sourcePath`; the indexer records their file under
  // `file`. Reading only sourcePath made every symbol resolve to "" and silently
  // dropped the entire exports section, which is exactly the section that makes
  // the brief worth caching.
  for (const key of ["sourcePath", "file"] as const) {
    const value = node.metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return node.id.startsWith("file:") ? node.id.slice("file:".length) : "";
}

/**
 * The form of `node` that `buildRefResolver` will answer for. Its indexing is
 * not uniform: a file node is indexed by its stripped path and *not* by its
 * full id, so recording the id for a file would produce a ref that can never
 * resolve. Matching it exactly is what keeps the brief from reporting itself
 * stale on every call.
 */
function briefRefForms(node: GraphNode): string[] {
  return [node.id.startsWith("file:") ? node.id.slice("file:".length) : node.id];
}

function isTruthyFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isProjectBriefEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[PROJECT_BRIEF_ENV]);
}

export interface BriefResolution {
  brief: ProjectBrief | null;
  /** True when a stored brief was reused without rebuilding it. */
  reused: boolean;
  /** Why it was reused or rebuilt. Always populated. */
  reason: string;
  /** Validation verdict when a stored brief was checked. */
  validity: BriefValidity | null;
  /** Present when building failed; the brief is null and the reason says why. */
  error?: string;
}

/**
 * Holds one brief per workspace and rebuilds it only when validation says the
 * repository moved.
 *
 * Bounded because this is a process-lifetime cache keyed by path; an unbounded
 * map in a long-lived MCP server would be a slow leak. Clearing wholesale beats
 * LRU here: the cost of an unnecessary rebuild is one module walk, and the cost
 * of a leak is unbounded.
 */
export class ProjectBriefCache {
  private readonly briefs = new Map<string, ProjectBrief>();

  constructor(private readonly maxWorkspaces = 32) {}

  resolve(
    workspaceRoot: string,
    nodes: readonly GraphNode[],
    edges: readonly GraphEdge[] = []
  ): BriefResolution {
    const stored = this.briefs.get(workspaceRoot);
    if (stored) {
      const validity = validateProjectBrief(stored, nodes);
      if (validity.valid) {
        return { brief: stored, reused: true, reason: validity.reason, validity };
      }
      // Stale: fall through and rebuild, carrying the reason so the caller can
      // report a rebuild rather than silently serving a wrong map.
      if (this.briefs.size >= this.maxWorkspaces) this.briefs.clear();
      this.briefs.delete(workspaceRoot);
      try {
        const rebuilt = buildProjectBrief(nodes, edges);
        this.briefs.set(workspaceRoot, rebuilt);
        return {
          brief: rebuilt,
          reused: false,
          reason: `rebuilt: ${validity.reason}`,
          validity,
        };
      } catch (error) {
        return {
          brief: null,
          reused: false,
          reason: `brief rebuild failed after ${validity.reason}`,
          validity,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    try {
      const built = buildProjectBrief(nodes, edges);
      // The bound must be enforced on the fresh-build path too, not only when
      // rebuilding a stale brief — otherwise a long-lived server visiting many
      // workspaces grows this map without limit.
      if (this.briefs.size >= this.maxWorkspaces) this.briefs.clear();
      this.briefs.set(workspaceRoot, built);
      return {
        brief: built,
        reused: false,
        reason: `built from ${nodes.length} nodes (${built.refs.length} refs to validate against)`,
        validity: null,
      };
    } catch (error) {
      return {
        brief: null,
        reused: false,
        reason: "brief build failed",
        validity: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
