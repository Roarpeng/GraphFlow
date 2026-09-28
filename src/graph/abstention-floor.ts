import type { GraphNode } from "../core/types";
import type { ContextAnchorItem } from "./context-slicer-types";
import { estimateTokens } from "./context-slicer-utils";
import { extractNodeSourcePath } from "./graph-utils";

/**
 * The capability floor for abstention.
 *
 * `shouldAbstain` (context-economics.ts) argues from corpus size: a small repo
 * plus a concrete ref means the agent can just go read. That argument is
 * incomplete, because it prices only GraphFlow's side of the trade. Abstention
 * swaps *curated excerpts* for *whole-file reads*, and a file read is an order
 * of magnitude more expensive than the anchor lines it replaces. So the honest
 * question is not "can the agent find it?" but:
 *
 *   can the agent still REACH the same evidence, for no more money?
 *
 * Three gates, all required. Each one is a distinct capability argument, not a
 * tuning knob, and `breachedGate` reports the first one that fails in the order
 * below — so the reason names the decisive objection rather than the last one
 * checked. All gates are measured even once one has vetoed: a partial report
 * cannot tell you whether the other two are fine or catastrophic, and this
 * report exists to settle a default, not to short-circuit.
 *
 *  1. reachability — every handle must name a real file, and every anchor's
 *     information must be reachable through some handle. An anchor that lives in
 *     no file the handles point at (a recorded decision, a dialogue turn) is
 *     evidence the agent can no longer get. Losing evidence is not a token
 *     trade; it is a capability loss.
 *  2. file count — bounded navigation. Past a couple of files the agent is
 *     doing retrieval by hand, which is the job GraphFlow exists to do, and
 *     the cost model below stops being honest (a real agent searches a file
 *     rather than swallowing it whole).
 *  3. read amplification — the distinct files the agent must open may not cost
 *     materially more than the package they replace. A wasted read costs a
 *     whole file; the trade only pays when reading is not the more expensive
 *     side.
 *
 * Passing all three means abstention is *both* cheaper and capability-neutral,
 * which is the only condition under which it is safe to default on.
 */
export const ABSTAIN_ENFORCE_ENV = "GRAPHFLOW_ABSTAIN_ENFORCE";

export interface AbstentionFloorThresholds {
  /** Share of anchors that must resolve to a readable file path. */
  minReachability: number;
  /** Distinct files the agent may be asked to open. */
  maxFileCount: number;
  /** Reads may cost this multiple of the package they replace. */
  maxReadAmplification: number;
}

export const DEFAULT_ABSTENTION_FLOOR: AbstentionFloorThresholds = {
  minReachability: 0.95,
  maxFileCount: 2,
  maxReadAmplification: 1.1,
};

/** One "go read this" pointer, replacing every anchor that lives in that file. */
export interface AbstainHandle {
  /** Repo-relative file path. */
  file: string;
  /** 1-based earliest anchor line in the file, 0 when the graph has no line. */
  line: number;
  /** Anchor node ids this handle stands in for. */
  anchorIds: string[];
}

export interface AbstentionFloor {
  pass: boolean;
  /** First gate that vetoed abstention; null when the floor holds. */
  breachedGate: "reachability" | "fileCount" | "amplification" | null;
  reachability: { resolved: number; total: number; ratio: number; pass: boolean };
  fileCount: { files: number; pass: boolean };
  amplification: {
    readTokens: number;
    /** 0 means every pointed-to file was readable. */
    unreadableFiles: number;
    /** handleTokens + readTokens — what the agent actually pays. */
    delegateTokens: number;
    packageTokens: number;
    ratio: number;
    pass: boolean;
  };
  handles: AbstainHandle[];
  /** Tokens the handles themselves cost. */
  handleTokens: number;
  /** Tokens of the package they would replace. */
  packageTokens: number;
  /** Total the agent pays if it takes the handles: handles + the reads. */
  delegateCostTokens: number;
  /** packageTokens - delegateCostTokens. Positive means abstention wins. */
  deltaTokens: number;
  reason: string;
}

const LOOKS_LIKE_A_FILE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Group anchors into one handle per file.
 *
 * `extractNodeSourcePath` degrades to the node's first whitespace-delimited
 * token when metadata carries no `sourcePath` — that yields a word, not a path.
 * Counting those as reachable evidence would inflate the recall gate with
 * garbage, so they are rejected and reported as unresolved.
 */
