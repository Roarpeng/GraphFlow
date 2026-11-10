/**
 * Chinese → English identifier recall above the L0 glossary.
 *
 * L0 stays in `tokenizer.ts` (pinyin, synonyms, engineering glossary).
 * L1 mines this repo: Chinese n-grams in comments and commit subjects are
 * paired with nearby identifier sub-tokens and scored by PMI. The map is
 * cached at `.graphflow/zh-identifier-map.json`.
 * L2 is the curated colloquial list in `zh-lexicon.ts`, optionally unioned
 * with a local ECDICT (MIT) file, then filtered to identifier tokens that
 * actually occur here.
 * L3 is an optional translator hook. It stays off unless
 * `GRAPHFLOW_ZH_EN_MODEL=1` and a host registered `registerZhEnModel`.
 * No model package is bundled.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_ZH_EN } from "./zh-lexicon.js";
import {
  CJK_ENGINEERING_GLOSSARY,
  segmentChinese,
  stemEnglishWord,
  tokenizeEnglish,
  type BilingualQueryPlan,
} from "./tokenizer.js";

export interface ZhEnModelTranslator {
  /** English identifier-like tokens for one Chinese span. Empty if unsure. */
  translate(text: string): readonly string[];
}

export interface ZhRecallSource {
  relPath: string;
  content: string;
}

export interface ZhRecallBundle {
  l1: ReadonlyMap<string, readonly string[]>;
  l2: ReadonlyMap<string, readonly string[]>;
  vocab: ReadonlySet<string>;
  windows: number;
  jsonBytes: number;
}

export interface CooccurWindow {
  zh: string[];
  en: string[];
}

const CACHE_VERSION = 1;
const TOP_K = 4;
const MAX_QUERY_TOKENS = 8;

/**
 * Above this share of windows a token is boilerplate for the whole corpus and
 * cannot discriminate between symbols. Only applied once the corpus is large
 * enough for the ratio to mean anything (`DF_MIN_WINDOWS`).
 */
const MAX_DF_RATIO = 0.08;
const DF_MIN_WINDOWS = 20;

/**
 * A Chinese key spread across a large share of windows ("数据", "中心", "信息")
 * is a filler word of code comments. PMI still gives it *some* English partner,
 * but expanding it just injects that neighbour's identifiers into every query.
 */
const MAX_ZH_DF_RATIO = 0.12;

const GLUE_TOKENS = new Set([
  "function", "export", "return", "const", "import", "from", "type", "interface", "class",
  "public", "private", "string", "boolean", "number", "void", "null", "true", "false",
  "this", "self", "async", "await", "new", "default", "readonly", "extends", "var", "let",
  "def", "func", "package", "struct", "data", "info", "item", "name", "value", "result",
  "input", "error", "test", "file", "code", "node", "line", "text", "list", "map", "set",
  "get", "read", "open", "start", "next", "post", "load", "run", "mark", "apply", "send",
  "hold", "clear", "store", "flag", "trace", "print", "update", "issue", "round", "convert",
  "enter", "emit", "enqueue", "stamp", "create", "sum", "split", "merge", "record", "assign",
  "schedule", "resolve", "prevent", "reserve", "redeem", "waive", "accept", "exchange",
  "pickup", "transfer", "verify", "normalize", "reverse", "close", "release", "report",
  "collect", "match", "build", "format", "parse", "order", "note", "path", "rule", "batch",
  "event", "lock", "scan", "deal", "sale", "fee", "qty", "job", "title", "count", "total",
  "status", "key", "doc", "hop", "sku", "lot", "bin", "row", "col", "len", "idx", "tmp",
  "args", "opts", "config", "context", "params", "fields", "field",
  // Python/Go/Rust boilerplate that a forward window picks up from every body.
  "pass", "none", "nil", "err", "mut", "pub", "use", "mod", "impl", "kwargs",
  "yield", "elif", "else", "try", "except", "raise", "todo", "fixme",
]);

let modelTranslator: ZhEnModelTranslator | undefined;
const memoryCache = new Map<string, { fingerprint: string; bundle: ZhRecallBundle }>();
let glossaryKeysLongest: string[] | undefined;

function glossaryKeys(): string[] {
  if (!glossaryKeysLongest) {
    glossaryKeysLongest = Object.keys(CJK_ENGINEERING_GLOSSARY).sort((a, b) => b.length - a.length);
  }
  return glossaryKeysLongest;
}

