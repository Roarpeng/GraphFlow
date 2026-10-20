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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import {
  inferReceiverTypeIndex,
  isSubclassOf,
  parseClassParents,
  resolveReceiverType,
  resolveRelativeImportPath,
  sourceLanguageFamily,
  type AstCallSite,
  type FileAstAnalysis,
  type SourceLanguageFamily,
} from "./ast-engine.js";
import { loadMacroStore } from "./macro-engine.js";
import { ensureGraphflowDir } from "./graphflow-dir.js";
import { getSemanticIndex, SEMANTIC_CONFIDENCE_MIN } from "./semantic-index.js";
import type { getWorkspaceAstIndex } from "./slicer.js";
import { segmentChinese, toPinyin, tokenizeEnglish } from "./tokenizer.js";

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
  /**
   * Full section text (title + body, before the 220-char `summary` truncation). Used to verify
   * that a doc<->code link target is literally mentioned in this section before emitting an
   * edge. Optional because hand-built `DocSection`s may omit it.
   */
  text?: string;
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
  kind: "defines" | "imports" | "calls" | "doc-links-code" | "co-edit";
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
  const backtickSpans: Array<{ start: number; end: number; raw: string }> = [];
  // 1. Backticked code spans: `symbolName` or `ClassName.method`.
  // Keep the full identifier. Splitting `OrderService.timeout` into `OrderService` + `timeout`
  // steals the per-section link cap from the real method and the constant beside it.
  for (const m of text.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$.:#-]*)`/g)) {
    const raw = m[1]!;
    ids.add(raw);
    if (m.index !== undefined) {
      backtickSpans.push({ start: m.index + 1, end: m.index + 1 + raw.length, raw });
    }
  }
  // 2. CamelCase or snake_case identifiers in prose. A CamelCase word that is only the
  // qualifier inside `` `Class.method` `` is not its own explicit symbol.
  for (const m of text.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g)) {
    const word = m[1]!;
    if (!(/[A-Z]/.test(word) || word.includes("_"))) continue;
    const idx = m.index ?? -1;
    const qualifierOnly = backtickSpans.some(
      (span) =>
        idx >= span.start &&
        idx < span.end &&
        span.raw !== word &&
        /[.#:]/.test(span.raw)
    );
    if (qualifierOnly) continue;
    ids.add(word);
  }
  return Array.from(ids);
}

/**
 * Extracts raw (unexpanded) concept tokens from prose: English words + morphological stems,
 * plus segmented CJK words and their Pinyin keys.
 *
 * Deliberately does NOT use `tokenizeBilingualQuery` here: its synonym/glossary expansion turns
 * a single symbol (`cancel_order`) or heading (`Payment Callback`) into a huge vocabulary blob
 * (`cancel`, `abort`, `refund`, `return`, `payment`, `pay`, ...) so almost every doc<->code pair
 * overlaps. Raw tokens keep concept links anchored to what the document actually says.
 */
function extractConceptTokens(text: string): string[] {
  const tokens = new Set<string>();
  const en = tokenizeEnglish(text);
  for (const raw of [...en.words, ...en.stems]) {
    const token = raw.toLowerCase();
    if (token.length >= 2) tokens.add(token);
  }
  const zh = segmentChinese(text);
  for (const word of zh.words) {
    tokens.add(word);
    const pinyin = toPinyin(word);
    if (pinyin) tokens.add(pinyin);
  }
  return Array.from(tokens);
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
    const bilingualTokens = extractConceptTokens(fullText);
    sections.push({
      docPath: relPath,
      format,
      title: currentTitle,
      startLine: currentStart,
      endLine: Math.max(currentStart, endLine),
      summary: body.replace(/\s+/g, " ").slice(0, 220),
      referencedIdentifiers: extractCandidateSymbolsFromDocText(fullText),
      bilingualTokens,
      text: fullText,
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
 * Lists workspace development documents (`.md`, `.html`, `.xml`, `.docx`, `.pdf`) without
 * parsing them. Shared by the scanner and by the graph fingerprint (stat-only, cheap).
 */
function listWorkspaceDocumentPaths(rootDir: string, maxDocs = 200): string[] {
  const paths: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 6 || paths.length >= maxDocs) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (paths.length >= maxDocs) break;
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
        paths.push(relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  };

  walk(rootDir, 0);
  return paths;
}

/**
 * Scans workspace for development documents (`.md`, `.html`, `.xml`, `.docx`, `.pdf`).
 */
/**
 * Document parsing is the single most expensive part of a doc-link rebuild (≈920 ms for a
 * mid-size repo) and it depends on nothing but the documentation files themselves, which
 * change far less often than source. The parsed sections are therefore cached wholesale and
 * invalidated by a fingerprint over every document's path/size/mtime.
 */
const DOC_SECTION_CACHE_VERSION = 1;
const DOC_SECTION_CACHE_REL = ".graphflow/doc-links/sections.json";

interface DocSectionCacheFile {
  version: number;
  fingerprint: string;
  sections: readonly DocSection[];
}

function computeDocSectionFingerprint(rootDir: string, maxDocs: number): string {
  const hash = createHash("sha1");
  hash.update(`v${DOC_SECTION_CACHE_VERSION}\nmax=${maxDocs}\n`);
  for (const rel of listWorkspaceDocumentPaths(rootDir, maxDocs)) {
    appendStatFingerprint(hash, rootDir, rel);
  }
  return hash.digest("hex");
}

function readDocSectionCache(rootDir: string, fingerprint: string): DocSection[] | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(rootDir, ...DOC_SECTION_CACHE_REL.split("/")), "utf8")
    ) as DocSectionCacheFile;
    if (parsed?.version !== DOC_SECTION_CACHE_VERSION) return undefined;
    if (parsed.fingerprint !== fingerprint) return undefined;
    if (!Array.isArray(parsed.sections)) return undefined;
    return parsed.sections;
  } catch {
    return undefined;
  }
}

function writeDocSectionCache(
  rootDir: string,
  fingerprint: string,
  sections: readonly DocSection[]
): void {
  try {
    ensureGraphflowDir(rootDir);
    const path = join(rootDir, ...DOC_SECTION_CACHE_REL.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: DOC_SECTION_CACHE_VERSION,
        fingerprint,
        sections,
      } satisfies DocSectionCacheFile),
      "utf8"
    );
  } catch {
    // A cache that cannot be written is simply a cache that is never hit.
  }
}

export function scanWorkspaceDocuments(rootDir: string, maxDocs = 200): DocSection[] {
  if (process.env.GRAPHFLOW_DOC_LINK_CACHE === "0") {
    const sections: DocSection[] = [];
    for (const rel of listWorkspaceDocumentPaths(rootDir, maxDocs)) {
      sections.push(...parseProjectDocument(rel, join(rootDir, rel)));
    }
    return sections;
  }
  const fingerprint = computeDocSectionFingerprint(rootDir, maxDocs);
  const cached = readDocSectionCache(rootDir, fingerprint);
  if (cached) return cached;
  const sections: DocSection[] = [];
  for (const rel of listWorkspaceDocumentPaths(rootDir, maxDocs)) {
    sections.push(...parseProjectDocument(rel, join(rootDir, rel)));
  }
  writeDocSectionCache(rootDir, fingerprint, sections);
  return sections;
}

/**
 * High-frequency engineering vocabulary that is NOT a distinctive concept. Concept-only links
 * built solely from these tokens are noise — this is the classic over-link bug where a
 * "Payment Callback" section matched `cancel_order` through `[cancel, order, refund, return]`.
 * Static (language-agnostic) filtering is complemented by dynamic DF filtering in
 * `buildDocCodeLinks`, so project-specific common words are filtered too.
 */
const GENERIC_DOC_CONCEPT_TOKENS = new Set<string>([
  // English words (raw + stemmed forms used by `tokenizeEnglish`)
  "add","added","adding","all","and","api","app","apply","array","as","async","auth",
  "boolean","body","buffer","build","by","cache","call","callback","called","caller","calls",
  "cancel","canceled","canceling","cancellation","cancelled","cancels","case","change","changed",
  "changes","check","checked","class","client","close","closed","code","comment","common",
  "component","config","configuration","content","count","create","created","current","customer",
  "data","date","debug","default","delete","deleted","description","detail","details","doc","docs",
  "each","else","empty","end","entry","error","errors","event","events","example","exec","execute",
  "export","fail","failed","failure","false","feature","field","file","files","find","first","fix",
  "fixed","flow","form","from","function","functions","get","global","handle","handler","handling",
  "head","hook","http","id","ids","import","index","info","init","input","integration","into","is",
  "issue","item","items","just","key","keys","last","less","line","lines","link","list","load",
  "loaded","local","log","logs","main","manager","map","max","message","messages","method","methods",
  "min","module","more","msg","name","names","new","next","node","note","notes","notify",
  "notification","null","number","object","old","on","open","opened","option","options","order",
  "orders","other","out","output","overview","page","param","params","path","paths","pay","paid",
  "payment","payments","per","prev","process","processed","processing","promise","query","read",
  "refund","refunds","remove","removed","req","request","requests","res","response","responses",
  "result","results","return","returned","returns","route","run","running","runs","same","sample",
  "samples","save","saved","section","service","services","set","setting","settings","signin",
  "signup","simple","source","spec","specs","start","started","state","status","stop","stopped",
  "string","success","successful","summary","sync","system","tag","target","task","tasks","temp",
  "test","tests","text","then","time","timestamp","todo","token","tokens","tool","tools","total",
  "true","type","types","undefined","update","updated","url","use","used","user","users","using",
  "validation","value","values","verify","via","version","webhook","webhooks","when","write",
  "written","wx",
  "ad","appl","authent","cach","cancell","chang","clos","creat","delet","descript","document",
  "entri","execut","failur","follow","generat","handl","handled","inform","integr","issu","manag",
  "messag","modul","nam","notif","queri","remov","respons","servic","sign","stat","stor","summar",
  "task","tim","updat","valid","valu","verif","writ",
  // Chinese stop concepts (the same generic vocabulary expressed in Chinese)
  "订单","取消","支付","付款","收款","退款","结账","回调","通知","消息","处理","用户","客户","账号",
  "账户","服务","管理","系统","数据","请求","响应","状态","错误","失败","成功","结果","输出","输入",
  "文件","路径","名称","测试","文档","接口","配置","设置","功能","方法","函数","模块","代码","逻辑",
  "实现","创建","修改","更新","删除","查询","获取","读取","验证","校验","检查","签名","登录","示例",
  "说明","注意","流程","买家","卖家","会员","客服",
  // Pinyin keys of the generic Chinese concepts above
  "dingdan","danju","quxiao","zuofei","chedan","tuidan","chexiao","guanbi","zhifu","fukuan",
  "shoukuan","jiezhang","tuikuan","huidiao","tongzhi","xiaoxi","chuli","yonghu","kehu","zhanghao",
  "zhanghu","fuwu","guanli","xitong","shuju","qingqiu","xiangying","zhuangtai","cuowu","shibai",
  "chenggong","jieguo","shuchu","shuru","wenjian","lujing","mingcheng","ceshi","wendang","jiekou",
  "peizhi","shezhi","gongneng","fangfa","hanshu","mokuai","daima","luoji","shixian","chuangjian",
  "xiugai","gengxin","shanchu","chaxun","huoqu","duqu","yanzheng","jiaoyan","jiancha","qianming",
  "denglu","shili","shuoming","zhuyi","liucheng","maijia","huiyuan","kefu",
]);

/** Explicit identifier mentions always outrank any concept-only overlap. */
const EXPLICIT_REF_SCORE = 100;

// ── Self-written BM25 / IDF retrieval + reciprocal-pruned graph pipeline ────────────────────
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Minimum BM25 concept score for a concept-only doc<->code candidate. */
const CONCEPT_MIN_SCORE = 4;
/** Minimum normalized confidence (score / (score + softness)) for concept-only links. */
const CONCEPT_CONFIDENCE_MIN = 0.32;
const CONCEPT_SCORE_SOFTNESS = 8;
/** Keep concept candidates within this fraction of the symbol's best candidate (margin pruning). */
const CONCEPT_MARGIN_RATIO = 0.72;
/** Strongest concept-only sections retained per symbol (before global graph matching). */
const MAX_CONCEPT_LINKS_PER_SYMBOL = 2;
/** Reciprocal top-K lists: a concept link must be top-K on BOTH the section and symbol sides. */
const RECIPROCAL_SECTION_TOP_K = 3;
const PER_SECTION_LINK_LIMIT = 3;
const PER_SYMBOL_LINK_LIMIT = 3;
/** Default global cap on emitted doc<->code links (`GRAPHFLOW_DOC_LINKS_MAX` overrides). */
const DEFAULT_DOC_LINKS_MAX = 400;
const DOC_LINKS_MAX_ENV = "GRAPHFLOW_DOC_LINKS_MAX";
const DOC_LINK_FEEDBACK_REL_PATH = ".graphflow/doc-link-feedback.json";

// Field boosts for the section retrieval document.
const SECTION_TITLE_BOOST = 2;
const SECTION_EXPLICIT_ID_BOOST = 2.5;
// Weights for the symbol retrieval query context.
const SYMBOL_NAME_WEIGHT = 3;
const SYMBOL_PARENT_WEIGHT = 1.5;
const SYMBOL_SIGNATURE_WEIGHT = 0.8;
const SYMBOL_DOC_WEIGHT = 1;
const SYMBOL_PATH_WEIGHT = 0.3;
const SYMBOL_IMPORT_WEIGHT = 0.2;

function normalizeIdentifierKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

interface SectionRetrievalData {
  section: DocSection;
  /** Field-weighted term frequencies: body 1x, title +2, explicit identifiers +2.5. */
  tf: Map<string, number>;
  length: number;
  identifierKeys: Set<string>;
}

interface SymbolRetrievalData {
  relFile: string;
  symbol: FileAstAnalysis["symbols"][number];
  /** Field-weighted query terms: name, parentClass, signature, comments/docstring, path, imports. */
  weights: Map<string, number>;
  identifierKey: string;
  qualifiedIdentifierKey?: string;
  normalizedName: string;
}

interface ConceptCandidate {
  symbolIdx: number;
  sectionIdx: number;
  score: number;
  confidence: number;
  sharedTokens: string[];
  link: DocCodeLink;
}

/**
 * A cached concept candidate. `so` is the symbol index *within its own file* rather than the
 * flat `symbolData` index: the flat index shifts whenever an earlier file gains or loses a
 * symbol, which would invalidate every later file's cache entry.
 */
interface ConceptFileCandidate {
  so: number;
  si: number;
  sc: number;
  cf: number;
  st: string[];
  link: DocCodeLink;
}

interface ConceptFileRecord {
  /** Symbol-data hash of the file this record was computed from. */
  hash: string;
  /** Concept tokens this file's symbols use; the DF-based eligibility test depends on them. */
  tokens: string[];
  cand: ConceptFileCandidate[];
}

interface ConceptStore {
  version: number;
  /** Fingerprint of the parsed documentation: sections are the retrieval corpus. */
  docFp: string;
  /** Fingerprint of the feedback file, which can reject or boost individual links. */
  feedbackFp: string;
  files: Record<string, ConceptFileRecord>;
}

const CONCEPT_STORE_VERSION = 1;
const CONCEPT_STORE_REL = ".graphflow/doc-links/concepts.json";

function readConceptStore(rootDir: string): ConceptStore | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(rootDir, ...CONCEPT_STORE_REL.split("/")), "utf8")
    ) as ConceptStore;
    if (parsed?.version !== CONCEPT_STORE_VERSION) return undefined;
    if (typeof parsed.files !== "object" || parsed.files === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeConceptStore(rootDir: string, store: ConceptStore): void {
  try {
    ensureGraphflowDir(rootDir);
    const path = join(rootDir, ...CONCEPT_STORE_REL.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store), "utf8");
  } catch {
    // A cache that cannot be written is simply a cache that is never hit.
  }
}

function addWeightedConceptTokens(
  target: Map<string, number>,
  text: string,
  weight: number
): void {
  if (!text) return;
  for (const token of extractConceptTokens(text)) {
    if (token.length < 2) continue;
    target.set(token, (target.get(token) ?? 0) + weight);
  }
}

function buildSectionIdentifierKeys(sec: DocSection): Set<string> {
  const identifierKeys = new Set<string>();
  for (const identifier of sec.referencedIdentifiers) {
    // Full key only. `OrderService.timeout` matches the qualified method key
    // (`orderservicetimeout`); splitting on `.`/`_` also matched the class and a
    // bare `timeout` fragment and crowded out constants such as TIMEOUT_WINDOW_MS.
    const fullKey = normalizeIdentifierKey(identifier);
    if (fullKey.length >= 3) identifierKeys.add(fullKey);
  }
  return identifierKeys;
}

/** Concept-only links should not land on test fixtures. Explicit `` `Symbol` `` mentions still link. */
function isConceptDeprioritizedSymbol(relFile: string, symbolName: string): boolean {
  const file = relFile.replace(/\\/g, "/");
  const base = file.split("/").pop() ?? file;
  if (
    file.includes("/tests/") ||
    file.includes("/__tests__/") ||
    file.includes("/test/") ||
    /\.test\./.test(base) ||
    /\.spec\./.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.go$/.test(base) ||
    /Tests\.(?:cs|java)$/.test(base)
  ) {
    return true;
  }
  if (/^(?:test_|Test|setUp|tearDown|SetUp|TearDown)/.test(symbolName)) return true;
  if (/(?:Tests|Test)$/.test(symbolName) && symbolName !== "Test") return true;
  return false;
}

/**
 * Pinyin of a CJK token is the same concept, not a second shared token.
 * `买家` + `maijia` therefore counts as one.
 */
function independentSharedCount(shared: readonly string[]): number {
  const keys = new Set<string>();
  for (const token of shared) {
    const pinyin = /[\u4e00-\u9fff]/.test(token) ? toPinyin(token) : undefined;
    keys.add(pinyin && pinyin.length > 0 ? pinyin : token);
  }
  return keys.size;
}