export type AnchorCoverage = "file" | "subsumed" | "unreachable";

export interface AnchorResolution {
  anchorId: string;
  kind: AnchorCoverage;
  /** Handle file that covers this anchor, when it is not a file anchor itself. */
  coveredBy?: string;
}

const basenameOf = (file: string): string => file.split("/").pop() ?? file;
const stemOf = (file: string): string => basenameOf(file).replace(/\.[A-Za-z0-9]{1,8}$/, "");

/**
 * Group anchors into one handle per file, and classify what the handles do *not*
 * cover.
 *
 * The capability question is not "does every anchor have a path" but "is every
 * anchor's information reachable through some handle". Those differ: a
 * `module:foo` node describes the file `foo.ts` and carries nothing that is not
 * inside it, so a handle on that file already covers it — dropping it loses
 * nothing. A `dialogue:*` decision records something the agent learned that
 * appears in no file at all, and no read can recover it. Scoring the first as
 * lost evidence would make the floor refuse on a distinction that costs the
 * caller nothing; scoring the second as covered would silently drop history.
 *
 * `extractNodeSourcePath` degrades to the node's first whitespace-delimited
 * token when metadata carries no `sourcePath` — that yields a word, not a path,
 * so it is never treated as a file.
 */
export function resolveAnchors(
  anchors: readonly ContextAnchorItem[],
  nodesById: ReadonlyMap<string, GraphNode>
): { handles: AbstainHandle[]; resolutions: AnchorResolution[] } {
  const byFile = new Map<string, AbstainHandle>();
  const resolutions: AnchorResolution[] = [];

  for (const anchor of anchors) {
    const node = nodesById.get(anchor.id);
    if (!node) {
      resolutions.push({ anchorId: anchor.id, kind: "unreachable" });
      continue;
    }
    const candidate = extractNodeSourcePath(node).trim();
    if (!candidate || /\s/.test(candidate) || !LOOKS_LIKE_A_FILE.test(candidate)) {
      // No file of its own. A module node may still be covered by a handle on
      // the file it names; anything else (dialogue, decisions) is not in any
      // file and cannot be read back.
      const named = anchor.id.startsWith("module:") ? anchor.id.slice("module:".length) : "";
      const cover = named
        ? [...byFile.keys()].find((file) => stemOf(file) === named)
        : undefined;
      resolutions.push(
        cover === undefined
          ? { anchorId: anchor.id, kind: "unreachable" }
          : { anchorId: anchor.id, kind: "subsumed", coveredBy: cover }
      );
      continue;
    }
    const line = typeof node.metadata?.line === "number" ? node.metadata.line : 0;
    const existing = byFile.get(candidate);
    if (existing) {
      existing.anchorIds.push(anchor.id);
      if (line > 0 && (existing.line === 0 || line < existing.line)) existing.line = line;
    } else {
      byFile.set(candidate, { file: candidate, line, anchorIds: [anchor.id] });
    }
    resolutions.push({ anchorId: anchor.id, kind: "file", coveredBy: candidate });
  }

  return {
    handles: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)),
    resolutions,
  };
}

/**
 * A handle is a path plus a line plus a bullet marker. Measured on real
 * handles this lands around 10-14 tokens each — two orders of magnitude below
 * the file it points at, which is exactly why gate 3 is the one that bites.
 */
export function estimateHandleTokens(handles: readonly AbstainHandle[]): number {
  return handles.reduce((sum, handle) => sum + estimateTokens(`${handle.file}:${handle.line}`) + 4, 0);
}

