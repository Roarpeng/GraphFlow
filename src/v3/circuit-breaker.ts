/**
 * GraphFlow 3.1 — Strategic Pillar 2: 35-Minute Wall Defense —
 * Session Read Deduplication Cache & Edit-Test Thrashing Circuit Breaker (`src/v3/circuit-breaker.ts`)
 *
 * Defends against the two primary causes of Context Rot (Chroma 2025 / Anthropic 2025):
 *   1. Duplicate Context Stuffing: Agents repeatedly reading the same unchanged file or
 *      symbol within a single session. `checkSessionReadDedup` tracks `(targetKey, sha256)`
 *      and returns a 1-line cache hit receipt (-100% duplicate tokens) until the file is edited.
 *   2. Edit-Test Thrashing Loops: Agents failing 3 consecutive test/build runs while
 *      blindly guessing fixes on the same files. `recordTestAndCheckCircuitBreaker` trips
 *      on the 3rd failure and injects a Deterministic Rescue Packet (2-hop Blast Radius
 *      caller contracts + recent `git log -p` human diffs for the edited files).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeBlastRadius, formatBlastRadiusText } from "./blast-radius.js";
import { getRecentFileGitDiff } from "./git-miner.js";
import { getWorkspaceAstIndex } from "./slicer.js";

export interface SessionReadRecord {
  sha256: string;
  turn: number;
  ts: string;
  estimatedTokens: number;
}

export interface SessionGuardState {
  sessionId: string;
  turnCounter: number;
  reads: Record<string, SessionReadRecord>;
  consecutiveFailures: number;
  lastFailedCommand?: string;
  recentEditedFiles: string[];
  totalDuplicateTokensSaved: number;
  circuitTrippedCount: number;
}

function sessionStateFilePath(rootDir: string): string {
  return join(rootDir, ".graphflow", "session-state.json");
}

export function computeContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

export function loadSessionGuardState(rootDir: string, sessionId = "main"): SessionGuardState {
  const path = sessionStateFilePath(rootDir);
  const empty: SessionGuardState = {
    sessionId,
    turnCounter: 0,
    reads: {},
    consecutiveFailures: 0,
    recentEditedFiles: [],
    totalDuplicateTokensSaved: 0,
    circuitTrippedCount: 0,
  };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionGuardState>;
    if (parsed.sessionId && parsed.sessionId !== sessionId) {
      return empty;
    }
    return {
      sessionId,
      turnCounter: typeof parsed.turnCounter === "number" ? parsed.turnCounter : 0,
      reads: parsed.reads && typeof parsed.reads === "object" ? parsed.reads : {},
      consecutiveFailures:
        typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
      ...(typeof parsed.lastFailedCommand === "string"
        ? { lastFailedCommand: parsed.lastFailedCommand }
        : {}),
      recentEditedFiles: Array.isArray(parsed.recentEditedFiles) ? parsed.recentEditedFiles : [],
      totalDuplicateTokensSaved:
        typeof parsed.totalDuplicateTokensSaved === "number"
          ? parsed.totalDuplicateTokensSaved
          : 0,
      circuitTrippedCount:
        typeof parsed.circuitTrippedCount === "number" ? parsed.circuitTrippedCount : 0,
    };
  } catch {
    return empty;
  }
}

export function saveSessionGuardState(rootDir: string, state: SessionGuardState): void {
  mkdirSync(join(rootDir, ".graphflow"), { recursive: true });
  writeFileSync(sessionStateFilePath(rootDir), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Check if `targetKey` (`file` or `file#symbol`) has already been delivered in `sessionId`
 * with the exact same `content` SHA-256. If not, records the read for future deduplication.
 */