function buildSectionRetrievalData(sec: DocSection): SectionRetrievalData {
  const tf = new Map<string, number>();
  for (const raw of sec.bilingualTokens) {
    const token = raw.toLowerCase();
    if (token.length >= 2) tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  // Manually constructed `DocSection`s may omit token payloads; derive from title+summary.
  if (tf.size === 0) addWeightedConceptTokens(tf, `${sec.title}\n${sec.summary}`, 1);
  // Field boosts: title + explicit identifier mentions are the highest-signal doc fields.
  addWeightedConceptTokens(tf, sec.title, SECTION_TITLE_BOOST);
  addWeightedConceptTokens(tf, sec.referencedIdentifiers.join(" "), SECTION_EXPLICIT_ID_BOOST);
  let length = 0;
  for (const value of tf.values()) length += value;
  return {
    section: sec,
    tf,
    length: Math.max(1, length),
    identifierKeys: buildSectionIdentifierKeys(sec),
  };
}

/**
 * Extracts the symbol's local documentation context: the leading comment block (JSDoc / `//` /
 * `#` / decorators) plus an immediately-following docstring or leading body comment.
 * Bounded, line-based best-effort scan.
 */
function extractSymbolDocContext(content: string, oneBasedLine: number): string {
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  const parts: string[] = [];
  let blankRun = 0;
  for (let i = oneBasedLine - 2; i >= 0 && parts.length < 12; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun > 1 || parts.length > 0) break;
      continue;
    }
    blankRun = 0;
    if (/^(?:\/\/|\/\*|\*|#|@|"""|''')/.test(trimmed)) {
      parts.unshift(
        trimmed
          .replace(/^[/*#@\s]+/, "")
          .replace(/\*\/\s*$/, "")
          .trim()
      );
      continue;
    }
    break;
  }
  for (let i = oneBasedLine; i < Math.min(lines.length, oneBasedLine + 3); i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;
    if (/^(?:"""|'''|\/\/|\*|\/\*\*)/.test(trimmed)) {
      parts.push(
        trimmed
          .replace(/^(?:\/\/|\*|\/\*\*|"""|''')\s*/, "")
          .replace(/"""|'''/g, "")
          .trim()
      );
    }
    break;
  }
  return parts.filter(Boolean).join("\n");
}

function buildSymbolRetrievalData(
  relFile: string,
  ast: FileAstAnalysis,
  content: string,
  symbol: FileAstAnalysis["symbols"][number]
): SymbolRetrievalData {
  const weights = new Map<string, number>();
  addWeightedConceptTokens(weights, symbol.name, SYMBOL_NAME_WEIGHT);
  if (symbol.parentClass) addWeightedConceptTokens(weights, symbol.parentClass, SYMBOL_PARENT_WEIGHT);
  if (symbol.signature) addWeightedConceptTokens(weights, symbol.signature, SYMBOL_SIGNATURE_WEIGHT);
  const docContext = extractSymbolDocContext(content, symbol.line);
  if (docContext) addWeightedConceptTokens(weights, docContext, SYMBOL_DOC_WEIGHT);
  addWeightedConceptTokens(
    weights,
    relFile.replace(/\.[^./]+$/, "").replace(/[\\/]+/g, " "),
    SYMBOL_PATH_WEIGHT
  );
  for (const imp of ast.imports.slice(0, 10)) {
    const moduleLeaf = imp.module.split("/").filter(Boolean).pop() ?? "";
    if (moduleLeaf) addWeightedConceptTokens(weights, moduleLeaf, SYMBOL_IMPORT_WEIGHT);
  }
  const parent = symbol.parentClass;
  return {
    relFile,
    symbol,
    weights,
    identifierKey: normalizeIdentifierKey(symbol.name),
    ...(parent ? { qualifiedIdentifierKey: normalizeIdentifierKey(`${parent}.${symbol.name}`) } : {}),
    normalizedName: symbol.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  };
}

/** Resolves the global doc<->code link cap (`GRAPHFLOW_DOC_LINKS_MAX`, default 400). */
function resolveDocLinksGlobalCap(): number {
  const raw = process.env[DOC_LINKS_MAX_ENV];
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_DOC_LINKS_MAX;
}

function docLinkSortKey(link: DocCodeLink): string {
  return `${link.docPath}\u0000${link.sectionTitle}\u0000${link.codeFile}\u0000${link.symbolName}`;
}

/** Deterministic doc<->code link id used by `.graphflow/doc-link-feedback.json`. */
export function docCodeLinkId(
  link: Pick<DocCodeLink, "docPath" | "sectionTitle" | "codeFile" | "symbolName">
): string {
  return `${link.docPath}#${link.sectionTitle}::${link.codeFile}#${link.symbolName}`;
}

/** Optional human feedback: accepted links are boosted, rejected links are suppressed. */
export interface DocLinkFeedback {
  accepted?: string[];
  rejected?: string[];
  tokenBoosts?: Record<string, number>;
}

function feedbackStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return list.length > 0 ? list : undefined;
}

/** Reads (never writes) `.graphflow/doc-link-feedback.json`; absent/invalid input yields `{}`. */
export function loadDocLinkFeedback(rootDir: string): DocLinkFeedback {
  const feedbackPath = join(rootDir, ...DOC_LINK_FEEDBACK_REL_PATH.split("/"));
  if (!existsSync(feedbackPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(feedbackPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const feedback: DocLinkFeedback = {};
    const accepted = feedbackStringList(record.accepted);
    if (accepted) feedback.accepted = accepted;
    const rejected = feedbackStringList(record.rejected);
    if (rejected) feedback.rejected = rejected;
    if (record.tokenBoosts && typeof record.tokenBoosts === "object") {
      const boosts: Record<string, number> = {};
      for (const [token, rawBoost] of Object.entries(
        record.tokenBoosts as Record<string, unknown>
      )) {
        if (typeof rawBoost === "number" && Number.isFinite(rawBoost)) boosts[token] = rawBoost;
      }
      if (Object.keys(boosts).length > 0) feedback.tokenBoosts = boosts;
    }
    return feedback;
  } catch {
    return {};
  }
}

/**
 * Explicit write helper for doc-link feedback (the linker itself only ever reads the file).
 * Merges `accepted` / `rejected` link ids and per-token boosts into the existing store.
 */
export function recordDocLinkFeedback(rootDir: string, patch: DocLinkFeedback): DocLinkFeedback {
  const existing = loadDocLinkFeedback(rootDir);
  const mergeList = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
    const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
    return merged.length > 0 ? merged : undefined;
  };
  const merged: DocLinkFeedback = {};
  const accepted = mergeList(existing.accepted, patch.accepted);
  if (accepted) merged.accepted = accepted;
  const rejected = mergeList(existing.rejected, patch.rejected);
  if (rejected) merged.rejected = rejected;
  const boosts: Record<string, number> = {
    ...(existing.tokenBoosts ?? {}),
    ...(patch.tokenBoosts ?? {}),
  };
  if (Object.keys(boosts).length > 0) merged.tokenBoosts = boosts;
  const feedbackPath = join(rootDir, ...DOC_LINK_FEEDBACK_REL_PATH.split("/"));
  mkdirSync(dirname(feedbackPath), { recursive: true });
  writeFileSync(feedbackPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

/**
 * Builds bidirectional links between project documents (`.md`, `.docx`, `.xml`, `.html`, `.pdf`)
 * and code symbols in the workspace AST index.
 *
 * Pipeline (self-written, dependency-free):
 *  1. Explicit identifier / `Class.method` mentions are authoritative (score 100) and exempt
 *     from concept pruning (they only respect the global cap).
 *  2. Concept candidates are scored with BM25 over field-weighted section terms (title and
 *     explicit ids boosted), IDF from workspace document frequency, and a PMI-style rare-token
 *     pair bonus. Generic tokens (static stoplist + dynamic DF cutoffs) carry no weight.
 *  3. Graph pruning: reciprocal top-K (a candidate must rank on BOTH the section and symbol
 *     side) -> per-symbol margin -> greedy maximum-weight matching with section/symbol caps.
 *  4. `GRAPHFLOW_DOC_LINKS_MAX` (default 400) caps the global edge count; low-confidence
 *     concept links are dropped.
 *  5. Optional read-only feedback from `.graphflow/doc-link-feedback.json` can boost accepted
 *     links / suppress rejected ones (write via `recordDocLinkFeedback`).
 */
/**
 * On-disk cache for `buildDocCodeLinks`.
 *
 * The link corpus is a whole-workspace computation (document frequency over every
 * doc section and every symbol), so even a single-symbol `read` paid for all of
 * it — ~1.2s of a 274-file workspace. The result is a pure function of the source
 * files, the document files and the global cap, so it can be reused by every later
 * process and by every agent sharing the workspace.
 *
 * The cache is keyed by fingerprint rather than by path, so a modified file
 * invalidates it without any bookkeeping. `GRAPHFLOW_DOC_LINK_CACHE=0` disables it.
 */
const DOC_LINK_CACHE_VERSION = 1;
const DOC_LINK_CACHE_DIR_REL = ".graphflow/doc-links";
/** Version of the per-file symbol retrieval shard; bump when `buildSymbolRetrievalData` changes. */
const SYMBOL_DATA_CACHE_VERSION = 1;

function docLinkCacheEnabled(): boolean {
  return process.env.GRAPHFLOW_DOC_LINK_CACHE !== "0";
}

function docLinkCachePath(rootDir: string, key: string): string {
  return join(rootDir, DOC_LINK_CACHE_DIR_REL, `${createHash("sha1").update(key).digest("hex")}.json`);
}

function computeDocLinkFingerprint(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  docSections: readonly DocSection[] | undefined
): string {
  const hash = createHash("sha1");
  hash.update(`v${DOC_LINK_CACHE_VERSION}\n`);
  hash.update(`cap=${resolveDocLinksGlobalCap()}\n`);
  if (docSections && docSections.length > 0) {
    for (const relPath of [...new Set(docSections.map((s) => s.docPath))].sort()) {
      hash.update(`${relPath}\n`);
      appendStatFingerprint(hash, index.rootDir, relPath);
    }
  } else {
    hash.update("*all-docs*\n");
    for (const relPath of listWorkspaceDocumentPaths(index.rootDir)) {
      appendStatFingerprint(hash, index.rootDir, relPath);
    }
  }
  // Feedback can reject/boost individual links, so it is a first-class cache input:
  // without this the cache would hide a user's "reject this link" decision.
  appendStatFingerprint(hash, index.rootDir, DOC_LINK_FEEDBACK_REL_PATH);
  for (const relPath of index.getFiles()) appendStatFingerprint(hash, index.rootDir, relPath);
  return hash.digest("hex");
}

function readDocLinkCache(rootDir: string, key: string): DocCodeLink[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(docLinkCachePath(rootDir, key), "utf8")) as
      | { version?: number; links?: DocCodeLink[] }
      | undefined;
    if (!parsed || parsed.version !== DOC_LINK_CACHE_VERSION || !Array.isArray(parsed.links)) {
      return undefined;
    }
    return parsed.links;
  } catch {
    return undefined;
  }
}

function writeDocLinkCache(rootDir: string, key: string, links: readonly DocCodeLink[]): void {
  try {
    ensureGraphflowDir(rootDir);
    const dir = join(rootDir, DOC_LINK_CACHE_DIR_REL);
    mkdirSync(dir, { recursive: true });
    const target = docLinkCachePath(rootDir, key);
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}.json`);
    writeFileSync(tmp, JSON.stringify({ version: DOC_LINK_CACHE_VERSION, links }), "utf8");
    renameSync(tmp, target);
  } catch {
    // A read-only workspace or a lost race must never fail the link build.
  }
}



interface SymbolDataShardEntry {
  symbol: unknown;
  weights: Array<[string, number]>;
  identifierKey: string;
  qualifiedIdentifierKey?: string;
  normalizedName: string;
}

interface SymbolDataStoreRecord {
  hash: string;
  entries: SymbolDataShardEntry[];
}

interface SymbolDataStore {
  version: number;
  files: Record<string, SymbolDataStoreRecord>;
}

const SYMBOL_DATA_STORE_REL = ".graphflow/doc-links/symbols.json";

function readSymbolDataStore(rootDir: string): SymbolDataStore | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(rootDir, ...SYMBOL_DATA_STORE_REL.split("/")), "utf8")
    ) as SymbolDataStore;
    if (parsed?.version !== SYMBOL_DATA_CACHE_VERSION) return undefined;
    if (typeof parsed.files !== "object" || parsed.files === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSymbolDataStore(rootDir: string, store: SymbolDataStore): void {
  try {
    ensureGraphflowDir(rootDir);
    const path = join(rootDir, ...SYMBOL_DATA_STORE_REL.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store), "utf8");
  } catch {
    // A cache that cannot be written is simply a cache that is never hit.
  }
}

/**
 * Reads the cached retrieval data for one source file, or `undefined` when the
 * file changed (content hash mismatch) or nothing was cached yet.
 */


export function buildDocCodeLinks(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  docSections?: DocSection[]
): DocCodeLink[] {
  const cacheEnabled = docLinkCacheEnabled();
  const cacheKey = cacheEnabled ? computeDocLinkFingerprint(index, docSections) : "";
  if (cacheEnabled) {
    const cached = readDocLinkCache(index.rootDir, cacheKey);
    if (cached) return cached;
  }
  const sections = docSections ?? scanWorkspaceDocuments(index.rootDir);
  if (sections.length === 0) return [];

  kgStage("doc: scan documents");
  const sectionData = sections.map(buildSectionRetrievalData);
  kgStage("doc: sectionData");
  // Per-file incremental: the retrieval data of an unchanged file is reused from
  // `.graphflow/doc-links/symbols/`, so editing one file no longer re-tokenizes
  // every symbol in the workspace.
  const symbolDataCacheOn = docLinkCacheEnabled();
  const symbolData: SymbolRetrievalData[] = [];
  // One file instead of one shard per source file: 274 small reads cost ~1s on Windows,
  // which dominated the whole doc-link stage. The store is rewritten only when something
  // actually changed, and is rebuilt from the current file list so deleted files drop out.
  const store = symbolDataCacheOn ? readSymbolDataStore(index.rootDir) : undefined;
  const storeFiles: Record<string, SymbolDataStoreRecord> = {};
  let storeChanged = false;
  /** Where each file's symbols live inside the flat `symbolData` array. */
  const fileRanges: Array<{ relFile: string; start: number; count: number; hash: string }> = [];
  for (const relFile of index.getFiles()) {
    const fileData = index.getFileAnalysis(relFile);
    if (!fileData) continue;
    const contentHash = store
      ? createHash("sha1").update(fileData.content).digest("hex")
      : "";
    const fileStart = symbolData.length;
    const cached = store?.files[relFile];
    if (cached && cached.hash === contentHash) {
      for (const entry of cached.entries) {
        symbolData.push({
          relFile,
          symbol: entry.symbol as SymbolRetrievalData["symbol"],
          weights: new Map(entry.weights),
          identifierKey: entry.identifierKey,
          ...(entry.qualifiedIdentifierKey !== undefined
            ? { qualifiedIdentifierKey: entry.qualifiedIdentifierKey }
            : {}),
          normalizedName: entry.normalizedName,
        });
      }
      storeFiles[relFile] = cached;
      fileRanges.push({
        relFile,
        start: fileStart,
        count: cached.entries.length,
        hash: contentHash,
      });
      continue;
    }
    const built: SymbolRetrievalData[] = [];
    for (const sym of fileData.ast.symbols) {
      built.push(buildSymbolRetrievalData(relFile, fileData.ast, fileData.content, sym));
    }
    symbolData.push(...built);
    fileRanges.push({ relFile, start: fileStart, count: built.length, hash: contentHash });
    if (store) {
      storeFiles[relFile] = {
        hash: contentHash,
        entries: built.map((sd) => ({
          symbol: sd.symbol,
          weights: [...sd.weights],
          identifierKey: sd.identifierKey,
          ...(sd.qualifiedIdentifierKey !== undefined
            ? { qualifiedIdentifierKey: sd.qualifiedIdentifierKey }
            : {}),
          normalizedName: sd.normalizedName,
        })),
      };
      storeChanged = true;
    }
  }
  kgStage("doc: symbolData loaded");
  if (store && storeChanged) {
    writeSymbolDataStore(index.rootDir, {
      version: SYMBOL_DATA_CACHE_VERSION,
      files: storeFiles,
    });
  }
  if (symbolData.length === 0) return [];

  kgStage("doc: symbolData+df");
  // ── Workspace document frequency: sections are the retrieval corpus, symbols the query corpus.
  const sectionDf = new Map<string, number>();
  for (const sd of sectionData) {
    for (const token of sd.tf.keys()) {
      sectionDf.set(token, (sectionDf.get(token) ?? 0) + 1);
    }
  }
  const symbolDf = new Map<string, number>();
  for (const sd of symbolData) {
    for (const token of sd.weights.keys()) {
      symbolDf.set(token, (symbolDf.get(token) ?? 0) + 1);
    }
  }
  const sectionCount = sectionData.length;
  const symbolCount = symbolData.length;
  const avgSectionLength =
    sectionData.reduce((sum, sd) => sum + sd.length, 0) / Math.max(1, sectionCount);

  /**
   * Concept token eligibility: the static generic stoplist plus dynamic workspace DF cutoffs.
   * A token in >=25% of doc sections (or >=35% of symbols) cannot discriminate and is dropped.
   */
  const isEligibleConceptToken = (token: string): boolean => {
    if (token.length < 2) return false;
    if (GENERIC_DOC_CONCEPT_TOKENS.has(token)) return false;
    const dfSections = sectionDf.get(token) ?? 0;
    if (dfSections === 0) return false;
    if (dfSections >= 4 && dfSections / sectionCount >= 0.25) return false;
    const dfSymbols = symbolDf.get(token) ?? 0;
    if (dfSymbols >= 6 && dfSymbols / symbolCount >= 0.35) return false;
    return true;
  };
  const conceptIdf = (token: string): number => {
    const dfSections = sectionDf.get(token) ?? 0;
    return Math.log(1 + (sectionCount - dfSections + 0.5) / (dfSections + 0.5));
  };

  kgStage("doc: feedback");
  // ── Optional read-only feedback ──
  const feedback = loadDocLinkFeedback(index.rootDir);
  const rejectedLinkIds = new Set(feedback.rejected ?? []);
  const acceptedLinkIds = new Set(feedback.accepted ?? []);
  const tokenBoosts = feedback.tokenBoosts ?? {};
  const acceptedTokens = new Set<string>();
  for (const linkId of acceptedLinkIds) {
    for (const token of extractConceptTokens(linkId.replace(/[#:]/g, " "))) acceptedTokens.add(token);
  }

  const makeLink = (
    sec: DocSection,
    sd: SymbolRetrievalData,
    conceptScore: number,
    sharedTokens: string[],
    explicit: boolean
  ): DocCodeLink => {
    const confidence = explicit
      ? 1
      : Math.min(1, conceptScore / (conceptScore + CONCEPT_SCORE_SOFTNESS));
    return {
      docPath: sec.docPath,
      sectionTitle: sec.title,
      codeFile: sd.relFile,
      symbolName: sd.symbol.name,
      reason: explicit
        ? `explicit ref \`${sd.symbol.name}\``
        : `distinctive concepts [${sharedTokens.slice(0, 4).join(", ")}] (conf=${confidence.toFixed(2)})`,
      score: explicit ? EXPLICIT_REF_SCORE : Math.round(conceptScore * 100) / 100,
      summary: sec.summary,
    };
  };

  // ── 1. Explicit identifier / `Class.method` mentions are authoritative ──
  const explicitEntries: Array<{
    link: DocCodeLink;
    sectionIdx: number;
    symbolIdx: number;
    matchedKeyLength: number;
  }> = [];
  const explicitPairKeys = new Set<string>();
  for (let symbolIdx = 0; symbolIdx < symbolData.length; symbolIdx++) {
    const sd = symbolData[symbolIdx]!;
    for (let sectionIdx = 0; sectionIdx < sectionData.length; sectionIdx++) {
      const sec = sectionData[sectionIdx]!;
      const explicit =
        sd.identifierKey.length >= 3 &&
        (sec.identifierKeys.has(sd.identifierKey) ||
          (sd.qualifiedIdentifierKey !== undefined &&
            sec.identifierKeys.has(sd.qualifiedIdentifierKey)));
      if (!explicit) continue;
      const link = makeLink(sec.section, sd, EXPLICIT_REF_SCORE, [], true);
      if (rejectedLinkIds.has(docCodeLinkId(link))) continue;
      const qualifiedLen =
        sd.qualifiedIdentifierKey !== undefined && sec.identifierKeys.has(sd.qualifiedIdentifierKey)
          ? sd.qualifiedIdentifierKey.length
          : 0;
      const bareLen = sec.identifierKeys.has(sd.identifierKey) ? sd.identifierKey.length : 0;
      explicitEntries.push({
        link,
        sectionIdx,
        symbolIdx,
        matchedKeyLength: Math.max(qualifiedLen, bareLen),
      });
      explicitPairKeys.add(`${symbolIdx}\u0000${sectionIdx}`);
    }
  }

  kgStage("doc: explicit pass");
  // ── 2. Concept candidates: BM25 over field-weighted section terms ──
  const sectionTokenPostings = new Map<string, number[]>();
  for (let sectionIdx = 0; sectionIdx < sectionData.length; sectionIdx++) {
    for (const token of sectionData[sectionIdx]!.tf.keys()) {
      const posting = sectionTokenPostings.get(token);
      if (posting) posting.push(sectionIdx);
      else sectionTokenPostings.set(token, [sectionIdx]);
    }
  }

  const conceptCandidates: ConceptCandidate[] = [];
  // Precompute eligible concept tokens once (static stoplist + dynamic DF cutoffs).
  // The bridge list is the subset of ascii/pinyin tokens that can match identifier names.
  const eligibleConceptTokens = new Set<string>();
  const bridgeConceptTokens: string[] = [];
  for (const token of sectionTokenPostings.keys()) {
    if (!isEligibleConceptToken(token)) continue;
    eligibleConceptTokens.add(token);
    if (token.length >= 4 && /^[a-z]+$/.test(token)) bridgeConceptTokens.push(token);
  }

  // Per-file unit of incremental work. `so` is the symbol's index *within its file*, so a
  // cached entry survives files being inserted or deleted around it; the flat `symbolIdx`
  // is rebuilt as `fileStart + so` when the entry is replayed.
  const computeFileCandidates = (start: number, count: number): ConceptFileCandidate[] => {
    const out: ConceptFileCandidate[] = [];
    for (let i = 0; i < count; i++) {
    const symbolIdx = start + i;
    const sd = symbolData[symbolIdx]!;
    const perSection = new Map<number, { score: number; shared: string[] }>();
    for (const [token, queryWeight] of sd.weights) {
      if (!eligibleConceptTokens.has(token)) continue;
      const posting = sectionTokenPostings.get(token);
      if (!posting) continue;
      const idf = conceptIdf(token);
      if (idf <= 0) continue;
      for (const sectionIdx of posting) {
        const sec = sectionData[sectionIdx]!;
        const tf = sec.tf.get(token) ?? 0;
        if (tf <= 0) continue;
        const denominator =
          tf + BM25_K1 * (1 - BM25_B + (BM25_B * sec.length) / Math.max(1, avgSectionLength));
        const contribution = queryWeight * idf * ((tf * (BM25_K1 + 1)) / denominator);
        const current = perSection.get(sectionIdx);
        if (current) {
          current.score += contribution;
          current.shared.push(token);
        } else {
          perSection.set(sectionIdx, { score: contribution, shared: [token] });
        }
      }
    }

    // Bilingual/Pinyin bridge: a rare ascii/pinyin section token contained in the symbol's
    // normalized name (`dingdan` -> `handleDingDanZhiFu`) adds a small concept contribution.
    for (const token of bridgeConceptTokens) {
      if (sd.weights.has(token) || !sd.normalizedName.includes(token)) continue;
      const posting = sectionTokenPostings.get(token);
      if (!posting) continue;
      const idf = conceptIdf(token);
      if (idf <= 0) continue;
      for (const sectionIdx of posting) {
        const sec = sectionData[sectionIdx]!;
        const tf = sec.tf.get(token) ?? 0;
        if (tf <= 0) continue;
        const denominator =
          tf + BM25_K1 * (1 - BM25_B + (BM25_B * sec.length) / Math.max(1, avgSectionLength));
        const contribution = 0.5 * idf * ((tf * (BM25_K1 + 1)) / denominator);
        const current = perSection.get(sectionIdx);
        if (current) {
          current.score += contribution;
          current.shared.push(token);
        } else {
          perSection.set(sectionIdx, { score: contribution, shared: [token] });
        }
      }
    }

    for (const [sectionIdx, entry] of perSection) {
      if (independentSharedCount(entry.shared) < 2) continue;
      if (isConceptDeprioritizedSymbol(sd.relFile, sd.symbol.name)) continue;
      if (explicitPairKeys.has(`${symbolIdx}\u0000${sectionIdx}`)) continue;
      const sec = sectionData[sectionIdx]!;
      const baseLink = makeLink(sec.section, sd, entry.score, entry.shared, false);
      const linkId = docCodeLinkId(baseLink);
      if (rejectedLinkIds.has(linkId)) continue;

      // PMI-style co-occurrence bonus for rare shared token pairs (both sides high IDF).
      let pairBonus = 0;
      const rareShared = entry.shared
        .filter((token) => (sectionDf.get(token) ?? 0) <= 2)
        .sort((a, b) => conceptIdf(b) - conceptIdf(a))
        .slice(0, 4);
      for (let i = 0; i < rareShared.length; i++) {
        for (let j = i + 1; j < rareShared.length; j++) {
          pairBonus += Math.min(
            2,
            conceptIdf(rareShared[i]!) * conceptIdf(rareShared[j]!) * 0.25
          );
        }
      }
      let score = entry.score + pairBonus;

      // Per-token feedback boosts (feedback tokenBoosts + tokens from accepted links).
      for (const token of entry.shared) {
        const tokenBoost = tokenBoosts[token];
        if (typeof tokenBoost === "number" && Number.isFinite(tokenBoost)) {
          score *= 1 + Math.max(-0.9, Math.min(2, tokenBoost));
        }
        if (acceptedTokens.has(token)) score *= 1.15;
      }

      const acceptedFeedback = acceptedLinkIds.has(linkId);
      if (acceptedFeedback) score += 25;
      const confidence = Math.min(1, score / (score + CONCEPT_SCORE_SOFTNESS));
      if (!acceptedFeedback && (score < CONCEPT_MIN_SCORE || confidence < CONCEPT_CONFIDENCE_MIN)) {
        continue;
      }

      out.push({
        so: i,
        si: sectionIdx,
        sc: score,
        cf: confidence,
        st: entry.shared,
        link: makeLink(sec.section, sd, score, entry.shared, false),
      });
    }
    }
    return out;
  };

  // ── Per-file incremental dispatch ──
  // Concept scoring is per-symbol: a symbol's candidates depend only on its own weights plus
  // the section corpus and the workspace-wide token frequencies. That makes it a pure sum over
  // files, so only files whose bytes changed — or whose tokens overlap the changed tokens that
  // shift the DF cutoffs — have to be recomputed.
  const conceptCacheOn = docLinkCacheEnabled();
  const conceptStore = conceptCacheOn ? readConceptStore(index.rootDir) : undefined;
  const docFp = createHash("sha1").update(JSON.stringify(sections)).digest("hex");
  const feedbackFp = createHash("sha1").update(JSON.stringify(feedback)).digest("hex");
  const storeUsable =
    conceptStore !== undefined &&
    conceptStore.docFp === docFp &&
    conceptStore.feedbackFp === feedbackFp;

  const fileTokens = (start: number, count: number): string[] => {
    const out = new Set<string>();
    for (let i = 0; i < count; i++) {
      const sd = symbolData[start + i];
      if (!sd) continue;
      for (const token of sd.weights.keys()) out.add(token);
    }
    return [...out];
  };

  const conceptFiles: Record<string, ConceptFileRecord> = {};
  const recomputed = new Set<string>();
  const tokenDelta = new Set<string>();
  const stale: Array<(typeof fileRanges)[number]> = [];

  for (const range of fileRanges) {
    const rec = storeUsable ? conceptStore!.files[range.relFile] : undefined;
    if (rec && rec.hash === range.hash) {
      conceptFiles[range.relFile] = rec;
      continue;
    }
    stale.push(range);
  }

  for (const range of stale) {
    const cand = computeFileCandidates(range.start, range.count);
    const tokens = fileTokens(range.start, range.count);
    conceptFiles[range.relFile] = { hash: range.hash, tokens, cand };
    recomputed.add(range.relFile);
    // Both the old and the new token set are folded in: a token that vanished can flip the
    // DF-based eligibility test just as easily as one that appeared.
    for (const token of tokens) tokenDelta.add(token);
    const oldTokens = storeUsable ? conceptStore!.files[range.relFile]?.tokens ?? [] : [];
    for (const token of oldTokens) tokenDelta.add(token);
  }

  if (storeUsable && tokenDelta.size > 0) {
    for (const range of fileRanges) {
      if (recomputed.has(range.relFile)) continue;
      const rec = conceptFiles[range.relFile];
      if (!rec) continue;
      if (!rec.tokens.some((token) => tokenDelta.has(token))) continue;
      conceptFiles[range.relFile] = {
        hash: range.hash,
        tokens: rec.tokens,
        cand: computeFileCandidates(range.start, range.count),
      };
      recomputed.add(range.relFile);
    }
  }

  for (const range of fileRanges) {
    const rec = conceptFiles[range.relFile];
    if (!rec) continue;
    for (const c of rec.cand) {
      conceptCandidates.push({
        symbolIdx: range.start + c.so,
        sectionIdx: c.si,
        score: c.sc,
        confidence: c.cf,
        sharedTokens: c.st,
        link: c.link,
      });
    }
  }

  if (conceptCacheOn && (!storeUsable || recomputed.size > 0)) {
    writeConceptStore(index.rootDir, {
      version: CONCEPT_STORE_VERSION,
      docFp,
      feedbackFp,
      files: conceptFiles,
    });
  }

  kgStage(`doc: concept pass (recomputed=${recomputed.size}/${fileRanges.length})`);
  // ── 3. Reciprocal top-K pruning: a candidate must rank high on BOTH sides ──
  const candidatesBySymbol = new Map<number, ConceptCandidate[]>();
  const candidatesBySection = new Map<number, ConceptCandidate[]>();
  for (const candidate of conceptCandidates) {
    const bySymbol = candidatesBySymbol.get(candidate.symbolIdx);
    if (bySymbol) bySymbol.push(candidate);
    else candidatesBySymbol.set(candidate.symbolIdx, [candidate]);
    const bySection = candidatesBySection.get(candidate.sectionIdx);
    if (bySection) bySection.push(candidate);
    else candidatesBySection.set(candidate.sectionIdx, [candidate]);
  }

  const symbolTopSections = new Map<number, Set<number>>();
  for (const [symbolIdx, list] of candidatesBySymbol) {
    list.sort((a, b) => b.score - a.score || a.sectionIdx - b.sectionIdx);
    symbolTopSections.set(
      symbolIdx,
      new Set(list.slice(0, RECIPROCAL_SECTION_TOP_K).map((c) => c.sectionIdx))
    );
  }
  const sectionTopSymbols = new Map<number, Set<number>>();
  for (const [sectionIdx, list] of candidatesBySection) {
    list.sort((a, b) => b.score - a.score || a.symbolIdx - b.symbolIdx);
    sectionTopSymbols.set(
      sectionIdx,
      new Set(list.slice(0, RECIPROCAL_SECTION_TOP_K).map((c) => c.symbolIdx))
    );
  }

  // ── 4. Per-symbol margin pruning, then greedy max-weight matching with caps ──
  const reciprocalSurvivors: ConceptCandidate[] = [];
  for (const [symbolIdx, list] of candidatesBySymbol) {
    const mySections = symbolTopSections.get(symbolIdx) ?? new Set<number>();
    const survivors = list.filter(
      (candidate) =>
        mySections.has(candidate.sectionIdx) &&
        (sectionTopSymbols.get(candidate.sectionIdx)?.has(symbolIdx) ?? false)
    );
    if (survivors.length === 0) continue;
    const bestScore = survivors[0]!.score;
    const marginFloor = Math.max(CONCEPT_MIN_SCORE, bestScore * CONCEPT_MARGIN_RATIO);
    for (const candidate of survivors) {
      if (candidate.score < marginFloor) continue;
      if (candidate.confidence < CONCEPT_CONFIDENCE_MIN) continue;
      reciprocalSurvivors.push(candidate);
    }
  }
  reciprocalSurvivors.sort(
    (a, b) => b.score - a.score || docLinkSortKey(a.link).localeCompare(docLinkSortKey(b.link))
  );

  const acceptedLinks: DocCodeLink[] = [];
  const acceptedKeys = new Set<string>();
  const sectionLinkCounts = new Map<number, number>();
  const symbolLinkCounts = new Map<number, number>();
  const symbolConceptCounts = new Map<number, number>();

  const sortedExplicit = [...explicitEntries].sort(
    (a, b) =>
      b.link.score - a.link.score ||
      b.matchedKeyLength - a.matchedKeyLength ||
      docLinkSortKey(a.link).localeCompare(docLinkSortKey(b.link))
  );
  for (const entry of sortedExplicit) {
    const key = docLinkSortKey(entry.link);
    if (acceptedKeys.has(key)) continue;
    // Explicit refs are authoritative: they respect the per-section cap (and the global
    // cap applied at the end) but not the per-symbol cap. Otherwise a monorepo's own
    // EVAL/README mentions of `OrderService.timeout` fill the three symbol slots and the
    // section that actually defines the constant never links the method.
    if ((sectionLinkCounts.get(entry.sectionIdx) ?? 0) >= PER_SECTION_LINK_LIMIT) {
      continue;
    }
    acceptedKeys.add(key);
    acceptedLinks.push(entry.link);
    sectionLinkCounts.set(entry.sectionIdx, (sectionLinkCounts.get(entry.sectionIdx) ?? 0) + 1);
    symbolLinkCounts.set(entry.symbolIdx, (symbolLinkCounts.get(entry.symbolIdx) ?? 0) + 1);
  }

  for (const candidate of reciprocalSurvivors) {
    const key = docLinkSortKey(candidate.link);
    if (acceptedKeys.has(key)) continue;
    if ((sectionLinkCounts.get(candidate.sectionIdx) ?? 0) >= PER_SECTION_LINK_LIMIT) {
      continue;
    }
    if ((symbolLinkCounts.get(candidate.symbolIdx) ?? 0) >= PER_SYMBOL_LINK_LIMIT) {
      continue;
    }
    if ((symbolConceptCounts.get(candidate.symbolIdx) ?? 0) >= MAX_CONCEPT_LINKS_PER_SYMBOL) {
      continue;
    }
    acceptedKeys.add(key);
    acceptedLinks.push(candidate.link);
    sectionLinkCounts.set(
      candidate.sectionIdx,
      (sectionLinkCounts.get(candidate.sectionIdx) ?? 0) + 1
    );
    symbolLinkCounts.set(candidate.symbolIdx, (symbolLinkCounts.get(candidate.symbolIdx) ?? 0) + 1);
    symbolConceptCounts.set(
      candidate.symbolIdx,
      (symbolConceptCounts.get(candidate.symbolIdx) ?? 0) + 1
    );
  }

  acceptedLinks.sort(
    (a, b) =>
      b.score - a.score ||
      a.docPath.localeCompare(b.docPath) ||
      a.sectionTitle.localeCompare(b.sectionTitle) ||
      a.codeFile.localeCompare(b.codeFile) ||
      a.symbolName.localeCompare(b.symbolName)
  );
  const result = acceptedLinks.slice(0, resolveDocLinksGlobalCap());
  if (cacheEnabled) writeDocLinkCache(index.rootDir, cacheKey, result);
  return result;
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

  ensureGraphflowDir(rootDir);
  writeFileSync(briefFilePath(rootDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Normalizes a recorded activity file reference (`src/a.ts`, `src/a.ts#sym`, `src/a.ts:10-20`,
 * Windows separators) into a workspace-relative path, or `undefined` if the reference is not a
 * safe in-workspace path (absolute, `@brief`, traversal, ...).
 */
function normalizeBriefFileRef(rawRef: string): string | undefined {
  let ref = rawRef.trim();
  if (!ref || ref.startsWith("@")) return undefined;
  const hashIdx = ref.indexOf("#");
  if (hashIdx >= 0) ref = ref.slice(0, hashIdx);
  const rangeMatch = ref.match(/^(.*?):\d+(?:-\d+)?$/);
  if (rangeMatch) ref = rangeMatch[1] ?? "";
  ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!ref || ref === "." || ref === "..") return undefined;
  if (isAbsolute(ref) || /^[a-zA-Z]:/.test(ref)) return undefined;
  if (ref.split("/").includes("..")) return undefined;
  return ref;
}

/** True when a recorded activity file still exists as a file under the workspace root. */
function briefFileExists(rootDir: string, rawRef: string): boolean {
  const rel = normalizeBriefFileRef(rawRef);
  if (!rel) return false;
  const absPath = join(rootDir, rel);
  const relativeBack = relative(rootDir, absPath).replace(/\\/g, "/");
  if (!relativeBack || relativeBack.startsWith("..") || isAbsolute(relativeBack)) return false;
  try {
    return existsSync(absPath) && statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Drops stale handoff noise: recorded activities whose files were all deleted (e.g. leftovers
 * from an old 2.x checkout) are hidden, and each surviving activity only keeps file paths that
 * still exist under the current workspace root.
 */
function filterLiveBriefActivities(
  rootDir: string,
  activities: CrossAgentActivityEntry[]
): CrossAgentActivityEntry[] {
  const live: CrossAgentActivityEntry[] = [];
  for (const activity of activities) {
    const existingFiles = activity.files.filter((file) => briefFileExists(rootDir, file));
    // Activities without a file payload (e.g. `exec`) stay; file activities whose every
    // recorded path is gone are stale and must not be surfaced to the next agent.
    if (activity.files.length > 0 && existingFiles.length === 0) continue;
    live.push({ ...activity, files: existingFiles });
  }
  return live;
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

  const fileSet = index.getFileSet();
  for (const f of files) {
    const data = index.getFileAnalysis(f);
    if (!data) continue;
    // Resolve every specifier to a real workspace file, exactly like the `imports` graph edges:
    // a relative import is anchored at the importing file's directory, then probed with source
    // extensions and `/index.*`. Bare package names never resolve and therefore never count.
    // One importing file contributes at most one in-degree point per target (`imported by N file(s)`).
    const importedTargets = new Set<string>();
    for (const imp of data.ast.imports) {
      const resolved = resolveRelativeImportPath(index.rootDir, f, imp.module, fileSet);
      if (resolved && resolved !== f && fileSet.has(resolved)) importedTargets.add(resolved);
    }
    for (const target of importedTargets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const topHubs = [...inDegree.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);

  const briefState = loadCrossAgentBriefState(index.rootDir);
  const liveActivities = filterLiveBriefActivities(index.rootDir, briefState.recentActivities);
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

  if (liveActivities.length > 0) {
    lines.push("", "## 2. Recent Cross-Agent Working Set (Session Handoff)");
    for (const act of liveActivities.slice(-5).reverse()) {
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

/** Hard cap on generated edges so very large repos cannot explode the single-file HTML. */
const MAX_KNOWLEDGE_GRAPH_EDGES = 5000;

/**
 * Generic method/function names carry no type evidence on their own: `headers.get()`,
 * `changedState.has()`, `request()` and friends exist on native containers or third-party
 * packages that are not part of the workspace. When the receiver type is unknown, any binding
 * to a workspace symbol with such a name is a guess (one candidate is not proof either:
 * `response.headers.get()` would otherwise bind the only `get` in the repo). The edge is
 * dropped — a deterministic policy, not a `confidence` downgrade. A bare call to a function
 * declared in the same file is still deterministic and stays.
 * Module scope: the set is immutable and rebuilt per file inside a hot loop otherwise.
 */
const GENERIC_CALL_NAMES = new Set([
  "get", "set", "has", "run", "request", "send", "on", "emit", "toString", "valueOf",
  "add", "delete", "clear", "keys", "values", "entries", "forEach", "push", "pop",
  "then", "catch", "apply", "call", "bind", "test", "exec", "read", "write", "close",
  "open", "connect", "listen", "pipe", "next",
]);

// ============================================================================
// Incremental knowledge-graph construction
// ============================================================================

/**
 * Every node and edge in the graph is *owned* by exactly one workspace file:
 * `defines`/`imports`/`calls` by the file that declares / imports / calls, and doc links by
 * the code file they point at. Ownership turns the graph into a pure sum of per-file
 * contributions, which is what makes incremental rebuilds possible: editing one file only
 * requires rebuilding that file plus the files whose symbol resolution *queried* a name that
 * appeared or disappeared.
 */
interface KgFileContribution {
  nodes: KnowledgeGraphNode[];
  defines: KnowledgeGraphEdge[];
  imports: KnowledgeGraphEdge[];
  calls: KnowledgeGraphEdge[];
  /** Names this file declares. Drives reverse-dependency invalidation when it changes. */
  declaredNames: string[];
  /** Global names this file's resolution queried. Intersected with the delta to find dependents. */
  queriedNames: string[];
  /** True when some call site has a receiver, i.e. results depend on the class hierarchy. */
  hasReceiverCalls: boolean;
  /** `child -> parent` inheritance edges declared here (part of the global hierarchy). */
  parents: Array<[string, string]>;
  /** Import specifiers that could not be resolved to a workspace file. */
  unresolvedImports: string[];
}

interface KgBuildContext {
  index: ReturnType<typeof getWorkspaceAstIndex>;
  fileSet: ReadonlySet<string>;
  filesByStem: Map<string, string[]>;
  filesByDirName: Map<string, string[]>;
  symbolsByName: Map<string, KnowledgeGraphSymbolRef[]>;
  symbolsByFileAndName: Map<string, KnowledgeGraphSymbolRef[]>;
  classParents: Map<string, string>;
  /** Lazy shared semantic call resolver; `unavailable` short-circuits after the first failure. */
  semantic: { index?: ReturnType<typeof getSemanticIndex>; unavailable: boolean };
  receiverIndexes: Map<string, ReturnType<typeof inferReceiverTypeIndex>>;
  /** Per-file `child -> parent` declarations, used to detect hierarchy changes. */
  parentsByFile: Map<string, Array<[string, string]>>;
}

/**
 * On-disk graph cache. The fingerprint covers every input that can change the graph: source
 * files (path + size + mtimeMs), documentation files, tsconfig/jsconfig path aliases, the macro
 * store, doc-link feedback, and the two behaviour switches. A matching fingerprint lets `graph`
 * reuse the previously written HTML/JSON without re-parsing a single file.
 * `GRAPHFLOW_GRAPH_CACHE=0` disables both reads and writes.
 */
const KNOWLEDGE_GRAPH_CACHE_VERSION = 1;
const KNOWLEDGE_GRAPH_CACHE_REL_PATH = ".graphflow/knowledge-graph.cache.json";

interface KnowledgeGraphCacheMeta {
  version: number;
  fingerprint: string;
  nodeCount: number;
  edgeCount: number;
}

function knowledgeGraphCacheEnabled(): boolean {
  return process.env.GRAPHFLOW_GRAPH_CACHE !== "0";
}

function appendStatFingerprint(hash: ReturnType<typeof createHash>, rootDir: string, relPath: string): void {
  try {
    const st = statSync(join(rootDir, relPath));
    hash.update(`${relPath}\u0000${st.size}\u0000${st.mtimeMs}\n`);
  } catch {
    hash.update(`${relPath}\u0000missing\n`);
  }
}

function computeKnowledgeGraphFingerprint(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  docPaths: readonly string[]
): string {
  const hash = createHash("sha1");
  hash.update(`v${KNOWLEDGE_GRAPH_CACHE_VERSION}\n`);
  hash.update(`semantic=${process.env.GRAPHFLOW_KG_SEMANTIC ?? ""}\n`);
  hash.update(`doc-links-max=${process.env.GRAPHFLOW_DOC_LINKS_MAX ?? ""}\n`);
  for (const relPath of index.getFiles()) appendStatFingerprint(hash, index.rootDir, relPath);
  for (const relPath of [...docPaths].sort()) appendStatFingerprint(hash, index.rootDir, relPath);
  for (const relPath of [
    "tsconfig.json",
    "jsconfig.json",
    ".graphflow/macros.json",
    ".graphflow/doc-link-feedback.json",
  ]) {
    appendStatFingerprint(hash, index.rootDir, relPath);
  }
  return hash.digest("hex");
}

function readKnowledgeGraphCache(cachePath: string, fingerprint: string): KnowledgeGraphCacheMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<KnowledgeGraphCacheMeta>;
    if (
      parsed.version !== KNOWLEDGE_GRAPH_CACHE_VERSION ||
      parsed.fingerprint !== fingerprint ||
      typeof parsed.nodeCount !== "number" ||
      typeof parsed.edgeCount !== "number"
    ) {
      return undefined;
    }
    return {
      version: parsed.version,
      fingerprint: parsed.fingerprint,
      nodeCount: parsed.nodeCount,
      edgeCount: parsed.edgeCount,
    };
  } catch {
    return undefined;
  }
}

interface KnowledgeGraphFileData {
  relFile: string;
  ast: FileAstAnalysis;
  content: string;
}

interface KnowledgeGraphSymbolRef {
  id: string;
  file: string;
  name: string;
  line: number;
  endLine: number;
  parentClass?: string;
}

/** Symbol node ids include the owning class so two same-named methods do not collide. */
function knowledgeGraphSymbolId(
  file: string,
  name: string,
  parentClass?: string
): string {
  return `sym:${file}#${parentClass ? `${parentClass}.` : ""}${name}`;
}

function knowledgeGraphFileStem(relPath: string): string {
  return basename(relPath).replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * Narrow implicit (import-free) visibility per language family, mirroring
 * `inImplicitPackageScope` in `blast-radius.ts`. Kept local on purpose: `doc-graph` is
 * imported by `slicer`, and `blast-radius` imports `slicer`; a runtime import here would
 * create a module cycle for a tiny helper.
 */
function inKnowledgeGraphImplicitScope(
  targetFile: string,
  candidateFile: string,
  family: SourceLanguageFamily
): boolean {
  const sameDir = dirname(targetFile) === dirname(candidateFile);
  if (family === "go" || family === "csharp") return sameDir;
  if (family === "c") {
    return sameDir || knowledgeGraphFileStem(targetFile) === knowledgeGraphFileStem(candidateFile);
  }
  return false;
}

/** Enclosing callable symbol for a call line (innermost wins) for class-qualified caller ids. */
function findKnowledgeGraphCaller(
  ast: FileAstAnalysis,
  line: number
): FileAstAnalysis["symbols"][number] | undefined {
  let best: FileAstAnalysis["symbols"][number] | undefined;
  for (const sym of ast.symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    if (line >= sym.line && line <= sym.endLine) {
      if (!best || sym.endLine - sym.line < best.endLine - best.line) best = sym;
    }
  }
  return best;
}

// ============================================================================
// tsconfig.json / jsconfig.json path-alias resolution for file -> file import edges
// ============================================================================

interface KnowledgeGraphPathAliasConfig {
  /** Workspace-relative base directory ("" or "." means the workspace root). */
  baseUrl: string;
  paths: Array<{ pattern: string; replacements: string[] }>;
}

const KNOWLEDGE_GRAPH_ALIAS_CACHE = new Map<string, KnowledgeGraphPathAliasConfig | null>();
const KNOWLEDGE_GRAPH_JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** Strips `//` / `/* *\/` comments and trailing commas from JSONC (tsconfig/jsconfig). */
function stripJsoncText(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Trailing commas before `}` / `]` are legal JSONC but illegal JSON.
  return out.replace(/,\s*([}\]])/g, "$1");
}

function normalizeKnowledgeGraphRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

/**
 * Case-sensitive identifier-boundary test (`$`/`_` are identifier chars, so `\b` is not enough).
 * Used to dismiss doc<->code links whose target is only a normalization collision.
 */
function containsLiteralIdentifier(text: string, identifier: string): boolean {
  if (!text || !identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

/** Case-insensitive variant for doc prose that lowercases a receiver (`options.responseType`). */
function containsLiteralIdentifierCi(text: string, identifier: string): boolean {
  if (!text || !identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "i").test(text);
}

/** Resolves a workspace-relative module candidate to a known source file (ext/index fallbacks). */
function resolveKnownGraphCodeFile(
  candidate: string,
  fileSet: ReadonlySet<string>
): string | undefined {
  const normalized = normalizeKnowledgeGraphRelPath(candidate);
  if (!normalized) return undefined;
  const withoutJsExt = normalized.replace(/\.(?:js|jsx|mjs|cjs)$/i, "");
  const bases = withoutJsExt === normalized ? [normalized] : [normalized, withoutJsExt];
  const probes: string[] = [];
  for (const base of bases) {
    probes.push(base);
    if (!base) continue;
    for (const ext of KNOWLEDGE_GRAPH_JS_EXTS) probes.push(`${base}${ext}`);
    for (const ext of KNOWLEDGE_GRAPH_JS_EXTS) probes.push(`${base}/index${ext}`);
  }
  for (const probe of probes) {
    if (fileSet.has(probe)) return probe;
  }
  return undefined;
}

/** Reads (and caches) `compilerOptions.baseUrl` + `paths` from root tsconfig/jsonconfig. */
function readKnowledgeGraphPathAliases(
  rootDir: string
): KnowledgeGraphPathAliasConfig | null {
  const cached = KNOWLEDGE_GRAPH_ALIAS_CACHE.get(rootDir);
  if (cached !== undefined) return cached;

  const merged: KnowledgeGraphPathAliasConfig = { baseUrl: "", paths: [] };
  const seenPatterns = new Set<string>();
  let baseUrlSet = false;

  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = join(rootDir, configName);
    if (!existsSync(configPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsoncText(readFileSync(configPath, "utf8")));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const compilerOptions = (parsed as { compilerOptions?: unknown }).compilerOptions;
    if (!compilerOptions || typeof compilerOptions !== "object") continue;
    const options = compilerOptions as { baseUrl?: unknown; paths?: unknown };

    if (!baseUrlSet && typeof options.baseUrl === "string") {
      merged.baseUrl = normalizeKnowledgeGraphRelPath(options.baseUrl);
      baseUrlSet = true;
    }
    if (!options.paths || typeof options.paths !== "object" || Array.isArray(options.paths)) {
      continue;
    }
    for (const [pattern, replacements] of Object.entries(
      options.paths as Record<string, unknown>
    )) {
      if (seenPatterns.has(pattern) || !Array.isArray(replacements)) continue;
      const clean = replacements.filter(
        (replacement): replacement is string =>
          typeof replacement === "string" && replacement.length > 0
      );
      if (clean.length === 0) continue;
      seenPatterns.add(pattern);
      merged.paths.push({ pattern, replacements: clean });
    }
  }

  const result = merged.paths.length > 0 ? merged : null;
  KNOWLEDGE_GRAPH_ALIAS_CACHE.set(rootDir, result);
  return result;
}

/**
 * Resolves a tsconfig/jsconfig path alias (`@/model` -> `ts/model.ts`). Relative specifiers are
 * left to `resolveRelativeImportPath`; matching supports one `*` wildcard per pattern and
 * multiple fallback extensions / `/index.*` files.
 */
function resolveAliasImportToFile(
  rootDir: string,
  moduleSpec: string,
  fileSet: ReadonlySet<string>
): string | undefined {
  if (!moduleSpec || moduleSpec.startsWith(".")) return undefined;
  const config = readKnowledgeGraphPathAliases(rootDir);
  if (!config) return undefined;

  for (const entry of config.paths) {
    const starIndex = entry.pattern.indexOf("*");
    let captured: string;
    if (starIndex === -1) {
      if (moduleSpec !== entry.pattern) continue;
      captured = "";
    } else {
      const prefix = entry.pattern.slice(0, starIndex);
      const suffix = entry.pattern.slice(starIndex + 1);
      if (!moduleSpec.startsWith(prefix) || !moduleSpec.endsWith(suffix)) continue;
      if (moduleSpec.length < prefix.length + suffix.length) continue;
      captured = moduleSpec.slice(prefix.length, moduleSpec.length - suffix.length);
    }
    for (const replacement of entry.replacements) {
      const substituted = starIndex === -1 ? replacement : replacement.replace("*", captured);
      const withBaseUrl =
        config.baseUrl && config.baseUrl !== "." ? `${config.baseUrl}/${substituted}` : substituted;
      const resolved = resolveKnownGraphCodeFile(withBaseUrl, fileSet);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

// ============================================================================
// Persisted per-file shards
// ============================================================================

const GRAPH_SHARD_VERSION = 1;
const GRAPH_SHARD_REL = ".graphflow/graph-shards.json";

/**
 * Everything one file contributes, plus the metadata the next rebuild needs to decide whether
 * it has to be redone. `syms` is the key to cheap rebuilds: it carries enough of the symbol
 * table to rebuild the global name indexes without loading a single unchanged AST.
 */
interface KgShardRecord {
  /** `size:mtimeMs` staleness fingerprint. */
  fp: string;
  /** Declared symbols as `[name, line, endLine, parentClass?]`. */
  syms: Array<[string, number, number, string?]>;
  declaredNames: string[];
  queriedNames: string[];
  hasReceiverCalls: boolean;
  parents: Array<[string, string]>;
  unresolvedImports: string[];
  nodes: KnowledgeGraphNode[];
  defines: KnowledgeGraphEdge[];
  imports: KnowledgeGraphEdge[];
  calls: KnowledgeGraphEdge[];
}

interface KgShardManifest {
  version: number;
  signature: string;
  files: Record<string, KgShardRecord>;
}

interface KgRebuildPlan {
  ctx: KgBuildContext;
  orderedFiles: string[];
  /** Files whose contribution must be recomputed. */
  dirty: Set<string>;
  /** Parsed ASTs — only ever populated for dirty files. */
  fileData: Map<string, KnowledgeGraphFileData>;
  /** Reusable records for files that stayed clean. */
  records: Map<string, KgShardRecord>;
  manifest: KgShardManifest | undefined;
  rootDir: string;
  /** `size:mtime` per file, computed once and reused when the manifest is rewritten. */
  fpByFile: Map<string, string>;
}

function pushKgIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Builds the global lookup tables (name -> declarations, file stems, class hierarchy) that
 * per-file resolution reads from. This is the only still-O(N) part of a rebuild, and it is
 * cheap: it only walks already-parsed ASTs, never re-tokenizes.
 */
function buildKgContext(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  orderedFiles: string[],
  fileData: Map<string, KnowledgeGraphFileData>,
  records: Map<string, KgShardRecord>
): KgBuildContext {
  const ctx: KgBuildContext = {
    index,
    fileSet: index.getFileSet(),
    filesByStem: new Map(),
    filesByDirName: new Map(),
    symbolsByName: new Map(),
    symbolsByFileAndName: new Map(),
    classParents: new Map(),
    semantic: { unavailable: process.env.GRAPHFLOW_KG_SEMANTIC === "0" },
    receiverIndexes: new Map(),
    parentsByFile: new Map(),
  };
  for (const relFile of orderedFiles) {
    // Stems and directory names need only the path, never the file body.
    pushKgIndex(ctx.filesByStem, knowledgeGraphFileStem(relFile), relFile);
    const dirName = basename(dirname(relFile)).toLowerCase();
    if (dirName && dirName !== ".") pushKgIndex(ctx.filesByDirName, dirName, relFile);

    const data = fileData.get(relFile);
    if (data) {
      for (const sym of data.ast.symbols) {
        const ref: KnowledgeGraphSymbolRef = {
          id: knowledgeGraphSymbolId(relFile, sym.name, sym.parentClass),
          file: relFile,
          name: sym.name,
          line: sym.line,
          endLine: sym.endLine,
          ...(sym.parentClass ? { parentClass: sym.parentClass } : {}),
        };
        pushKgIndex(ctx.symbolsByName, sym.name, ref);
        pushKgIndex(ctx.symbolsByFileAndName, `${relFile}\u0000${sym.name}`, ref);
      }
      // First declaration wins, matching the original single-pass hierarchy build.
      let parents: Array<[string, string]> | undefined;
      for (const [child, parent] of parseClassParents(relFile, data.content, data.ast)) {
        if (!ctx.classParents.has(child)) ctx.classParents.set(child, parent);
        (parents ??= []).push([child, parent]);
      }
      if (parents) ctx.parentsByFile.set(relFile, parents);
      continue;
    }

    // Unchanged file: rebuild its symbol refs from the persisted record. This is the step
    // that makes incremental rebuilds cheap — no AST is loaded at all.
    const rec = records.get(relFile);
    if (!rec) continue;
    for (const [name, line, endLine, parentClass] of rec.syms) {
      pushKgIndex(ctx.symbolsByName, name, {
        id: knowledgeGraphSymbolId(relFile, name, parentClass),
        file: relFile,
        name,
        line,
        endLine,
        ...(parentClass ? { parentClass } : {}),
      });
      pushKgIndex(ctx.symbolsByFileAndName, `${relFile}\u0000${name}`, {
        id: knowledgeGraphSymbolId(relFile, name, parentClass),
        file: relFile,
        name,
        line,
        endLine,
        ...(parentClass ? { parentClass } : {}),
      });
    }
    for (const [child, parent] of rec.parents) {
      if (!ctx.classParents.has(child)) ctx.classParents.set(child, parent);
    }
    ctx.parentsByFile.set(relFile, rec.parents);
  }
  return ctx;
}

/**
 * Computes everything one file contributes to the graph: its file/symbol nodes, `defines`,
 * `imports` and `calls` edges, plus the reverse-dependency metadata (`declaredNames`,
 * `queriedNames`) that tells a later rebuild whether this file must be redone.
 */
function buildFileCodeContribution(
  relFile: string,
  ast: FileAstAnalysis,
  content: string,
  ctx: KgBuildContext
): KgFileContribution {
  const nodes: KnowledgeGraphNode[] = [];
  const defines: KnowledgeGraphEdge[] = [];
  const imports: KnowledgeGraphEdge[] = [];
  const calls: KnowledgeGraphEdge[] = [];
  const declaredNames = new Set<string>();
  const queriedNames = new Set<string>();
  const unresolvedImports: string[] = [];
  let hasReceiverCalls = false;

  const langOrFormat = extname(relFile).replace(".", "") || "code";
  const family = sourceLanguageFamily(relFile);

  // ── File node, symbol nodes and `defines` edges ──
  nodes.push({
    id: `file:${relFile}`,
    label: relFile,
    kind: "file",
    langOrFormat,
    detail: `${ast.totalLines} lines, ${ast.symbols.length} symbols`,
  });
  for (const sym of ast.symbols) {
    const symId = knowledgeGraphSymbolId(relFile, sym.name, sym.parentClass);
    nodes.push({
      id: symId,
      label: `${sym.parentClass ? `${sym.parentClass}.` : ""}${sym.name} (${sym.kind})`,
      kind: "symbol",
      langOrFormat,
      detail: `${relFile}:${sym.line}-${sym.endLine} | ${sym.signature}`,
    });
    defines.push({ source: `file:${relFile}`, target: symId, kind: "defines", label: "defines" });
    declaredNames.add(sym.name);
    if (sym.parentClass) declaredNames.add(sym.parentClass);
  }

  // ── `imports` edges ──
  const resolveImportTarget = (moduleSpec: string, importedNames: string[]): string | undefined => {
    const resolved = resolveRelativeImportPath(ctx.index.rootDir, relFile, moduleSpec, ctx.fileSet);
    if (resolved && resolved !== relFile && ctx.fileSet.has(resolved)) return resolved;

    // tsconfig.json / jsconfig.json path aliases (TS/JS only), e.g. `@/model` -> ts/model.ts.
    if (family === "js") {
      const aliasResolved = resolveAliasImportToFile(ctx.index.rootDir, moduleSpec, ctx.fileSet);
      if (aliasResolved && aliasResolved !== relFile && ctx.fileSet.has(aliasResolved)) {
        return aliasResolved;
      }
    }

    // Fallback for package/namespace imports that the path resolver cannot map to a file
    // (Go package paths and C# `using` namespaces are not file paths).
    if (family !== "go" && family !== "csharp") return undefined;
    const moduleTail = moduleSpec.split(/[./:\\]/).filter(Boolean).pop()?.toLowerCase();
    const names = [
      moduleTail,
      ...importedNames.filter((name) => name && name !== "*").map((name) => name.toLowerCase()),
    ].filter((name): name is string => Boolean(name));
    const fromDir = dirname(relFile);
    for (const name of names) {
      const stemMatches = (ctx.filesByStem.get(name) ?? []).filter(
        (candidate) => candidate !== relFile && sourceLanguageFamily(candidate) === family
      );
      if (stemMatches.length > 0) {
        return stemMatches.find((candidate) => dirname(candidate) === fromDir) ?? stemMatches[0];
      }
      const dirMatches = (ctx.filesByDirName.get(name) ?? []).filter(
        (candidate) => candidate !== relFile && sourceLanguageFamily(candidate) === family
      );
      if (dirMatches.length > 0) return [...dirMatches].sort()[0];
    }
    return undefined;
  };

  for (const imp of ast.imports) {
    const targetFile = resolveImportTarget(imp.module, imp.importedNames);
    if (!targetFile) {
      // Remember the miss: a later added/deleted file may resolve it, which would change
      // this file's edges. Without the record such a file would never be invalidated.
      unresolvedImports.push(imp.module);
      continue;
    }
    imports.push({
      source: `file:${relFile}`,
      target: `file:${targetFile}`,
      kind: "imports",
      label: imp.raw,
    });
  }

  // ── `calls` edges ──
  const declaresMethodOnType = (typeName: string, methodName: string): boolean =>
    (ctx.symbolsByName.get(methodName) ?? []).some((ref) => ref.parentClass === typeName);
  /** A receiver typed `resolved` may dispatch to `targetClass.method` when it is the same class
   *  or a subclass with no override between them. Mirrors blast-radius's hierarchy. */
  const isCompatibleReceiver = (
    resolved: string,
    targetClass: string,
    methodName: string
  ): boolean => {
    if (resolved === targetClass) return true;
    if (!isSubclassOf(ctx.classParents, resolved, targetClass)) return false;
    let current: string | undefined = resolved;
    const seen = new Set<string>();
    while (current && current !== targetClass) {
      if (seen.has(current)) break;
      seen.add(current);
      if (declaresMethodOnType(current, methodName)) return false;
      current = ctx.classParents.get(current);
    }
    return current === targetClass;
  };

  const getReceiverIndex = (): ReturnType<typeof inferReceiverTypeIndex> => {
    const cached = ctx.receiverIndexes.get(relFile);
    if (cached) return cached;
    const inferred = inferReceiverTypeIndex(relFile, content, ast);
    ctx.receiverIndexes.set(relFile, inferred);
    return inferred;
  };

  const trySemanticCallTarget = (
    call: AstCallSite
  ): KnowledgeGraphSymbolRef | undefined => {
    if (ctx.semantic.unavailable) return undefined;
    try {
      ctx.semantic.index ??= getSemanticIndex(ctx.index.rootDir);
      const resolved = ctx.semantic.index.resolveCall(relFile, call);
      if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
      if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
      const refs =
        ctx.symbolsByFileAndName.get(`${resolved.targetFile}\u0000${resolved.targetSymbol}`) ?? [];
      if (refs.length === 0) return undefined;
      return (
        (resolved.parentClass
          ? refs.find((ref) => ref.parentClass === resolved.parentClass)
          : undefined) ??
        refs.find((ref) => ref.parentClass !== undefined) ??
        refs[0]
      );
    } catch {
      ctx.semantic.unavailable = true;
      return undefined;
    }
  };

  const importedNames = new Set<string>();
  for (const imp of ast.imports) {
    for (const name of imp.importedNames) {
      // Wildcard/namespace imports import nothing specific (C/C++ #include, Go package, ...).
      if (name && name !== "*") importedNames.add(name);
    }
  }
  const receiverIndex = getReceiverIndex();

  for (const call of ast.calls) {
    // Declaration headers (`bool Engine::cancel(int id);`) are never calls.
    if (call.isDeclaration) continue;
    queriedNames.add(call.callee);
    const candidates = ctx.symbolsByName.get(call.callee);
    if (!candidates || candidates.length === 0) continue;

    const sameFileCandidates = candidates.filter((candidate) => candidate.file === relFile);
    const crossFileCandidates = candidates.filter(
      (candidate) =>
        candidate.file !== relFile && sourceLanguageFamily(candidate.file) === family
    );

    // Caller symbol by line containment (innermost callable wins) -> class-qualified source id.
    const callerSym = findKnowledgeGraphCaller(ast, call.line);
    const callerRefs = callerSym
      ? (ctx.symbolsByFileAndName.get(`${relFile}\u0000${callerSym.name}`) ?? [])
      : [];
    const callerRef = callerSym
      ? (callerRefs.find(
          (ref) => ref.line === callerSym.line && ref.endLine === callerSym.endLine
        ) ?? callerRefs[0])
      : undefined;

    // Receiver-type inference (3.3.2): when the receiver's static type is known, ONLY a method
    // declared on that class may be the target. A foreign receiver is dropped, not guessed.
    const receiverType = call.receiver
      ? resolveReceiverType(call, ast, receiverIndex)
      : undefined;
    if (receiverType) {
      hasReceiverCalls = true;
      queriedNames.add(receiverType);
    }

    let target: KnowledgeGraphSymbolRef | undefined;
    if (GENERIC_CALL_NAMES.has(call.callee)) {
      const receiverTypeDeclared =
        receiverType !== undefined &&
        (ctx.symbolsByName.get(receiverType) ?? []).some((ref) => ref.parentClass === undefined);
      if (!receiverTypeDeclared) {
        const bareLocalFunction =
          !call.receiver &&
          sameFileCandidates.some((candidate) => candidate.parentClass === undefined);
        if (!bareLocalFunction) continue;
      }
    }
    // Ambiguous callee name: prefer the semantic index's namespace/import/inheritance-aware
    // resolution (e.g. `using Demo.Two;` must select two/Gadget.cs among two same-stem files).
    if (candidates.length > 1) {
      target = trySemanticCallTarget(call);
    }
    if (!target) {
      if (receiverType) {
        const typedCandidates = [...sameFileCandidates, ...crossFileCandidates].filter(
          (candidate) =>
            candidate.parentClass !== undefined &&
            isCompatibleReceiver(receiverType, candidate.parentClass, call.callee)
        );
        if (typedCandidates.length === 0) continue;
        target =
          typedCandidates.find((candidate) => candidate.file === relFile) ??
          typedCandidates.find(
            (candidate) => candidate.parentClass && importedNames.has(candidate.parentClass)
          ) ??
          typedCandidates[0];
      } else if (sameFileCandidates.length > 0) {
        // Unknown receiver: prefer the enclosing class, else deterministic declaration order.
        const callerParent = callerSym?.parentClass;
        target =
          (callerParent
            ? sameFileCandidates.find((candidate) => candidate.parentClass === callerParent)
            : undefined) ?? sameFileCandidates[0];
      } else {
        const importedMatches = crossFileCandidates.filter(
          (candidate) =>
            importedNames.has(candidate.name) ||
            (candidate.parentClass ? importedNames.has(candidate.parentClass) : false)
        );
        if (importedMatches.length > 0) {
          target =
            importedMatches.find(
              (candidate) =>
                candidate.parentClass !== undefined &&
                importedNames.has(candidate.parentClass)
            ) ?? importedMatches[0];
        } else {
          target = crossFileCandidates.find((candidate) =>
            inKnowledgeGraphImplicitScope(relFile, candidate.file, family)
          );
        }
      }
    }

    if (!target) continue;
    const sourceId = callerRef ? callerRef.id : `file:${relFile}`;
    const targetId = target.id;
    if (sourceId === targetId) continue;
    calls.push({
      source: sourceId,
      target: targetId,
      kind: "calls",
      label: call.member && call.receiver ? `${call.receiver}.${call.callee}()` : `${call.callee}()`,
    });
  }

  return {
    nodes,
    defines,
    imports,
    calls,
    declaredNames: [...declaredNames],
    queriedNames: [...queriedNames],
    hasReceiverCalls,
    parents: ctx.parentsByFile.get(relFile) ?? [],
    unresolvedImports,
  };
}

function kgShardEnabled(): boolean {
  return process.env.GRAPHFLOW_GRAPH_INCREMENTAL !== "0";
}

/** Stage timings, opt-in via `GRAPHFLOW_GRAPH_DEBUG=1`. */
const kgDebug = process.env.GRAPHFLOW_GRAPH_DEBUG === "1";
let kgMark = Date.now();
function kgStage(label: string): void {
  if (!kgDebug) return;
  const now = Date.now();
  process.stderr.write(`[graph] ${label}: ${now - kgMark} ms\n`);
  kgMark = now;
}

/** Everything that changes results without changing any file's bytes. */
function kgShardSignature(): string {
  return [
    `v${GRAPH_SHARD_VERSION}`,
    process.env.GRAPHFLOW_KG_SEMANTIC === "0" ? "sem0" : "sem1",
    process.env.GRAPHFLOW_TREE_SITTER ? `ts=${process.env.GRAPHFLOW_TREE_SITTER}` : "ts=auto",
  ].join("|");
}

/**
 * `size:mtimeMs` instead of a content hash: detecting staleness must not require reading the
 * file. mtime has 1s granularity on some filesystems, so a write inside the same second can be
 * missed — the fingerprint also carries the size, and a miss only costs one extra rebuild.
 */
function kgFileFingerprint(rootDir: string, relFile: string): string {
  try {
    const st = statSync(join(rootDir, relFile));
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

function readKgShardManifest(rootDir: string): KgShardManifest | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(rootDir, ...GRAPH_SHARD_REL.split("/")), "utf8")
    ) as KgShardManifest;
    if (raw?.version !== GRAPH_SHARD_VERSION) return undefined;
    if (typeof raw.files !== "object" || raw.files === null) return undefined;
    if (raw.signature !== kgShardSignature()) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function writeKgShardManifest(rootDir: string, manifest: KgShardManifest): void {
  try {
    const path = join(rootDir, ...GRAPH_SHARD_REL.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest), "utf8");
  } catch {
    // A cache that cannot be written is simply a cache that is never hit.
  }
}

function contributionToRecord(c: KgFileContribution, fp: string): KgShardRecord {
  return {
    fp,
    syms: [],
    declaredNames: c.declaredNames,
    queriedNames: c.queriedNames,
    hasReceiverCalls: c.hasReceiverCalls,
    parents: c.parents,
    unresolvedImports: c.unresolvedImports,
    nodes: c.nodes,
    defines: c.defines,
    imports: c.imports,
    calls: c.calls,
  };
}

/**
 * Decides which files must be recomputed.
 *
 * The algorithm has three layers, each strictly cheaper than the one below it:
 *  1. **Fingerprint** (`size:mtime`) — files whose bytes changed are dirty by definition.
 *  2. **Name delta** — a file's `calls` edges are resolved purely through `symbolsByName`
 *     lookups, so a file only needs redoing if a name it *queried* appeared or disappeared
 *     elsewhere. `queriedNames` is recorded per file, which turns "who depends on me" into a
 *     set intersection instead of a graph traversal over importers.
 *  3. **Structural delta** — inheritance (`parents`) and the file set itself change what an
 *     unresolved import or a receiver-typed call can bind to, so those invalidate the files
 *     that could be affected (`hasReceiverCalls`, `unresolvedImports`).
 */
function planKgRebuild(
  index: ReturnType<typeof getWorkspaceAstIndex>
): KgRebuildPlan {
  const rootDir = index.rootDir;
  const orderedFiles = index.getFiles();
  const fileSet = new Set(orderedFiles);
  const manifest = kgShardEnabled() ? readKgShardManifest(rootDir) : undefined;

  const dirty = new Set<string>();
  const fpByFile = new Map<string, string>();
  for (const relFile of orderedFiles) {
    fpByFile.set(relFile, kgFileFingerprint(rootDir, relFile));
  }
  if (!manifest) {
    for (const relFile of orderedFiles) dirty.add(relFile);
  } else {
    for (const relFile of orderedFiles) {
      const rec = manifest.files[relFile];
      if (!rec || rec.fp !== fpByFile.get(relFile)) dirty.add(relFile);
    }
  }

  const fileData = new Map<string, KnowledgeGraphFileData>();
  const loadFileData = (relFile: string): void => {
    if (fileData.has(relFile)) return;
    const data = index.getFileAnalysis(relFile);
    if (data) fileData.set(relFile, { relFile, ast: data.ast, content: data.content });
  };
  for (const relFile of dirty) loadFileData(relFile);

  // ── Layer 2 & 3: what changed in the *name space*, not just in the bytes ──
  const deltaNames = new Set<string>();
  let fileSetChanged = false;
  if (manifest) {
    for (const [relFile, rec] of Object.entries(manifest.files)) {
      if (!fileSet.has(relFile)) {
        fileSetChanged = true;
        for (const name of rec.declaredNames) deltaNames.add(name);
        // A deleted file also removes its inheritance declarations, which can change what a
        // receiver-typed call binds to elsewhere.
        for (const [child, parent] of rec.parents) {
          deltaNames.add(child);
          deltaNames.add(parent);
        }
        continue;
      }
      if (!dirty.has(relFile)) continue;
      // Conservative union of the old and new name sets: computing the true symmetric
      // difference would need the previous AST, and over-invalidating is always safe.
      for (const name of rec.declaredNames) deltaNames.add(name);
      const fresh = fileData.get(relFile);
      if (!fresh) continue;
      // `parseClassParents` returns a Map, so it must be spread before being compared with
      // the persisted array — `JSON.stringify` on a Map is always `{}`.
      const oldParents = JSON.stringify(rec.parents);
      const freshParents = JSON.stringify([...parseClassParents(relFile, fresh.content, fresh.ast)]);
      if (oldParents !== freshParents) {
        // Inheritance changed. Folding the class names into the name delta is far more precise
        // than "every file with a receiver-typed call": only files that actually resolved a
        // receiver against one of these classes are invalidated.
        for (const [child, parent] of rec.parents) {
          deltaNames.add(child);
          deltaNames.add(parent);
        }
        for (const [child, parent] of parseClassParents(relFile, fresh.content, fresh.ast)) {
          deltaNames.add(child);
          deltaNames.add(parent);
        }
      }
    }
    for (const relFile of orderedFiles) {
      if (!manifest.files[relFile]) fileSetChanged = true;
    }
  } else if (orderedFiles.length > 0) {
    fileSetChanged = true;
  }
  for (const relFile of dirty) {
    const fresh = fileData.get(relFile);
    if (!fresh) continue;
    for (const sym of fresh.ast.symbols) {
      deltaNames.add(sym.name);
      if (sym.parentClass) deltaNames.add(sym.parentClass);
    }
  }

  // ── Reverse-dependency sweep over the files that are still clean ──
  if (manifest && deltaNames.size > 0) {
    for (const relFile of orderedFiles) {
      if (dirty.has(relFile)) continue;
      const rec = manifest.files[relFile];
      if (!rec) continue;
      if (fileSetChanged && rec.unresolvedImports.length > 0) {
        dirty.add(relFile);
        continue;
      }
      for (const name of rec.queriedNames) {
        if (deltaNames.has(name)) {
          dirty.add(relFile);
          break;
        }
      }
    }
    for (const relFile of dirty) loadFileData(relFile);
  }

  const records = new Map<string, KgShardRecord>();
  if (manifest) {
    for (const relFile of orderedFiles) {
      const rec = manifest.files[relFile];
      if (rec && !dirty.has(relFile)) records.set(relFile, rec);
    }
  }

  kgStage(`plan (dirty=${dirty.size}/${orderedFiles.length}, deltaNames=${deltaNames.size}, fileSet=${fileSetChanged})`);
  const ctx = buildKgContext(index, orderedFiles, fileData, records);
  kgStage("context");
  return { ctx, orderedFiles, dirty, fileData, records, manifest, rootDir, fpByFile };
}

/** Recomputes the dirty files and replays everything else straight from the manifest. */
function executeKgRebuild(plan: KgRebuildPlan): Map<string, KgFileContribution> {
  const out = new Map<string, KgFileContribution>();
  const { ctx, orderedFiles, dirty, fileData, records } = plan;

  for (const relFile of orderedFiles) {
    if (!dirty.has(relFile)) {
      const rec = records.get(relFile);
      if (rec) {
        out.set(relFile, {
          nodes: rec.nodes,
          defines: rec.defines,
          imports: rec.imports,
          calls: rec.calls,
          declaredNames: rec.declaredNames,
          queriedNames: rec.queriedNames,
          hasReceiverCalls: rec.hasReceiverCalls,
          parents: rec.parents,
          unresolvedImports: rec.unresolvedImports,
        });
      }
      continue;
    }
    const data = fileData.get(relFile);
    if (!data) continue;
    out.set(relFile, buildFileCodeContribution(relFile, data.ast, data.content, ctx));
  }

  // Persist. Records for files that are gone are dropped automatically: the new manifest is
  // rebuilt from the current file list only.
  if (kgShardEnabled()) {
    const files: Record<string, KgShardRecord> = {};
    for (const relFile of orderedFiles) {
      const contribution = out.get(relFile);
      if (!contribution) continue;
      const fp = plan.fpByFile.get(relFile);
      if (!fp) continue;
      const rec = contributionToRecord(contribution, fp);
      // `syms` is what lets the next rebuild rebuild the symbol tables without an AST.
      const data = fileData.get(relFile);
      if (data) {
        rec.syms = data.ast.symbols.map(
          (sym) =>
            [
              sym.name,
              sym.line,
              sym.endLine,
              ...(sym.parentClass ? [sym.parentClass] : []),
            ] as [string, number, number, string?]
        );
      } else {
        rec.syms = records.get(relFile)?.syms ?? [];
      }
      files[relFile] = rec;
    }
    writeKgShardManifest(plan.rootDir, {
      version: GRAPH_SHARD_VERSION,
      signature: kgShardSignature(),
      files,
    });
  }

  return out;
}

export function buildKnowledgeGraphData(
  index: ReturnType<typeof getWorkspaceAstIndex>
): KnowledgeGraphData {
  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();

  const addNode = (node: KnowledgeGraphNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  // Endpoint existence is checked centrally: contributions can now be replayed from cache,
  // so a stale edge may point at a node that no longer exists (e.g. an import whose target
  // file was deleted). Previously each stage did this ad hoc.
  const addEdge = (edge: KnowledgeGraphEdge) => {
    if (edges.length >= MAX_KNOWLEDGE_GRAPH_EDGES) return;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  // ── 1-4. Per-file contributions: file/symbol nodes, `defines`, `imports`, `calls` ──
  // Every node and edge is owned by exactly one file, so the graph is the ordered sum of
  // per-file contributions. This is what makes incremental rebuilds possible: unchanged
  // ── 1-4. Per-file contributions: file/symbol nodes, `defines`, `imports`, `calls` ──
  // Every node and edge is owned by exactly one file, so the graph is the ordered sum of
  // per-file contributions. `planKgRebuild` decides which files actually need work; the rest
  // are replayed from the shard manifest without ever loading their AST.
  kgMark = Date.now();
  const plan = planKgRebuild(index);
  const contributions = executeKgRebuild(plan);
  kgStage(`contributions (dirty=${plan.dirty.size})`);
  const orderedFiles = plan.orderedFiles;

  // Merge pass 1: nodes. Ids are file-scoped, so dedup is a pure union and the order is
  // deterministic (index.getFiles() is sorted).
  for (const relFile of orderedFiles) {
    for (const node of contributions.get(relFile)?.nodes ?? []) addNode(node);
  }
  // Merge pass 2: edges, grouped by kind rather than by file. Grouping keeps the emission
  // order identical to the original single-pass builder, so the MAX edge cap truncates the
  // same way it always did.
  for (const kind of ["defines", "imports", "calls"] as const) {
    for (const relFile of orderedFiles) {
      for (const edge of contributions.get(relFile)?.[kind] ?? []) addEdge(edge);
    }
  }

  // ── 4b. Symbol lookups used by the doc-edge stage (kept here: they mirror pass 1) ──
  const symbolsByName = plan.ctx.symbolsByName;
  const symbolsByFileAndName = plan.ctx.symbolsByFileAndName;


  kgStage("merge 1-4");

  // ── 5. Doc nodes & Doc <-> Code edges ──
  const docSections = scanWorkspaceDocuments(index.rootDir);
  const docLinks = buildDocCodeLinks(index, docSections);
  const docSectionText = new Map<string, string>();
  for (const sec of docSections) {
    docSectionText.set(
      `${sec.docPath}#${sec.title}`,
      sec.text ?? `${sec.title}\n${sec.summary}`
    );
  }
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
    // A method link only carries its bare name; resolve to the real (class-qualified) id.
    const symRef = symbolsByFileAndName
      .get(`${link.codeFile}\u0000${link.symbolName}`)
      ?.find((ref) => ref.parentClass === undefined) ??
      symbolsByFileAndName.get(`${link.codeFile}\u0000${link.symbolName}`)?.[0];
    const symId = symRef?.id;
    if (symId && nodeIds.has(docId) && nodeIds.has(symId)) {
      // Explicit mentions are the authoritative doc<->code relation, but identifier-key
      // normalization is case-insensitive and punctuation-free, so `response` can match the
      // `Response` class and `options` can bind to an unrelated file's getter. Before emitting
      // the edge, require the target symbol's bare name to literally appear in THIS section
      // (case-sensitive, identifier boundary). Concept-only links are semantic by design and
      // stay confidence-scored instead of literal.
      if (link.reason.startsWith("explicit ref ")) {
        const sectionText = docSectionText.get(`${link.docPath}#${link.sectionTitle}`) ?? "";
        if (!containsLiteralIdentifier(sectionText, link.symbolName)) continue;
        // Same bare member name declared in several files (`options` on an example class vs
        // `Options.options`): a bare doc mention is not enough to pick one. Keep it only when the
        // section also names the qualified member (`options.responseType`) or the exact file.
        const parentClass = symRef?.parentClass;
        if (parentClass) {
          const declaringFiles = new Set(
            (symbolsByName.get(link.symbolName) ?? []).map((ref) => ref.file)
          );
          if (declaringFiles.size > 1) {
            const baseFile = link.codeFile.split("/").pop() ?? link.codeFile;
            const fileMentioned =
              sectionText.includes(link.codeFile) || sectionText.includes(baseFile);
            if (
              !fileMentioned &&
              !containsLiteralIdentifierCi(sectionText, `${parentClass}.${link.symbolName}`)
            ) {
              continue;
            }
          }
        }
      }
      addEdge({
        source: docId,
        target: symId,
        kind: "doc-links-code",
        label: link.reason,
      });
    }
  }

  kgStage("doc-links");

  // ── 6. Co-Edit edges & Macro nodes ──
  const store = loadMacroStore(index.rootDir);
  for (const ce of store.habits.coEdits) {
    if (nodeIds.has(`file:${ce.fileA}`) && nodeIds.has(`file:${ce.fileB}`)) {
      addEdge({
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
  const outDir = join(index.rootDir, ".graphflow");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "knowledge-graph.json");
  const htmlPath = join(outDir, "knowledge-graph.html");
  const cachePath = join(index.rootDir, ...KNOWLEDGE_GRAPH_CACHE_REL_PATH.split("/"));

  const cacheEnabled = knowledgeGraphCacheEnabled();
  const docPaths = cacheEnabled ? listWorkspaceDocumentPaths(index.rootDir) : [];
  const fingerprint = cacheEnabled
    ? computeKnowledgeGraphFingerprint(index, docPaths)
    : "";

  if (cacheEnabled) {
    const cached = readKnowledgeGraphCache(cachePath, fingerprint);
    // Only reuse when both artifacts still exist: callers (and tests) rely on the files.
    if (cached && existsSync(htmlPath) && existsSync(jsonPath)) {
      return {
        htmlPath,
        jsonPath,
        nodeCount: cached.nodeCount,
        edgeCount: cached.edgeCount,
      };
    }
  }

  const graph = buildKnowledgeGraphData(index);
  const edgeKindCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeKindCounts.set(edge.kind, (edgeKindCounts.get(edge.kind) ?? 0) + 1);
  }
  const edgeBreakdown = ["defines", "imports", "calls", "doc-links-code", "co-edit"]
    .map((kind) => `${kind}=${edgeKindCounts.get(kind) ?? 0}`)
    .join(" · ");

  // Serialize once: the same string feeds the self-contained HTML and the JSON artifact, so the
  // graph is never stringified twice. No pretty-printing keeps the on-disk JSON compact.
  const graphJson = JSON.stringify(graph);
  writeFileSync(jsonPath, graphJson, "utf8");
  if (cacheEnabled) {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: KNOWLEDGE_GRAPH_CACHE_VERSION,
        fingerprint,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      } satisfies KnowledgeGraphCacheMeta),
      "utf8"
    );
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>GraphFlow 3.7.0 — Interactive Project Knowledge Graph</title>
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
    --edge-defines: #6b7280;
    --edge-imports: #3b82f6;
    --edge-calls: #10b981;
    --edge-doc: #f59e0b;
    --edge-coedit: #ec4899;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  h1 { font-size: 16px; font-weight: 700; }
  .stats { font-size: 12px; color: var(--muted); }
  input[type="search"] { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: #030712; color: var(--text); font-size: 13px; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
  .legend-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; background: #1f2937; cursor: pointer; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .line { width: 14px; height: 2px; border-radius: 2px; display: inline-block; }
  #inspector { border-top: 1px solid var(--border); padding-top: 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; color: #d1d5db; }
  #canvas-wrap { flex: 1; position: relative; }
  canvas { width: 100%; height: 100%; display: block; cursor: grab; }
</style>
</head>
<body>
  <div id="sidebar">
    <h1>GraphFlow 3.7.0 Knowledge Graph</h1>
    <div class="stats">Nodes: ${graph.nodes.length} · Edges: ${graph.edges.length} (${edgeBreakdown})</div>
    <input id="search" type="search" placeholder="Search symbol, file, or doc (中文/EN)..." />
    <div class="legend-title">Nodes / 节点</div>
    <div class="legend">
      <span class="badge"><span class="dot" style="background:var(--file)"></span>Code File</span>
      <span class="badge"><span class="dot" style="background:var(--symbol)"></span>AST Symbol</span>
      <span class="badge"><span class="dot" style="background:var(--doc)"></span>Spec Doc (md/docx/xml/html/pdf)</span>
      <span class="badge"><span class="dot" style="background:var(--macro)"></span>Compiled Macro</span>
    </div>
    <div class="legend-title">Edges / 边</div>
    <div class="legend" id="edge-legend">
      <span class="badge"><span class="line" style="background:var(--edge-defines)"></span>defines (file → symbol)</span>
      <span class="badge"><span class="line" style="background:var(--edge-imports)"></span>imports (file → file)</span>
      <span class="badge"><span class="line" style="background:var(--edge-calls)"></span>calls (symbol → symbol)</span>
      <span class="badge"><span class="line" style="background:var(--edge-doc)"></span>doc-links-code</span>
      <span class="badge"><span class="line" style="background:var(--edge-coedit)"></span>co-edit</span>
    </div>
    <div id="inspector">Click any node on the canvas to inspect its signature, Blast Radius, and linked development documents.</div>
  </div>
  <div id="canvas-wrap"><canvas id="graph"></canvas></div>
<script>
const GRAPH = ${graphJson};
const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
const inspector = document.getElementById("inspector");
const searchInput = document.getElementById("search");
const COLORS = { file: "#3b82f6", symbol: "#10b981", doc: "#f59e0b", macro: "#a855f7" };
const EDGE_STYLES = {
  defines: { color: "#6b728099", width: 1 },
  imports: { color: "#3b82f6bb", width: 1.5 },
  calls: { color: "#10b981bb", width: 1.5 },
  "doc-links-code": { color: "#f59e0bbb", width: 2 },
  "co-edit": { color: "#ec4899bb", width: 1.5 },
};

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
      .map(ed => \`- [\${ed.kind}] \${ed.s === selected ? "→ " + ed.t.label : "→ " + ed.s.label} (\${ed.label || ""})\`);
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
    const style = EDGE_STYLES[ed.kind] || { color: "#37415188", width: 1 };
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
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