export function evaluateAbstentionFloor(input: {
  anchors: readonly ContextAnchorItem[];
  nodesById: ReadonlyMap<string, GraphNode>;
  packageTokens: number;
  readFileTokens: (file: string) => number;
  thresholds?: Partial<AbstentionFloorThresholds>;
}): AbstentionFloor {
  const thresholds = { ...DEFAULT_ABSTENTION_FLOOR, ...input.thresholds };
  const packageTokens = Math.max(0, Math.round(input.packageTokens));
  const { handles, resolutions } = resolveAnchors(input.anchors, input.nodesById);

  const total = input.anchors.length;
  const unreachable = resolutions.filter((entry) => entry.kind === "unreachable");
  const covered = total - unreachable.length;
  const reachabilityRatio = total === 0 ? 0 : covered / total;
  const reachabilityPass = total > 0 && reachabilityRatio >= thresholds.minReachability;

  const fileCountPass = handles.length > 0 && handles.length <= thresholds.maxFileCount;

  const readTokens = handles.reduce((sum, handle) => sum + Math.max(0, input.readFileTokens(handle.file)), 0);
  // `readFileTokens` returns Infinity for a file it cannot read, which is the
  // honest answer (the delegation cost is unbounded) but serialises to `null` in
  // JSON — indistinguishable from "not measured". Count them instead so a caller
  // reading the wire can tell the two apart, and keep the ratio finite.
  const unreadableFiles = handles.filter((handle) => !Number.isFinite(input.readFileTokens(handle.file))).length;
  const measuredReadTokens = Number.isFinite(readTokens) ? readTokens : 0;
  const handleTokens = estimateHandleTokens(handles);
  // A handle is not free. Comparing only the reads to the package lets a
  // delegation pass the gate and then come out *more* expensive, which is the
  // one outcome this floor exists to prevent — measured: a 45 tok package
  // replaced by a 42 tok read plus a 9 tok handle is a 6 tok regression.
  const delegateTokens = handleTokens + measuredReadTokens;
  const amplificationRatio =
    packageTokens > 0 ? delegateTokens / packageTokens : Number.POSITIVE_INFINITY;
  // An unreadable pointer fails the gate explicitly. Clamping its cost to zero
  // for the wire would otherwise make an unreadable file look *free* — the exact
  // failure the unbounded value existed to prevent.
  const amplificationPass =
    packageTokens > 0 && unreadableFiles === 0 && amplificationRatio <= thresholds.maxReadAmplification;

  const reachability = { resolved: covered, total, ratio: reachabilityRatio, pass: reachabilityPass };
  const fileCount = { files: handles.length, pass: fileCountPass };
  const amplification = {
    readTokens: measuredReadTokens,
    /** Files whose content could not be read; the cost of those is unbounded. */
    unreadableFiles,
    delegateTokens,
    packageTokens,
    ratio: amplificationRatio,
    pass: amplificationPass,
  };

  let breachedGate: AbstentionFloor["breachedGate"] = null;
  let reason: string;
  if (!reachabilityPass) {
    breachedGate = "reachability";
    reason =
      total === 0
        ? "no anchors to hand over — abstention would drop the package entirely"
        : `${unreachable.length}/${total} anchors are in no file any handle points at (${(reachabilityRatio * 100).toFixed(0)}% covered < ${(thresholds.minReachability * 100).toFixed(0)}%): ${unreachable.slice(0, 3).map((entry) => entry.anchorId.split(":")[0]).join(", ")} — evidence the agent can no longer reach`;
  } else if (!fileCountPass) {
    breachedGate = "fileCount";
    reason = `evidence spans ${handles.length} files (> ${thresholds.maxFileCount}): the agent would be doing retrieval by hand, and reading is no longer bounded`;
  } else if (!amplificationPass) {
    breachedGate = "amplification";
    reason =
      packageTokens === 0
        ? "package carries 0 tokens — nothing to save by delegating the read"
        : unreadableFiles > 0
          ? // An unreadable pointer is not a free read. Without this the
            // amplification gate would pass on a file that does not exist.
            `${unreadableFiles} pointed-to file(s) could not be read — the cost of the delegation is unbounded, so it cannot be shown to pay`
          : `handles + reads cost ${delegateTokens} tok (${handleTokens} handle + ${readTokens} read) vs a ${packageTokens} tok package (${amplificationRatio.toFixed(2)}x > ${thresholds.maxReadAmplification}x): the agent pays more than it saves`;
  } else {
    reason = `floor holds: ${covered}/${total} anchors reachable in ${handles.length} file(s), delegation costs ${delegateTokens} tok vs package ${packageTokens} tok (${amplificationRatio.toFixed(2)}x) — cheaper and loses no evidence`;
  }

  const delegateCostTokens = delegateTokens;
  return {
    pass: breachedGate === null,
    breachedGate,
    reachability,
    fileCount,
    amplification,
    handles,
    handleTokens,
    packageTokens,
    delegateCostTokens,
    deltaTokens: packageTokens - delegateCostTokens,
    reason,
  };
}

export function isAbstentionEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ABSTAIN_ENFORCE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
