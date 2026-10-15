/**
 * GraphFlow 3.1 — Multi-Format Doc-to-Code Linker, Cross-Agent Handoff Brief &
 * Interactive Knowledge Graph Visualizer (`src/doc-graph.ts`)
 *
 * Solves 3 core engineering pain points with ZERO external dependencies:
 *  1. Cross-Agent Instant Project Onboarding (`generateCrossAgentBrief` / `recordCrossAgentActivity`):
 *     - Persists `.graphflow/cross-agent-brief.json` across Cursor, Claude Code, Trae, Windsurf, Codex, etc.
 *     - When a new agent joins the project and calls `gf_read({})` or `gf_read({ targets: ["@brief"] })`,
 *       returns a ~300-token high-SNR onboarding & handoff brief (Architecture Hubs + Last Agent's
 *       Modified Symbols & Test Status + Linked Design Docs + Compiled Macros).
 *  2. Multi-Format Dev Doc <-> Code Bidirectional Linking (`.md`, `.html`, `.xml`, `.docx`, `.pdf`):
 *     - Zero-dependency parsers for Markdown, HTML, XML (including PLCopen/config XML),
 *       Word `.docx` (native ZIP Central Directory + `zlib.inflateRawSync` on `word/document.xml`),
 *       and `.pdf` (native `zlib.inflateSync` on `/FlateDecode` streams + `BT..ET` text extraction).
 *     - Automatically links doc sections <-> code symbols via explicit symbol mentions and
 *       bilingual domain token overlap (`src/tokenizer.ts`).
 *  3. Interactive Single-File HTML Knowledge Graph (`generateKnowledgeGraphHtml`):
 *     - Exports `.graphflow/knowledge-graph.json` and `.graphflow/knowledge-graph.html`
 *       with an interactive force-directed Canvas topology, search, node filtering, and click inspector.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { loadMacroStore } from "./macro-engine.js";
import type { getWorkspaceAstIndex } from "./slicer.js";
import { tokenizeBilingualQuery } from "./tokenizer.js";

export const SUPPORTED_DOC_EXTS = new Set([
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".xml",
  ".docx",
  ".pdf",
]);

export interface DocSection {
  docPath: string;
  format: "md" | "html" | "xml" | "docx" | "pdf";
  title: string;
  startLine: number;
  endLine: number;
  summary: string;
  referencedIdentifiers: string[];
  bilingualTokens: string[];
}

export interface DocCodeLink {
  docPath: string;
  sectionTitle: string;
  codeFile: string;
  symbolName: string;
  reason: string;
  score: number;
  summary: string;
}

export interface CrossAgentActivityEntry {
  ts: string;
  agentHint: string;
  action: "read" | "edit" | "exec";
  summary: string;
  files: string[];
  ok: boolean;
}

export interface CrossAgentBriefState {
  updatedAt: string;
  recentActivities: CrossAgentActivityEntry[];
  lastTestCommand?: string;
  lastTestOk?: boolean;
  lastTestSummary?: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  kind: "file" | "symbol" | "doc" | "macro";
  langOrFormat: string;
  detail: string;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  kind: "imports" | "calls" | "doc-links-code" | "co-edit";
  label?: string;
}

export interface KnowledgeGraphData {
  generatedAt: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

/**
 * Zero-dependency Word `.docx` text & heading extractor using Node's built-in `node:zlib`.
 * Parses the ZIP End-of-Central-Directory / Local File Headers to locate and inflate `word/document.xml`.
 */