/** True when L0 already covers this Chinese span, so L1/L2 must not move it. */
export function isGlossaryCovered(key: string): boolean {
  if (key.length < 2) return true;
  if (CJK_ENGINEERING_GLOSSARY[key]) return true;
  for (const known of glossaryKeys()) {
    if (known.length >= 2 && key.includes(known)) return true;
  }
  return false;
}

export function registerZhEnModel(translator: ZhEnModelTranslator | undefined): void {
  modelTranslator = translator;
}

export function resetZhRecallCache(): void {
  memoryCache.clear();
}

export function zhKeysFromText(text: string): string[] {
  const keys = new Set<string>();
  const segmented = segmentChinese(text);
  for (const word of [...segmented.words, ...segmented.phrases]) {
    if (word.length >= 2 && word.length <= 12 && !isGlossaryCovered(word)) keys.add(word);
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,12}/g)) {
    const run = match[0] ?? "";
    if (run && !isGlossaryCovered(run)) keys.add(run);
  }
  return [...keys];
}

export function identifierTokens(text: string, limit = 12): string[] {
  const { words } = tokenizeEnglish(text);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || GLUE_TOKENS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * PMI over co-occurrence windows.
 * A pair that always travels together is kept even at support 1 (one docstring
 * or one commit subject). Pairs whose English token is shared across many
 * windows are kept only when PMI is high.
 */
export function mineZhIdentifierMap(windows: readonly CooccurWindow[]): Map<string, string[]> {
  const zCount = new Map<string, number>();
  const eCount = new Map<string, number>();
  const pair = new Map<string, number>();
  let total = 0;
  for (const window of windows) {
    const zh = [...new Set(window.zh)];
    const en = [...new Set(window.en)];
    if (zh.length === 0 || en.length === 0) continue;
    total += 1;
    for (const z of zh) zCount.set(z, (zCount.get(z) ?? 0) + 1);
    for (const e of en) eCount.set(e, (eCount.get(e) ?? 0) + 1);
    for (const z of zh) {
      for (const e of en) {
        const key = `${z}\0${e}`;
        pair.set(key, (pair.get(key) ?? 0) + 1);
      }
    }
  }
  const grouped = new Map<string, Array<{ en: string; pmi: number; support: number }>>();
  if (total === 0) return new Map();
  const dfActive = total >= DF_MIN_WINDOWS;
  for (const [key, support] of pair) {
    const splitAt = key.indexOf("\0");
    const z = key.slice(0, splitAt);
    const e = key.slice(splitAt + 1);
    const zc = zCount.get(z) ?? 0;
    const ec = eCount.get(e) ?? 0;
    if (zc === 0 || ec === 0) continue;
    // Corpus-wide boilerplate (`pass`, a package name, a shared prefix) travels
    // with every window, so it wins on support while telling us nothing.
    if (dfActive && ec / total > MAX_DF_RATIO) continue;
    if (dfActive && zc / total > MAX_ZH_DF_RATIO) continue;
    const pmi = Math.log2((support * total) / (zc * ec));
    const perfect = zc === support && ec === support;
    if (!perfect && support === 1 && ec > 1 && pmi < 2) continue;
    if (!perfect && pmi <= 0) continue;
    const list = grouped.get(z) ?? [];
    list.push({ en: e, pmi, support });
    grouped.set(z, list);
  }
  const out = new Map<string, string[]>();
  for (const [zh, list] of grouped) {
    list.sort((a, b) => b.pmi - a.pmi || b.support - a.support || a.en.localeCompare(b.en));
    out.set(zh, list.slice(0, TOP_K).map((item) => item.en));
  }
  return out;
}

/**
 * Identifier window around one Chinese line.
 *
 * Two lines back covers the `def`/`func` line that a Python docstring or a
 * trailing comment annotates; three lines forward covers the declaration plus a
 * Go signature continuation. Forward-only windows of eight lines used to pull
 * the whole function body (and the next declaration) into the pair, which is how
 * a comment ended up "meaning" its neighbour's identifiers.
 *
 * URLs are masked first: docstrings routinely cite the data source
 * (`https://vip.stock.finance.sina.com.cn/...`), and `vip`/`sina`/`finance`
 * would otherwise be mined as translations of whatever the comment says.
 */
function windowsFromContent(content: string): CooccurWindow[] {
  const lines = content.split(/\r?\n/);
  const out: CooccurWindow[] = [];
  for (let i = 0; i < lines.length && out.length < 400; i += 1) {
    const line = lines[i] ?? "";
    if (!/[\u4e00-\u9fff]/.test(line)) continue;
    const zh = zhKeysFromText(line);
    if (zh.length === 0) continue;
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length, i + 3);
    const slice = lines.slice(from, to).join("\n").replace(URL_PATTERN, " ");
    const en = identifierTokens(slice);
    if (en.length === 0) continue;
    out.push({ zh, en });
  }
  return out;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s"'`）)]+/g;

function gitText(rootDir: string, args: string[]): string {
  if (!existsSync(join(rootDir, ".git"))) return "";
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }) as string;
  } catch {
    return "";
  }
}

