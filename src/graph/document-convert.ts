/**
 * document-convert.ts — Office/PDF → Markdown via @firecrawl/anydoc (optional).
 *
 * Survey (2026): Firecrawl anydoc leads format coverage/speed for Node;
 * Microsoft MarkItDown is Python/LLM-oriented; Pandoc needs system install.
 * GraphFlow prefers local-first Node: optionalDependency on @firecrawl/anydoc.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { extname } from "node:path";
import { logger } from "../utils/logger.js";
import {
  applyAnydocRequireEnv,
  resolveAnydocNodeModules,
  tryRequireAnydoc,
} from "../integrations/ensure-anydoc.js";

const requireFn = createRequire(__filename);

/** Extensions converted to Markdown before graph indexing. */
export const OFFICE_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".ppt",
  ".pptx",
  ".pptm",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  ".epub",
  ".csv",
] as const;

export type OfficeDocumentExtension = (typeof OFFICE_DOCUMENT_EXTENSIONS)[number];

/** Larger than source files — PDFs/DOCX often exceed 200KB. */
export const DEFAULT_DOCUMENT_MAX_FILE_SIZE = 5_000_000;

export function isOfficeDocumentPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return (OFFICE_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext);
}

export interface DocumentConvertResult {
  markdown: string;
  converter: "anydoc" | "unavailable";
  skippedReason?: string;
}

type AnydocModule = {
  toMarkdown?: (path: string) => Promise<string>;
  toMarkdownBytes?: (bytes: Uint8Array, format?: string) => Promise<string>;
};

let anydocLoadAttempted = false;
let anydocModule: AnydocModule | null = null;

function loadAnydoc(): AnydocModule | null {
  if (anydocLoadAttempted) {
    return anydocModule;
  }
  anydocLoadAttempted = true;
  try {
    applyAnydocRequireEnv(resolveAnydocNodeModules());
    const loaded = tryRequireAnydoc();
    if (loaded) {
      anydocModule = loaded as AnydocModule;
      return anydocModule;
    }
    anydocModule = requireFn("@firecrawl/anydoc") as AnydocModule;
  } catch (error) {
    const fromEnv = process.env.GRAPHFLOW_ANYDOC_NODE_MODULES?.trim();
    if (fromEnv) {
      try {
        const req = createRequire(join(fromEnv, "@firecrawl", "anydoc", "package.json"));
        anydocModule = req("@firecrawl/anydoc") as AnydocModule;
        return anydocModule;
      } catch {
        // fall through to warn
      }
    }
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "optional @firecrawl/anydoc not available — office/PDF documents will be skipped"
    );
    anydocModule = null;
  }
  return anydocModule;
}

/** Test hook: reset optional-dep load cache. */
export function resetDocumentConverterCache(): void {
  anydocLoadAttempted = false;
  anydocModule = null;
}

/** Test hook: inject a fake converter module. */
export function setDocumentConverterForTests(mod: AnydocModule | null): void {
  anydocLoadAttempted = true;
  anydocModule = mod;
}

/**
 * Convert an office/PDF file to Markdown.
 * Returns skippedReason when the optional converter is missing or conversion fails softly.
 */
export async function convertDocumentToMarkdown(
  absPath: string,
  bytes?: Buffer
): Promise<DocumentConvertResult> {
  const anydoc = loadAnydoc();
  if (!anydoc?.toMarkdown && !anydoc?.toMarkdownBytes) {
    return {
      markdown: "",
      converter: "unavailable",
      skippedReason: "optional-dependency-missing:@firecrawl/anydoc",
    };
  }

  try {
    let markdown = "";
    if (anydoc.toMarkdown) {
      markdown = await anydoc.toMarkdown(absPath);
    } else if (anydoc.toMarkdownBytes && bytes) {
      markdown = await anydoc.toMarkdownBytes(bytes);
    } else if (anydoc.toMarkdownBytes) {
      const { readFileSync } = await import("node:fs");
      markdown = await anydoc.toMarkdownBytes(readFileSync(absPath));
    }
    const trimmed = markdown?.trim() ?? "";
    if (!trimmed) {
      return {
        markdown: "",
        converter: "anydoc",
        skippedReason: "empty-markdown",
      };
    }
    return { markdown: trimmed, converter: "anydoc" };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ path: absPath, code, message }, "document conversion failed");
    return {
      markdown: "",
      converter: "anydoc",
      skippedReason: code ? `convert-error:${code}` : `convert-error:${message.slice(0, 120)}`,
    };
  }
}