export function extractDocxText(buffer: Buffer): string {
  // Scan local file headers (PK\x03\x04 = 0x04034b50) for `word/document.xml`
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.subarray(offset + 30, offset + 30 + fileNameLen).toString("utf8");
    const dataStart = offset + 30 + fileNameLen + extraLen;

    if (fileName === "word/document.xml") {
      let xmlBuf: Buffer;
      const sliceEnd = compressedSize > 0 ? dataStart + compressedSize : buffer.length;
      const rawCompressed = buffer.subarray(dataStart, sliceEnd);
      if (compressionMethod === 0) {
        xmlBuf = rawCompressed;
      } else if (compressionMethod === 8) {
        try {
          xmlBuf = inflateRawSync(rawCompressed);
        } catch {
          // If data descriptor was used (compressedSize === 0), find next PK header
          const nextPk = buffer.indexOf(Buffer.from([0x50, 0x4b]), dataStart);
          const fallbackSlice = nextPk > dataStart ? buffer.subarray(dataStart, nextPk) : rawCompressed;
          xmlBuf = inflateRawSync(fallbackSlice);
        }
      } else {
        return "";
      }

      const xml = xmlBuf.toString("utf8");
      const paragraphs: string[] = [];
      for (const pMatch of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
        const pBody = pMatch[1] ?? "";
        const styleMatch = pBody.match(/<w:pStyle\s+w:val="([^"]+)"/i);
        const isHeading = styleMatch && /heading|title|标题/i.test(styleMatch[1] ?? "");
        const texts: string[] = [];
        for (const tMatch of pBody.matchAll(/<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
          texts.push(decodeXmlEntities(tMatch[1] ?? ""));
        }
        const line = texts.join("").trim();
        if (line) {
          paragraphs.push(isHeading ? `# ${line}` : line);
        }
      }
      return paragraphs.join("\n");
    }

    offset = dataStart + Math.max(1, compressedSize);
  }
  return "";
}

/**
 * Zero-dependency PDF text extractor using Node's built-in `node:zlib`.
 * Extracts text from both uncompressed and `/FlateDecode` compressed PDF content streams.
 */
export function extractPdfText(buffer: Buffer): string {
  const rawLatin1 = buffer.toString("latin1");
  const decodedChunks: string[] = [rawLatin1];

  // Decompress FlateDecode streams if present
  let searchPos = 0;
  while (searchPos < rawLatin1.length) {
    const streamIdx = rawLatin1.indexOf("stream", searchPos);
    if (streamIdx === -1) break;
    let start = streamIdx + 6;
    if (rawLatin1[start] === "\r" && rawLatin1[start + 1] === "\n") start += 2;
    else if (rawLatin1[start] === "\n" || rawLatin1[start] === "\r") start += 1;

    const endIdx = rawLatin1.indexOf("endstream", start);
    if (endIdx === -1) break;
    searchPos = endIdx + 9;

    const streamBuf = buffer.subarray(start, endIdx);
    try {
      const inflated = inflateSync(streamBuf).toString("utf8");
      decodedChunks.push(inflated);
    } catch {
      // Non-Flate stream or binary font stream; skip
    }
  }

  const lines: string[] = [];
  for (const chunk of decodedChunks) {
    for (const btMatch of chunk.matchAll(/BT\s+([\s\S]*?)\s+ET/g)) {
      const block = btMatch[1] ?? "";
      const parts: string[] = [];
      for (const tj of block.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) {
        parts.push((tj[1] ?? "").replace(/\\([()\\])/g, "$1"));
      }
      for (const tjArr of block.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
        for (const strItem of (tjArr[1] ?? "").matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
          parts.push((strItem[1] ?? "").replace(/\\([()\\])/g, "$1"));
        }
      }
      const combined = parts.join(" ").trim();
      if (combined) lines.push(combined);
    }
  }
  return lines.join("\n");
}