export function checkAndRecordSessionRead(
  rootDir: string,
  sessionId: string,
  targetKey: string,
  content: string,
  estimatedTokens: number
): {
  isDuplicate: boolean;
  sha256: string;
  previousTurn?: number;
  tokensSaved: number;
  dedupNotice?: string;
} {
  const state = loadSessionGuardState(rootDir, sessionId);
  state.turnCounter += 1;
  const sha256 = computeContentSha256(content);
  const existing = state.reads[targetKey];

  if (existing && existing.sha256 === sha256) {
    const tokensSaved = Math.max(1, estimatedTokens - 18);
    state.totalDuplicateTokensSaved += tokensSaved;
    saveSessionGuardState(rootDir, state);
    return {
      isDuplicate: true,
      sha256,
      previousTurn: existing.turn,
      tokensSaved,
      dedupNotice: `// [Session Dedup Cache Hit] '${targetKey}' unchanged since turn #${existing.turn} (sha256=${sha256}, saved ~${tokensSaved} duplicate tokens).`,
    };
  }

  state.reads[targetKey] = {
    sha256,
    turn: state.turnCounter,
    ts: new Date().toISOString(),
    estimatedTokens,
  };
  saveSessionGuardState(rootDir, state);
  return {
    isDuplicate: false,
    sha256,
    tokensSaved: 0,
  };
}

/**
 * Invalidate cached read hashes for edited files and record them in `recentEditedFiles`
 * for Thrashing Circuit Breaker tracking.
 */
export function markSessionFilesEdited(
  rootDir: string,
  sessionId: string,
  editedFiles: string[]
): void {
  const state = loadSessionGuardState(rootDir, sessionId);
  for (const rawFile of editedFiles) {
    const norm = rawFile.replace(/\\/g, "/").replace(/^\.\//, "");
    for (const key of Object.keys(state.reads)) {
      if (key === norm || key.startsWith(`${norm}#`) || key.startsWith(`${norm}:`)) {
        delete state.reads[key];
      }
    }
    if (!state.recentEditedFiles.includes(norm)) {
      state.recentEditedFiles = [norm, ...state.recentEditedFiles].slice(0, 5);
    }
  }
  saveSessionGuardState(rootDir, state);
}

/**
 * Record a command/test execution outcome and check if the Edit-Test Thrashing
 * Circuit Breaker should trip (default: >= 3 consecutive failures).
 */
export function recordTestAndCheckCircuitBreaker(
  rootDir: string,
  sessionId: string,
  command: string,
  ok: boolean,
  failureThreshold = 3
): {
  tripped: boolean;
  consecutiveFailures: number;
  rescuePacket?: string;
} {
  const state = loadSessionGuardState(rootDir, sessionId);
  if (ok) {
    state.consecutiveFailures = 0;
    delete state.lastFailedCommand;
    saveSessionGuardState(rootDir, state);
    return { tripped: false, consecutiveFailures: 0 };
  }

  state.consecutiveFailures += 1;
  state.lastFailedCommand = command;

  if (state.consecutiveFailures < failureThreshold) {
    saveSessionGuardState(rootDir, state);
    return { tripped: false, consecutiveFailures: state.consecutiveFailures };
  }

  state.circuitTrippedCount += 1;
  saveSessionGuardState(rootDir, state);

  // Build Deterministic Rescue Packet: 2-hop Blast Radius + Recent Git History of edited files
  const rescueSections: string[] = [
    `⚡ [CIRCUIT BREAKER TRIPPED: ${state.consecutiveFailures} consecutive failures on '${command}']`,
    `Stop blind trial-and-error edits. Review the upstream/downstream caller contracts and recent git history for your modified files:`,
  ];

  const index = getWorkspaceAstIndex(rootDir);
  const targets = state.recentEditedFiles.slice(0, 3);
  for (const relPath of targets) {
    const fileData = index.getFileAnalysis(relPath);
    if (fileData) {
      const exportedSyms = fileData.ast.symbols.filter((s) => s.exported).slice(0, 3);
      for (const sym of exportedSyms) {
        const blast = computeBlastRadius(index, relPath, sym.name, 3);
        const blastText = formatBlastRadiusText(blast);
        if (blastText) {
          rescueSections.push(`// [Contract Check: ${relPath}#${sym.name} -> ${sym.signature}]\n${blastText}`);
        }
      }
    }
    const gitDiff = getRecentFileGitDiff(rootDir, relPath, 2);
    if (gitDiff) {
      rescueSections.push(gitDiff);
    }
  }

  return {
    tripped: true,
    consecutiveFailures: state.consecutiveFailures,
    rescuePacket: rescueSections.join("\n"),
  };
}