function commitSubjects(rootDir: string): string[] {
  const raw = gitText(rootDir, ["log", "-n", "120", "--pretty=%s"]);
  return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function collectVocab(files: readonly ZhRecallSource[], subjects: readonly string[]): Set<string> {
  const vocab = new Set<string>();
  for (const file of files) {
    for (const token of identifierTokens(file.content, 8000)) vocab.add(token);
  }
  for (const subject of subjects) {
    for (const token of identifierTokens(subject, 32)) vocab.add(token);
  }
  return vocab;
}

export function filterEcdictTranslations(text: string, vocab: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 4) continue;
    const english = (cols[0] ?? "").trim().toLowerCase();
    const translation = cols[3] ?? "";
    if (english.length < 3 || !vocab.has(english)) continue;
    const chinese = zhKeysFromText(translation).slice(0, 3);
    for (const zh of chinese) {
      const prev = out.get(zh) ?? [];
      if (!prev.includes(english) && prev.length < 4) {
        prev.push(english);
        out.set(zh, prev);
      }
    }
    if (out.size >= 8000) break;
  }
  return out;
}

function loadOptionalEcdict(rootDir: string, vocab: ReadonlySet<string>): Map<string, string[]> {
  const candidates = [process.env.GRAPHFLOW_ECDICT, join(rootDir, ".graphflow", "ecdict.csv")].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      return filterEcdictTranslations(text, vocab);
    } catch {
      return new Map();
    }
  }
  return new Map();
}

function filterCurated(vocab: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [zh, english] of Object.entries(CURATED_ZH_EN)) {
    if (isGlossaryCovered(zh)) continue;
    const kept = english
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && vocab.has(token));
    if (kept.length > 0) out.set(zh, kept.slice(0, 4));
  }
  return out;
}

function fingerprintOf(files: readonly ZhRecallSource[], head: string, subjects: readonly string[]): string {
  let hash = 5381;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) | 0;
  };
  mix(head);
  mix(String(files.length));
  for (const file of files) {
    mix(file.relPath);
    mix(String(file.content.length));
    mix(file.content);
  }
  for (const subject of subjects) mix(subject);
  return `${CACHE_VERSION}:${(hash >>> 0).toString(16)}:${files.length}:${subjects.length}`;
}

function bundleFromMaps(
  l1: Map<string, string[]>,
  l2: Map<string, string[]>,
  vocab: Set<string>,
  windows: number,
  jsonBytes: number
): ZhRecallBundle {
  return { l1, l2, vocab, windows, jsonBytes };
}

function readCache(path: string, fingerprint: string): ZhRecallBundle | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      fingerprint?: string;
      l1?: Array<{ zh: string; en: string[] }>;
      l2?: Array<{ zh: string; en: string[] }>;
      vocab?: string[];
      windows?: number;
    };
    if (parsed.version !== CACHE_VERSION || parsed.fingerprint !== fingerprint) return undefined;
    const l1 = new Map<string, string[]>();
    const l2 = new Map<string, string[]>();
    for (const row of parsed.l1 ?? []) l1.set(row.zh, row.en);
    for (const row of parsed.l2 ?? []) l2.set(row.zh, row.en);
    return bundleFromMaps(l1, l2, new Set(parsed.vocab ?? []), parsed.windows ?? 0, Buffer.byteLength(raw));
  } catch {
    return undefined;
  }
}

function writeCache(path: string, fingerprint: string, bundle: ZhRecallBundle): number {
  const payload = {
    version: CACHE_VERSION,
    fingerprint,
    windows: bundle.windows,
    l1: [...bundle.l1.entries()].map(([zh, en]) => ({ zh, en })),
    l2: [...bundle.l2.entries()].map(([zh, en]) => ({ zh, en })),
    vocab: [...bundle.vocab],
  };
  const text = JSON.stringify(payload);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  } catch {
    // Read-only workspace: the in-memory map still serves this process.
  }
  return Buffer.byteLength(text);
}

