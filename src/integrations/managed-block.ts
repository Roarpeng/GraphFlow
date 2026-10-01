/**
 * Marker-delimited managed blocks for instruction files the user may also own
 * (CLAUDE.md, AGENTS.md, GEMINI.md, .windsurfrules, copilot-instructions.md).
 *
 * GraphFlow only ever touches the text between its markers: install inserts or
 * refreshes the block, uninstall strips it, and the file is deleted only when
 * nothing but GraphFlow content was in it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const GRAPHFLOW_BLOCK_BEGIN = "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->";
export const GRAPHFLOW_BLOCK_END = "<!-- GRAPHFLOW:END -->";

export type ManagedWriteStatus = "created" | "updated" | "skipped" | "error";

/** Wrap arbitrary GraphFlow guidance in the managed markers (trailing newline included). */
export function wrapManagedBlock(body: string): string {
  const inner = body.replace(/\r\n/g, "\n").trim();
  return `${GRAPHFLOW_BLOCK_BEGIN}\n${inner}\n${GRAPHFLOW_BLOCK_END}\n`;
}

function locateBlock(content: string): { begin: number; end: number } | undefined {
  const begin = content.indexOf(GRAPHFLOW_BLOCK_BEGIN);
  if (begin === -1) return undefined;
  const endMarker = content.indexOf(GRAPHFLOW_BLOCK_END, begin);
  if (endMarker === -1) return undefined;
  return { begin, end: endMarker + GRAPHFLOW_BLOCK_END.length };
}

export function hasManagedBlock(content: string): boolean {
  return locateBlock(content) !== undefined;
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}

/**
 * Insert or refresh the managed block inside `current`, keeping every byte of
 * user text outside the markers. `block` must already carry the markers.
 */
export function upsertManagedBlockText(current: string | undefined, block: string): string {
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  if (current === undefined || current.trim() === "") {
    return normalizedBlock;
  }
  const located = locateBlock(current);
  if (located) {
    const before = current.slice(0, located.begin);
    const after = current.slice(located.end).replace(/^\r?\n/, "");
    return `${before}${normalizedBlock}${after}`;
  }
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${normalizedBlock}`;
}

/**
 * Remove the managed block. Returns undefined when there is no block, otherwise
 * the remaining text ("" when nothing but the block was there).
 */
export function stripManagedBlockText(current: string): string | undefined {
  const located = locateBlock(current);
  if (!located) return undefined;
  const before = current.slice(0, located.begin).replace(/(\r?\n)+$/, "");
  const after = current.slice(located.end).replace(/^(\r?\n)+/, "");
  if (!before.trim() && !after.trim()) return "";
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

export interface ManagedFileOptions {
  /**
   * Full-file templates older GraphFlow versions copied over this path. A file
   * whose whole content equals one of them is GraphFlow's own copy, so it is
   * treated as fully managed (converted on install, deleted on uninstall).
   */
  legacyWholeFile?: readonly string[];
}

function matchesLegacy(content: string, options: ManagedFileOptions): boolean {
  return (options.legacyWholeFile ?? []).some((template) => template.trim() !== "" && sameText(content, template));
}

/** True when the file carries GraphFlow guidance (managed block, or a legacy whole-file copy). */
export function isManagedContentInstalled(filePath: string, options: ManagedFileOptions = {}): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf8");
    return hasManagedBlock(content) || matchesLegacy(content, options);
  } catch {
    return false;
  }
}

/** Write or refresh the managed block in `filePath`; user text outside the markers is preserved. */
export function writeManagedBlockFile(
  filePath: string,
  block: string,
  options: ManagedFileOptions = {}
): { status: ManagedWriteStatus; message?: string } {
  try {
    const existed = existsSync(filePath);
    const current = existed ? readFileSync(filePath, "utf8") : undefined;
    const base = current !== undefined && matchesLegacy(current, options) ? undefined : current;
    const next = upsertManagedBlockText(base, block);
    if (current !== undefined && current === next) {
      return { status: "skipped", message: "already up to date" };
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, next, "utf8");
    return { status: existed ? "updated" : "created" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Strip GraphFlow's block from `filePath`. The file is deleted only when nothing
 * else remains (or it is an unmodified legacy GraphFlow copy). Returns true when
 * anything was removed.
 */
export function removeManagedBlockFile(filePath: string, options: ManagedFileOptions = {}): boolean {
  if (!existsSync(filePath)) return false;
  let current: string;
  try {
    current = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const stripped = stripManagedBlockText(current);
  if (stripped === undefined) {
    if (!matchesLegacy(current, options)) return false;
    rmSync(filePath, { force: true });
    return true;
  }
  if (stripped.trim() === "") {
    rmSync(filePath, { force: true });
    return true;
  }
  writeFileSync(filePath, stripped, "utf8");
  return true;
}