function extractCandidateSymbolsFromDocText(text: string): string[] {
  const ids = new Set<string>();
  // 1. Backticked code spans: `symbolName` or `ClassName.method`
  for (const m of text.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$.:#-]*)`/g)) {
    const raw = m[1]!;
    ids.add(raw);
    for (const part of raw.split(/[.#:/]/)) {
      if (part.length >= 3) ids.add(part);
    }
  }
  // 2. CamelCase or snake_case identifiers in prose
  for (const m of text.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g)) {
    const word = m[1]!;
    if (/[A-Z]/.test(word) || word.includes("_")) {
      ids.add(word);
    }
  }
  return Array.from(ids);
}

/**
 * Parses a project document (`.md`, `.html`, `.xml`, `.docx`, `.pdf`) into structured sections.
 */
export function parseProjectDocument(relPath: string, absPath: string): DocSection[] {
  const ext = extname(relPath).toLowerCase();
  if (!SUPPORTED_DOC_EXTS.has(ext) || !existsSync(absPath)) return [];

  let format: DocSection["format"] = "md";
  let textContent = "";

  try {
    if (ext === ".docx") {
      format = "docx";
      textContent = extractDocxText(readFileSync(absPath));
    } else if (ext === ".pdf") {
      format = "pdf";
      textContent = extractPdfText(readFileSync(absPath));
    } else {
      textContent = readFileSync(absPath, "utf8");
      if (ext === ".html" || ext === ".htm") format = "html";
      else if (ext === ".xml") format = "xml";
      else format = "md";
    }
  } catch {
    return [];
  }

  if (!textContent.trim()) return [];

  if (format === "html") {
    // Convert HTML headings into markdown-like `# Heading` lines and strip tags
    const cleaned = textContent
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi, "\n# $1\n")
      .replace(/<[^>]+>/g, " ");
    textContent = decodeXmlEntities(cleaned);
  } else if (format === "xml") {
    // Extract meaningful XML elements with `name`, `id`, or tag structure
    const xmlLines: string[] = [];
    const lines = textContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const attrMatch = l.match(/<([a-zA-Z0-9_:-]+)\b[^>]*\b(?:name|id|key|symbol)="([^"]+)"/i);
      if (attrMatch) {
        xmlLines.push(`# ${attrMatch[1]}: ${attrMatch[2]}`);
      }
      const stripped = decodeXmlEntities(l.replace(/<[^>]+>/g, " ").trim());
      if (stripped) xmlLines.push(stripped);
    }
    textContent = xmlLines.join("\n");
  }

  const lines = textContent.split(/\r?\n/);
  const sections: DocSection[] = [];
  let currentTitle = relPath.split("/").pop() ?? relPath;
  let currentStart = 1;
  let currentBuf: string[] = [];

  const flushSection = (endLine: number) => {
    const body = currentBuf.join("\n").trim();
    if (!body && sections.length > 0) return;
    const fullText = `${currentTitle}\n${body}`;
    const qPlan = tokenizeBilingualQuery(fullText);
    const bilingualTokens = Array.from(
      new Set([...qPlan.englishWords, ...qPlan.englishStems, ...qPlan.chineseWords])
    );
    sections.push({
      docPath: relPath,
      format,
      title: currentTitle,
      startLine: currentStart,
      endLine: Math.max(currentStart, endLine),
      summary: body.replace(/\s+/g, " ").slice(0, 220),
      referencedIdentifiers: extractCandidateSymbolsFromDocText(fullText),
      bilingualTokens,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      if (currentBuf.length > 0) {
        flushSection(i);
      }
      currentTitle = headingMatch[1]!.trim();
      currentStart = i + 1;
      currentBuf = [];
    } else if (line.trim()) {
      currentBuf.push(line.trim());
    }
  }
  if (currentBuf.length > 0 || sections.length === 0) {
    flushSection(lines.length);
  }

  return sections;
}

const IGNORED_DOC_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".graphflow",
  "vendor",
  "third_party",
  "target",
]);

/**
 * Scans workspace for development documents (`.md`, `.html`, `.xml`, `.docx`, `.pdf`).
 */
export function scanWorkspaceDocuments(rootDir: string, maxDocs = 200): DocSection[] {
  const sections: DocSection[] = [];
  let docCount = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 6 || docCount >= maxDocs) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (docCount >= maxDocs) break;
      if (entry.name.startsWith(".")) continue;
      if (IGNORED_DOC_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SUPPORTED_DOC_EXTS.has(ext)) continue;
        try {
          const st = statSync(full);
          if (st.size > 5_000_000) continue;
        } catch {
          continue;
        }
        const rel = relative(rootDir, full).replace(/\\/g, "/");
        docCount += 1;
        sections.push(...parseProjectDocument(rel, full));
      }
    }
  };

  walk(rootDir, 0);
  return sections;
}

