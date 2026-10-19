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
export function buildDocCodeLinks(
  index: ReturnType<typeof getWorkspaceAstIndex>,
  docSections?: DocSection[]
): DocCodeLink[] {
  const sections = docSections ?? scanWorkspaceDocuments(index.rootDir);
  if (sections.length === 0) return [];

  const sectionData = sections.map(buildSectionRetrievalData);
  const symbolData: SymbolRetrievalData[] = [];
  for (const relFile of index.getFiles()) {
    const fileData = index.getFileAnalysis(relFile);
    if (!fileData) continue;
    for (const sym of fileData.ast.symbols) {
      symbolData.push(buildSymbolRetrievalData(relFile, fileData.ast, fileData.content, sym));
    }
  }
  if (symbolData.length === 0) return [];

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

  for (let symbolIdx = 0; symbolIdx < symbolData.length; symbolIdx++) {
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

      conceptCandidates.push({
        symbolIdx,
        sectionIdx,
        score,
        confidence,
        sharedTokens: entry.shared,
        link: makeLink(sec.section, sd, score, entry.shared, false),
      });
    }
  }

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
  return acceptedLinks.slice(0, resolveDocLinksGlobalCap());
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

  for (const f of files) {
    const data = index.getFileAnalysis(f);
    if (!data) continue;
    for (const imp of data.ast.imports) {
      // Strip the extension from the import specifier's last path segment (handles
      // "./order.ts", "./order.js" and bare "./order"); directory forms (".", "..",
      // "./orders/") yield an empty/"."/".." segment and are skipped.
      const impLast = (imp.module.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
      if (!impLast || impLast === "." || impLast === "..") continue;
      for (const candidate of files) {
        const candLast = candidate.replace(/\.[^.]+$/, "").split("/").pop() ?? "";
        if (impLast === candLast) {
          inDegree.set(candidate, (inDegree.get(candidate) ?? 0) + 1);
        }
      }
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

  const addEdge = (edge: KnowledgeGraphEdge) => {
    if (edges.length >= MAX_KNOWLEDGE_GRAPH_EDGES) return;
    const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  // ── 1. File nodes, symbol nodes and explicit `defines` edges ──
  const files = index.getFiles();
  const fileDataList: KnowledgeGraphFileData[] = [];
  for (const relFile of files) {
    const data = index.getFileAnalysis(relFile);
    if (data) fileDataList.push({ relFile, ast: data.ast, content: data.content });
  }

  for (const { relFile, ast } of fileDataList) {
    addNode({
      id: `file:${relFile}`,
      label: relFile,
      kind: "file",
      langOrFormat: extname(relFile).replace(".", "") || "code",
      detail: `${ast.totalLines} lines, ${ast.symbols.length} symbols`,
    });

    for (const sym of ast.symbols) {
      const symId = knowledgeGraphSymbolId(relFile, sym.name, sym.parentClass);
      addNode({
        id: symId,
        label: `${sym.parentClass ? `${sym.parentClass}.` : ""}${sym.name} (${sym.kind})`,
        kind: "symbol",
        langOrFormat: extname(relFile).replace(".", "") || "code",
        detail: `${relFile}:${sym.line}-${sym.endLine} | ${sym.signature}`,
      });
      addEdge({
        source: `file:${relFile}`,
        target: symId,
        kind: "defines",
        label: "defines",
      });
    }
  }

  // ── 2. Symbol index (name -> declarations) + per-file stem indexes for package imports ──
  const symbolsByName = new Map<string, KnowledgeGraphSymbolRef[]>();
  const symbolsByFileAndName = new Map<string, KnowledgeGraphSymbolRef[]>();
  const filesByStem = new Map<string, string[]>();
  const filesByDirName = new Map<string, string[]>();

  for (const { relFile, ast } of fileDataList) {
    for (const sym of ast.symbols) {
      const ref: KnowledgeGraphSymbolRef = {
        id: knowledgeGraphSymbolId(relFile, sym.name, sym.parentClass),
        file: relFile,
        name: sym.name,
        line: sym.line,
        endLine: sym.endLine,
        ...(sym.parentClass ? { parentClass: sym.parentClass } : {}),
      };
      const bucket = symbolsByName.get(sym.name);
      if (bucket) bucket.push(ref);
      else symbolsByName.set(sym.name, [ref]);
      const fileKey = `${relFile}\u0000${sym.name}`;
      const fileBucket = symbolsByFileAndName.get(fileKey);
      if (fileBucket) fileBucket.push(ref);
      else symbolsByFileAndName.set(fileKey, [ref]);
    }

    const stem = knowledgeGraphFileStem(relFile);
    const stemBucket = filesByStem.get(stem);
    if (stemBucket) stemBucket.push(relFile);
    else filesByStem.set(stem, [relFile]);

    const dirName = basename(dirname(relFile)).toLowerCase();
    if (dirName && dirName !== ".") {
      const dirBucket = filesByDirName.get(dirName);
      if (dirBucket) dirBucket.push(relFile);
      else filesByDirName.set(dirName, [relFile]);
    }
  }

  // ── 3. File -> file `imports` edges (best-effort resolution for all supported languages) ──
  const fileSet = index.getFileSet();
  const resolveImportTarget = (fromRelFile: string, moduleSpec: string, importedNames: string[]): string | undefined => {
    const resolved = resolveRelativeImportPath(index.rootDir, fromRelFile, moduleSpec, fileSet);
    if (resolved && resolved !== fromRelFile && nodeIds.has(`file:${resolved}`)) return resolved;

    const family = sourceLanguageFamily(fromRelFile);

    // tsconfig.json / jsconfig.json path aliases (TS/JS only), e.g. `@/model` -> ts/model.ts.
    if (family === "js") {
      const aliasResolved = resolveAliasImportToFile(index.rootDir, moduleSpec, fileSet);
      if (
        aliasResolved &&
        aliasResolved !== fromRelFile &&
        nodeIds.has(`file:${aliasResolved}`)
      ) {
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
    const fromDir = dirname(fromRelFile);
    for (const name of names) {
      const stemMatches = (filesByStem.get(name) ?? []).filter(
        (candidate) =>
          candidate !== fromRelFile && sourceLanguageFamily(candidate) === family
      );
      if (stemMatches.length > 0) {
        return (
          stemMatches.find((candidate) => dirname(candidate) === fromDir) ?? stemMatches[0]
        );
      }
      const dirMatches = (filesByDirName.get(name) ?? []).filter(
        (candidate) =>
          candidate !== fromRelFile && sourceLanguageFamily(candidate) === family
      );
      if (dirMatches.length > 0) return [...dirMatches].sort()[0];
    }
    return undefined;
  };

  for (const { relFile, ast } of fileDataList) {
    for (const imp of ast.imports) {
      const targetFile = resolveImportTarget(relFile, imp.module, imp.importedNames);
      if (!targetFile) continue;
      addEdge({
        source: `file:${relFile}`,
        target: `file:${targetFile}`,
        kind: "imports",
        label: imp.raw,
      });
    }
  }

  // ── 4. Symbol -> symbol `calls` edges (receiver-type aware: known receiver -> exact class,
  //       then same-file -> explicit import -> narrow package scope for unknown receivers) ──
  // Local inheritance map (doc-graph must not import blast-radius/slicer at runtime: that
  // would create a module cycle; ast-engine's parseClassParents is cycle-free).
  const classParents = new Map<string, string>();
  for (const { relFile, ast, content } of fileDataList) {
    for (const [child, parent] of parseClassParents(relFile, content, ast)) {
      if (!classParents.has(child)) classParents.set(child, parent);
    }
  }
  const declaresMethodOnType = (typeName: string, methodName: string): boolean =>
    (symbolsByName.get(methodName) ?? []).some((ref) => ref.parentClass === typeName);
  /** A receiver typed `resolved` may dispatch to `targetClass.method` when it is the same
   *  class or a subclass with no override between them. Mirrors blast-radius's hierarchy. */
  const isCompatibleReceiver = (
    resolved: string,
    targetClass: string,
    methodName: string
  ): boolean => {
    if (resolved === targetClass) return true;
    if (!isSubclassOf(classParents, resolved, targetClass)) return false;
    let current: string | undefined = resolved;
    const seen = new Set<string>();
    while (current && current !== targetClass) {
      if (seen.has(current)) break;
      seen.add(current);
      if (declaresMethodOnType(current, methodName)) return false;
      current = classParents.get(current);
    }
    return current === targetClass;
  };

  const receiverIndexCache = new Map<string, ReturnType<typeof inferReceiverTypeIndex>>();
  const getReceiverIndex = (
    relFile: string,
    ast: FileAstAnalysis,
    content: string
  ): ReturnType<typeof inferReceiverTypeIndex> => {
    const cached = receiverIndexCache.get(relFile);
    if (cached) return cached;
    const inferred = inferReceiverTypeIndex(relFile, content, ast);
    receiverIndexCache.set(relFile, inferred);
    return inferred;
  };

  // Lazy semantic-index preference for ambiguous callees: the same class name can be declared in
  // two C# namespaces (`Demo.One.Gadget` / `Demo.Two.Gadget`), where a name/import heuristic cannot
  // tell which file to use. Building the index is deferred to the first ambiguous call and falls
  // back silently to the local heuristics when the semantic index is unavailable.
  // `GRAPHFLOW_KG_SEMANTIC=0` disables the lookup (diagnostics/perf fallback).
  const useSemanticCalls = process.env.GRAPHFLOW_KG_SEMANTIC !== "0";
  let semanticIndex: ReturnType<typeof getSemanticIndex> | undefined;
  let semanticIndexUnavailable = false;
  const trySemanticCallTarget = (
    relFile: string,
    call: AstCallSite
  ): KnowledgeGraphSymbolRef | undefined => {
    if (semanticIndexUnavailable || !useSemanticCalls) return undefined;
    try {
      semanticIndex ??= getSemanticIndex(index.rootDir);
      const resolved = semanticIndex.resolveCall(relFile, call);
      if (!resolved.targetFile || !resolved.targetSymbol) return undefined;
      if (resolved.confidence < SEMANTIC_CONFIDENCE_MIN) return undefined;
      const refs =
        symbolsByFileAndName.get(`${resolved.targetFile}\u0000${resolved.targetSymbol}`) ?? [];
      if (refs.length === 0) return undefined;
      return (
        (resolved.parentClass
          ? refs.find((ref) => ref.parentClass === resolved.parentClass)
          : undefined) ??
        refs.find((ref) => ref.parentClass !== undefined) ??
        refs[0]
      );
    } catch {
      semanticIndexUnavailable = true;
      return undefined;
    }
  };

  for (const { relFile, ast, content } of fileDataList) {
    const family = sourceLanguageFamily(relFile);
    const importedNames = new Set<string>();
    for (const imp of ast.imports) {
      for (const name of imp.importedNames) {
        // Wildcard/namespace imports import nothing specific (C/C++ #include, Go package, ...).
        if (name && name !== "*") importedNames.add(name);
      }
    }
    const receiverIndex = getReceiverIndex(relFile, ast, content);

    for (const call of ast.calls) {
      // Declaration headers (`bool Engine::cancel(int id);`) are never calls.
      if (call.isDeclaration) continue;
      const candidates = symbolsByName.get(call.callee);
      if (!candidates || candidates.length === 0) continue;

      const sameFileCandidates = candidates.filter((candidate) => candidate.file === relFile);
      const crossFileCandidates = candidates.filter(
        (candidate) =>
          candidate.file !== relFile && sourceLanguageFamily(candidate.file) === family
      );

      // Caller symbol by line containment (innermost callable wins) -> class-qualified source id.
      const callerSym = findKnowledgeGraphCaller(ast, call.line);
      const callerRefs = callerSym
        ? (symbolsByFileAndName.get(`${relFile}\u0000${callerSym.name}`) ?? [])
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

      let target: KnowledgeGraphSymbolRef | undefined;
      // Ambiguous callee name: prefer the semantic index's namespace/import/inheritance-aware
      // resolution (e.g. `using Demo.Two;` must select two/Gadget.cs among two same-stem files).
      if (candidates.length > 1) {
        target = trySemanticCallTarget(relFile, call);
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
      const sourceId =
        callerRef && nodeIds.has(callerRef.id) ? callerRef.id : `file:${relFile}`;
      const targetId = target.id;
      if (!nodeIds.has(targetId) || sourceId === targetId) continue;
      addEdge({
        source: sourceId,
        target: targetId,
        kind: "calls",
        label:
          call.member && call.receiver ? `${call.receiver}.${call.callee}()` : `${call.callee}()`,
      });
    }
  }

  // ── 5. Doc nodes & Doc <-> Code edges ──
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
    // A method link only carries its bare name; resolve to the real (class-qualified) id.
    const symRef = symbolsByFileAndName
      .get(`${link.codeFile}\u0000${link.symbolName}`)
      ?.find((ref) => ref.parentClass === undefined) ??
      symbolsByFileAndName.get(`${link.codeFile}\u0000${link.symbolName}`)?.[0];
    const symId = symRef?.id;
    if (symId && nodeIds.has(docId) && nodeIds.has(symId)) {
      addEdge({
        source: docId,
        target: symId,
        kind: "doc-links-code",
        label: link.reason,
      });
    }
  }

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
  const graph = buildKnowledgeGraphData(index);
  const edgeKindCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeKindCounts.set(edge.kind, (edgeKindCounts.get(edge.kind) ?? 0) + 1);
  }
  const edgeBreakdown = ["defines", "imports", "calls", "doc-links-code", "co-edit"]
    .map((kind) => `${kind}=${edgeKindCounts.get(kind) ?? 0}`)
    .join(" · ");
  const outDir = join(index.rootDir, ".graphflow");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "knowledge-graph.json");
  const htmlPath = join(outDir, "knowledge-graph.html");
  writeFileSync(jsonPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

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
const GRAPH = ${JSON.stringify(graph)};
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