export function getZhRecallBundle(rootDir: string, files: readonly ZhRecallSource[]): ZhRecallBundle {
  const subjects = commitSubjects(rootDir);
  const head = gitText(rootDir, ["rev-parse", "HEAD"]).trim();
  const fingerprint = fingerprintOf(files, head, subjects);
  const cached = memoryCache.get(rootDir);
  if (cached && cached.fingerprint === fingerprint) return cached.bundle;
  const cachePath = join(rootDir, ".graphflow", "zh-identifier-map.json");
  const fromDisk = readCache(cachePath, fingerprint);
  if (fromDisk) {
    memoryCache.set(rootDir, { fingerprint, bundle: fromDisk });
    return fromDisk;
  }
  const windows: CooccurWindow[] = [];
  for (const file of files) windows.push(...windowsFromContent(file.content));
  for (const subject of subjects) {
    const zh = zhKeysFromText(subject);
    const en = identifierTokens(subject);
    if (zh.length > 0 && en.length > 0) windows.push({ zh, en });
  }
  const vocab = collectVocab(files, subjects);
  const l1 = mineZhIdentifierMap(windows);
  const l2 = filterCurated(vocab);
  for (const [zh, english] of loadOptionalEcdict(rootDir, vocab)) {
    if (l2.has(zh) || isGlossaryCovered(zh)) continue;
    l2.set(zh, english);
  }
  let bundle = bundleFromMaps(l1, l2, vocab, windows.length, 0);
  const jsonBytes = writeCache(cachePath, fingerprint, bundle);
  bundle = bundleFromMaps(l1, l2, vocab, windows.length, jsonBytes);
  memoryCache.set(rootDir, { fingerprint, bundle });
  return bundle;
}

function queryKeys(plan: BilingualQueryPlan): string[] {
  const keys = new Set<string>();
  for (const word of plan.chineseWords) keys.add(word);
  for (const phrase of plan.chinesePhrases) keys.add(phrase);
  for (const match of plan.normalizedQuery.matchAll(/[\u4e00-\u9fff]{2,12}/g)) {
    keys.add(match[0] ?? "");
  }
  return [...keys].filter((key) => key.length >= 2).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * English tokens for Chinese spans L0 does not already cover.
 * Capped so a colloquial query cannot flood the ranker.
 *
 * L1 only speaks when the query is *entirely* outside L0. Once the glossary
 * reads any part of it, the mined neighbours of the remaining span are guesswork
 * from arbitrary comment/identifier co-occurrence and measurably outvote the
 * glossary on real repositories (`scripts/zh-recall-bench.ts`). L2 (curated
 * colloquial) and L3 (explicit translator) stay available per key.
 */
export function expandUncoveredChinese(plan: BilingualQueryPlan, bundle: ZhRecallBundle): string[] {
  if (process.env.GRAPHFLOW_ZH_RECALL === "0") return [];
  const l2On = process.env.GRAPHFLOW_ZH_L2 !== "0";
  const modelOn = process.env.GRAPHFLOW_ZH_EN_MODEL === "1" && modelTranslator !== undefined;
  const keys = queryKeys(plan);
  const l1On = process.env.GRAPHFLOW_ZH_L1 !== "0" && !keys.some((key) => isGlossaryCovered(key));
  const seen = new Set(plan.englishWords.map((word) => word.toLowerCase()));
  const out: string[] = [];
  const push = (token: string) => {
    const lower = token.toLowerCase();
    if (lower.length < 3 || seen.has(lower) || GLUE_TOKENS.has(lower) || out.length >= MAX_QUERY_TOKENS) return;
    seen.add(lower);
    out.push(lower);
  };
  const uncovered: string[] = [];
  for (const key of keys) {
    if (isGlossaryCovered(key)) continue;
    uncovered.push(key);
    if (l1On) for (const token of bundle.l1.get(key) ?? []) push(token);
    if (l2On) for (const token of bundle.l2.get(key) ?? []) push(token);
  }
  if (modelOn && out.length < MAX_QUERY_TOKENS) {
    for (const key of uncovered) {
      if ((bundle.l1.has(key) && l1On) || (bundle.l2.has(key) && l2On)) continue;
      let translated: readonly string[] = [];
      try {
        translated = modelTranslator?.translate(key) ?? [];
      } catch {
        translated = [];
      }
      for (const token of translated) {
        const lower = token.toLowerCase();
        if (bundle.vocab.size > 0 && !bundle.vocab.has(lower) && !bundle.vocab.has(stemEnglishWord(lower))) continue;
        push(lower);
      }
    }
  }
  return out;
}