/**
 * Builds bidirectional links between project documents (`.md`, `.docx`, `.xml`, `.html`, `.pdf`)
 * and code symbols in the workspace AST index.
 */
export function buildDocCodeLinks(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  docSections?: DocSection[]
): DocCodeLink[] {
  const sections = docSections ?? scanWorkspaceDocuments(index.rootDir);
  if (sections.length === 0) return [];

  const links: DocCodeLink[] = [];

  for (const relFile of index.getFiles()) {
    const fileData = index.getFileAnalysis(relFile);
    if (!fileData) continue;

    for (const sym of fileData.ast.symbols) {
      const symPlan = tokenizeBilingualQuery(sym.name);
      const symTokens = new Set([
        ...symPlan.englishWords,
        ...symPlan.englishStems,
        ...symPlan.chineseWords,
      ]);

      for (const sec of sections) {
        let score = 0;
        const reasons: string[] = [];

        if (sec.referencedIdentifiers.includes(sym.name)) {
          score += 30;
          reasons.push(`explicit ref \`${sym.name}\``);
        }

        const secTokenSet = new Set(sec.bilingualTokens);
        const shared: string[] = [];
        for (const t of symTokens) {
          if (t.length >= 2 && secTokenSet.has(t)) {
            shared.push(t);
          }
        }
        if (shared.length >= 2) {
          score += shared.length * 8;
          reasons.push(`concepts [${shared.slice(0, 4).join(", ")}]`);
        }

        if (score >= 16) {
          links.push({
            docPath: sec.docPath,
            sectionTitle: sec.title,
            codeFile: relFile,
            symbolName: sym.name,
            reason: reasons.join(" + "),
            score,
            summary: sec.summary,
          });
        }
      }
    }
  }

  links.sort((a, b) => b.score - a.score);
  return links;
}

/**
 * Finds linked development document sections for a specific code symbol.
 */
export function findLinkedDocsForSymbol(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  codeFile: string,
  symbolName: string,
  maxLinks = 2
): DocCodeLink[] {
  const allLinks = buildDocCodeLinks(index);
  return allLinks
    .filter((l) => l.codeFile === codeFile && l.symbolName === symbolName)
    .slice(0, maxLinks);
}

// ============================================================================
// Cross-Agent Instant Project Onboarding & Session Handoff Engine
// ============================================================================

function briefFilePath(rootDir: string): string {
  return join(rootDir, ".graphflow", "cross-agent-brief.json");
}

export function loadCrossAgentBriefState(rootDir: string): CrossAgentBriefState {
  const p = briefFilePath(rootDir);
  if (!existsSync(p)) {
    return { updatedAt: new Date().toISOString(), recentActivities: [] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CrossAgentBriefState;
  } catch {
    return { updatedAt: new Date().toISOString(), recentActivities: [] };
  }
}

export function recordCrossAgentActivity(
  rootDir: string,
  entry: Omit<CrossAgentActivityEntry, "ts"> & {
    lastTestCommand?: string;
    lastTestOk?: boolean;
    lastTestSummary?: string;
  }
): void {
  const state = loadCrossAgentBriefState(rootDir);
  const fullEntry: CrossAgentActivityEntry = {
    ts: new Date().toISOString(),
    agentHint: entry.agentHint,
    action: entry.action,
    summary: entry.summary,
    files: entry.files,
    ok: entry.ok,
  };
  state.updatedAt = fullEntry.ts;
  state.recentActivities = [...state.recentActivities.slice(-14), fullEntry];
  if (entry.lastTestCommand !== undefined) state.lastTestCommand = entry.lastTestCommand;
  if (entry.lastTestOk !== undefined) state.lastTestOk = entry.lastTestOk;
  if (entry.lastTestSummary !== undefined) state.lastTestSummary = entry.lastTestSummary;

  mkdirSync(join(rootDir, ".graphflow"), { recursive: true });
  writeFileSync(briefFilePath(rootDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Generates a compact (~300 tokens) Cross-Agent Project Onboarding & Handoff Brief
 * so any newly switched coding agent (Cursor <-> Claude Code <-> Trae <-> Windsurf <-> Codex)
 * immediately understands the project architecture, linked docs, and previous agent's progress.
 */
export function generateCrossAgentBrief(index: ReturnType<typeof getWorkspaceAstIndex>): string {
  const files = index.getFiles();
  const inDegree = new Map<string, number>();
  const fileExportSummary = new Map<string, string[]>();

  for (const f of files) {
    inDegree.set(f, 0);
    const data = index.getFileAnalysis(f);
    if (!data) continue;
    fileExportSummary.set(
      f,
      data.ast.symbols
        .filter((s) => s.exported)
        .slice(0, 5)
        .map((s) => `${s.kind} ${s.name}`)
    );
  }

  for (const f of files) {
    const data = index.getFileAnalysis(f);
    if (!data) continue;
    for (const imp of data.ast.imports) {
      for (const candidate of files) {
        const base = candidate.replace(/\.[^.]+$/, "");
        if (imp.module.endsWith(base.split("/").pop() ?? "__none__")) {
          inDegree.set(candidate, (inDegree.get(candidate) ?? 0) + 1);
        }
      }
    }
  }

  const topHubs = [...inDegree.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);

  const briefState = loadCrossAgentBriefState(index.rootDir);
  const macroStore = loadMacroStore(index.rootDir);
  const docLinks = buildDocCodeLinks(index).slice(0, 5);

  const lines: string[] = [
    `# [Cross-Agent Project Onboarding & Handoff Brief] (${files.length} source files)`,
    "",
    "## 1. Core Architecture Hubs (Ranked by Cross-File In-Degree)",
  ];

  for (const [relFile, deg] of topHubs) {
    const exportsList = fileExportSummary.get(relFile) ?? [];
    lines.push(
      `- ${relFile} (imported by ${deg} file(s)): ${exportsList.join(", ") || "internal module"}`
    );
  }

  if (briefState.recentActivities.length > 0) {
    lines.push("", "## 2. Recent Cross-Agent Working Set (Session Handoff)");
    for (const act of briefState.recentActivities.slice(-5).reverse()) {
      lines.push(
        `- [${act.action.toUpperCase()} ${act.ok ? "OK" : "FAIL"}] (${act.agentHint}): ${act.summary}`
      );
    }
    if (briefState.lastTestCommand) {
      lines.push(
        `- [Last Test Status]: \`${briefState.lastTestCommand}\` -> ${briefState.lastTestOk ? "PASS" : "FAIL"} (${briefState.lastTestSummary ?? ""})`
      );
    }
  }

  if (docLinks.length > 0) {
    lines.push("", "## 3. Linked Development Docs <-> Code Symbols");
    for (const dl of docLinks) {
      lines.push(
        `- ${dl.docPath}#${dl.sectionTitle} <-> ${dl.codeFile}#${dl.symbolName} (${dl.reason})`
      );
    }
  }

  if (macroStore.macros.length > 0 || macroStore.habits.coEdits.length > 0) {
    lines.push("", "## 4. Zero-Token Macros & Co-Edit Contracts");
    for (const m of macroStore.macros.slice(0, 4)) {
      lines.push(`- Macro \`${m.id}\` [${m.kind}]: ${m.description}`);
    }
    for (const ce of macroStore.habits.coEdits.slice(0, 4)) {
      const conf = ce.confidence ?? Math.min(1, ce.coEditCount / 5);
      lines.push(
        `- Co-Edit Contract: ${ce.fileA} <-> ${ce.fileB} (${Math.round(conf * 100)}% coupling)`
      );
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Interactive Single-File HTML Knowledge Graph Visualizer
// ============================================================================

export function buildKnowledgeGraphData(
  index: ReturnType<typeof getWorkspaceAstIndex>
): KnowledgeGraphData {
  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNode = (node: KnowledgeGraphNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  const files = index.getFiles();
  for (const relFile of files) {
    const data = index.getFileAnalysis(relFile);
    if (!data) continue;
    addNode({
      id: `file:${relFile}`,
      label: relFile,
      kind: "file",
      langOrFormat: extname(relFile).replace(".", "") || "code",
      detail: `${data.ast.totalLines} lines, ${data.ast.symbols.length} symbols`,
    });

    for (const sym of data.ast.symbols) {
      const symId = `sym:${relFile}#${sym.name}`;
      addNode({
        id: symId,
        label: `${sym.name} (${sym.kind})`,
        kind: "symbol",
        langOrFormat: extname(relFile).replace(".", "") || "code",
        detail: `${relFile}:${sym.line}-${sym.endLine} | ${sym.signature}`,
      });
      edges.push({
        source: `file:${relFile}`,
        target: symId,
        kind: "imports",
        label: "defines",
      });
    }
  }

  // Add Doc nodes & Doc <-> Code edges
  const docSections = scanWorkspaceDocuments(index.rootDir);
  const docLinks = buildDocCodeLinks(index, docSections);
  for (const sec of docSections) {
    addNode({
      id: `doc:${sec.docPath}#${sec.title}`,
      label: `${sec.docPath}#${sec.title}`,
      kind: "doc",
      langOrFormat: sec.format,
      detail: sec.summary,
    });
  }
  for (const link of docLinks) {
    const docId = `doc:${link.docPath}#${link.sectionTitle}`;
    const symId = `sym:${link.codeFile}#${link.symbolName}`;
    if (nodeIds.has(docId) && nodeIds.has(symId)) {
      edges.push({
        source: docId,
        target: symId,
        kind: "doc-links-code",
        label: link.reason,
      });
    }
  }

  // Add Co-Edit edges & Macro nodes
  const store = loadMacroStore(index.rootDir);
  for (const ce of store.habits.coEdits) {
    if (nodeIds.has(`file:${ce.fileA}`) && nodeIds.has(`file:${ce.fileB}`)) {
      edges.push({
        source: `file:${ce.fileA}`,
        target: `file:${ce.fileB}`,
        kind: "co-edit",
        label: `${Math.round((ce.confidence ?? Math.min(1, ce.coEditCount / 5)) * 100)}% co-edit`,
      });
    }
  }
  for (const m of store.macros) {
    addNode({
      id: `macro:${m.id}`,
      label: `${m.id} (${m.kind})`,
      kind: "macro",
      langOrFormat: "mjs",
      detail: m.description,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

export function generateKnowledgeGraphHtml(
  index: ReturnType<typeof getWorkspaceAstIndex>
): { htmlPath: string; jsonPath: string; nodeCount: number; edgeCount: number } {
  const graph = buildKnowledgeGraphData(index);
  const outDir = join(index.rootDir, ".graphflow");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "knowledge-graph.json");
  const htmlPath = join(outDir, "knowledge-graph.html");
  writeFileSync(jsonPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>GraphFlow 3.1 — Interactive Project Knowledge Graph</title>
<style>
  :root {
    --bg: #0b0f19;
    --panel: #111827;
    --border: #1f2937;
    --text: #f3f4f6;
    --muted: #9ca3af;
    --file: #3b82f6;
    --symbol: #10b981;
    --doc: #f59e0b;
    --macro: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  h1 { font-size: 16px; font-weight: 700; }
  .stats { font-size: 12px; color: var(--muted); }
  input[type="search"] { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: #030712; color: var(--text); font-size: 13px; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; background: #1f2937; cursor: pointer; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  #inspector { border-top: 1px solid var(--border); padding-top: 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; color: #d1d5db; }
  #canvas-wrap { flex: 1; position: relative; }
  canvas { width: 100%; height: 100%; display: block; cursor: grab; }
</style>
</head>
<body>
  <div id="sidebar">
    <h1>GraphFlow 3.1 Knowledge Graph</h1>
    <div class="stats">Nodes: ${graph.nodes.length} · Edges: ${graph.edges.length}</div>
    <input id="search" type="search" placeholder="Search symbol, file, or doc (中文/EN)..." />
    <div class="legend">
      <span class="badge"><span class="dot" style="background:var(--file)"></span>Code File</span>
      <span class="badge"><span class="dot" style="background:var(--symbol)"></span>AST Symbol</span>
      <span class="badge"><span class="dot" style="background:var(--doc)"></span>Spec Doc (md/docx/xml/html/pdf)</span>
      <span class="badge"><span class="dot" style="background:var(--macro)"></span>Compiled Macro</span>
    </div>
    <div id="inspector">Click any node on the canvas to inspect its signature, Blast Radius, and linked development documents.</div>
  </div>
  <div id="canvas-wrap"><canvas id="graph"></canvas></div>
<script>
const GRAPH = ${JSON.stringify(graph)};
const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
const inspector = document.getElementById("inspector");
const searchInput = document.getElementById("search");
const COLORS = { file: "#3b82f6", symbol: "#10b981", doc: "#f59e0b", macro: "#a855f7" };

function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", resize);
resize();

const nodes = GRAPH.nodes.map((n, idx) => {
  const angle = (idx / Math.max(1, GRAPH.nodes.length)) * Math.PI * 2;
  const radius = n.kind === "file" ? 140 : n.kind === "doc" ? 220 : 280;
  return {
    ...n,
    x: canvas.clientWidth / 2 + Math.cos(angle) * radius,
    y: canvas.clientHeight / 2 + Math.sin(angle) * radius,
    vx: 0,
    vy: 0,
  };
});
const nodeById = new Map(nodes.map(n => [n.id, n]));
const edges = GRAPH.edges.map(e => ({
  ...e,
  s: nodeById.get(e.source),
  t: nodeById.get(e.target),
})).filter(e => e.s && e.t);

let query = "";
let selected = null;
searchInput.addEventListener("input", e => { query = e.target.value.trim().toLowerCase(); });

canvas.addEventListener("click", e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  selected = nodes.find(n => Math.hypot(n.x - mx, n.y - my) < 12) || null;
  if (selected) {
    const connected = edges
      .filter(ed => ed.s === selected || ed.t === selected)
      .map(ed => \`- [\${ed.kind}] \${ed.s === selected ? ed.t.label : ed.s.label} (\${ed.label || ""})\`);
    inspector.textContent = [
      \`[\${selected.kind.toUpperCase()}] \${selected.label}\`,
      \`Format/Lang: \${selected.langOrFormat}\`,
      \`Detail: \${selected.detail}\`,
      "",
      \`Connected Edges (\${connected.length}):\`,
      ...connected
    ].join("\\n");
  }
});

function tick() {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x || 0.1, dy = b.y - a.y || 0.1;
      const d2 = dx * dx + dy * dy;
      if (d2 < 9000) {
        const f = 120 / Math.max(25, d2);
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
  }
  for (const ed of edges) {
    const dx = ed.t.x - ed.s.x, dy = ed.t.y - ed.s.y;
    ed.s.vx += dx * 0.003; ed.s.vy += dy * 0.003;
    ed.t.vx -= dx * 0.003; ed.t.vy -= dy * 0.003;
  }
  for (const n of nodes) {
    n.x += n.vx; n.y += n.vy;
    n.vx *= 0.82; n.vy *= 0.82;
  }

  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  for (const ed of edges) {
    ctx.strokeStyle = ed.kind === "doc-links-code" ? "#f59e0b88" : ed.kind === "co-edit" ? "#ec489988" : "#37415188";
    ctx.lineWidth = ed.kind === "doc-links-code" ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(ed.s.x, ed.s.y);
    ctx.lineTo(ed.t.x, ed.t.y);
    ctx.stroke();
  }
  for (const n of nodes) {
    const match = !query || n.label.toLowerCase().includes(query) || n.detail.toLowerCase().includes(query);
    ctx.globalAlpha = match ? 1 : 0.18;
    ctx.fillStyle = COLORS[n.kind] || "#9ca3af";
    ctx.beginPath();
    ctx.arc(n.x, n.y, n === selected ? 9 : n.kind === "file" ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "11px sans-serif";
    ctx.fillText(n.label.slice(0, 28), n.x + 9, n.y + 4);
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(tick);
}
tick();
</script>
</body>
</html>`;

  writeFileSync(htmlPath, html, "utf8");
  return {
    htmlPath,
    jsonPath,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
}
