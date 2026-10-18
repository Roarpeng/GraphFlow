/**
 * GraphFlow 3.3 — Multi-Language Surgical Code Analyzer
 *
 * Analysis backends (public description: TS/JS only uses a true AST; the rest are structural analyzers):
 *   1. TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) — true AST via `@babel/parser`
 *   2. Python (`.py`, `.pyi`) — indentation-scoped structural analyzer (regex + bracket/colon heuristics)
 *   3. Go (`.go`) — receiver/func/struct/interface structural analyzer (brace-scoped)
 *   4. Rust (`.rs`) — fn/impl/struct/enum/trait structural analyzer (brace-scoped)
 *   5. C / C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`, `.hxx`) — preprocessor/declaration structural analyzer
 *   6. C# (`.cs`) — namespace/class/interface/struct/method structural analyzer
 *
 * The non-TS/JS analyzers are heuristic structural scanners, not full language parsers: they
 * are fast and token-efficient, but comments/strings/macros and unusual formatting may reduce
 * precision. `syntaxErrors` for them is a conservative guard, not a complete grammar check.
 * An optional TRUE-AST backend for the 5 non-TS/JS languages is available via
 * `GRAPHFLOW_TREE_SITTER=1` (`src/tree-sitter-engine.ts`, tree-sitter + grammar packages are
 * optional dependencies); when it cannot load, the structural analyzers below are used.
 *
 * Extracts for all languages:
 *   - Symbols (`function`, `class`, `method`, `interface`, `struct`, `type`, `enum`, `variable`)
 *     with exact 1-based `line` and `endLine`, `signature`, `exported`, `paramsCount`,
 *     and `referencedTypes` (for automatic Cross-File Type-Closure Slicing).
 *   - Imports (`module`, `importedNames`, `line`, `endLine`)
 *   - Calls (`caller`, `callee`, `receiver`, `member`, `isDeclaration`, `line`, `argsCount`)
 *     for Blast-Radius Call-Site Slicing.
 *   - Syntax diagnostics (`syntaxErrors`) for zero-LLM static guard verification.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { analyzeWithTreeSitter, isTreeSitterAvailable } from "./tree-sitter-engine.js";

const requireFn = createRequire(__filename);

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "struct";

export type AstBackend =
  | "typescript"
  | "babel"
  | "python-ast"
  | "go-ast"
  | "rust-ast"
  | "cpp-ast"
  | "csharp-ast"
  | "structural";

export interface AstSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  line: number;            // 1-based inclusive start line
  endLine: number;         // 1-based inclusive end line
  bodyStartLine?: number;  // 1-based line where declaration body begins
  signature: string;       // Compact 1-line declaration header
  paramsCount?: number;
  returnType?: string;
  referencedTypes: string[]; // Custom type/struct/interface/class identifiers referenced
  fields?: string[];         // Struct/interface/dataclass/record member field names (v3.1 contract guard)
  parentClass?: string;
}

export interface AstImport {
  module: string;
  importedNames: string[];
  line: number;
  endLine: number;
  raw: string;
}

export interface AstCallSite {
  caller?: string;
  callee: string;
  line: number;
  argsCount: number;
  /** Identifier directly before the member-access operator (`service` in `service.cancel()`). */
  receiver?: string;
  /** True when reached through `.`, `->`, or `::` (member / associated call). */
  member?: boolean;
  /** True when the line is a declaration header (`bool Engine::cancel(int id);`), never an executable call. */
  isDeclaration?: boolean;
  /**
   * For chained calls such as `getService().cancel()`, the callee of the receiver call
   * (`getService`), used by the semantic index to infer a factory's return type.
   */
  receiverCall?: string;
}

/** Which analysis engine produced a `FileAstAnalysis`. */
export type AstEngine = "babel" | "tree-sitter" | "structural";

export interface FileAstAnalysis {
  relPath: string;
  totalLines: number;
  backend: AstBackend;
  symbols: AstSymbol[];
  imports: AstImport[];
  calls: AstCallSite[];
  syntaxErrors: Array<{ line: number; column?: number; message: string }>;
  /**
   * Which analysis engine produced this result (observability only):
   * `babel` = true TS/JS AST, `tree-sitter` = opt-in `GRAPHFLOW_TREE_SITTER=1` backend,
   * `structural` = the built-in heuristic analyzers.
   */
  engine?: AstEngine;
}

export const SUPPORTED_SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx",
  ".cs",
]);

/**
 * Coarse language family used to scope workspace-wide analyses (blast radius, rename safety).
 * Files from different families must never be matched against each other, even when
 * identifier names coincide (e.g. a Rust `cancel` vs a C++ `cancel` declaration).
 */
export type SourceLanguageFamily = "js" | "python" | "go" | "rust" | "c" | "csharp" | "other";

export function sourceLanguageFamily(relPath: string): SourceLanguageFamily {
  const ext = extname(relPath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "js";
  if (ext === ".py" || ext === ".pyi") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(ext)) return "c";
  if (ext === ".cs") return "csharp";
  return "other";
}

const BUILTIN_TYPES = new Set([
  // TS/JS
  "Array", "ReadonlyArray", "Promise", "Record", "Partial", "Required", "Readonly",
  "Pick", "Omit", "Exclude", "Extract", "NonNullable", "ReturnType", "Parameters",
  "InstanceType", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Error",
  "TypeError", "SyntaxError", "Buffer", "Uint8Array", "Float32Array", "Int32Array",
  "Object", "Function", "String", "Number", "Boolean", "Symbol", "BigInt",
  "AbortSignal", "AbortController", "NodeJS", "Iterable", "AsyncIterable", "Iterator",
  // Python typing
  "Optional", "Union", "List", "Dict", "Tuple", "Set", "FrozenSet", "Sequence",
  "Mapping", "MutableMapping", "Callable", "Any", "Literal", "Final", "ClassVar",
  "TypeVar", "Generic", "Protocol", "TypedDict", "NamedTuple", "Self", "None",
  "True", "False", "Exception", "ValueError", "RuntimeError", "KeyError", "BaseModel",
  // Rust std
  "Option", "Result", "Vec", "Box", "Rc", "Arc", "RefCell", "Mutex", "RwLock",
  "HashMap", "HashSet", "BTreeMap", "BTreeSet", "Cow", "Pin", "PhantomData",
  "Some", "Ok", "Err", "Default", "Clone", "Copy", "Debug", "Display", "Send", "Sync",
  // Go / C++ / C# common
  "Context", "WaitGroup", " Reader", "Writer", "Task", "IEnumerable", "IList",
  "IDictionary", "IReadOnlyList", "CancellationToken", "Action", "Func", "Guid",
  "DateTime", "TimeSpan", "Exception", "ArgumentException", "InvalidOperationException",
]);

const NON_CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "alignof",
  "typeof", "delete", "new", "throw", "case", "match", "loop", "where",
  "lock", "using", "fixed", "checked", "unchecked", "nameof", "default",
  "assert", "print", "println", "len", "cap", "make", "append", "copy",
  "panic", "recover", "close", "complex", "real", "imag", "require", "import",
  "super", "self", "this", "Some", "Ok", "Err", "Box", "Vec", "Arc", "Rc",
]);

function extractPascalCaseTypes(text: string, selfName?: string): string[] {
  const matches = text.match(/\b[A-Z][a-zA-Z0-9_]*\b/g) ?? [];
  const out = new Set<string>();
  for (const m of matches) {
    if (m === selfName) continue;
    if (BUILTIN_TYPES.has(m)) continue;
    if (/^[A-Z0-9_]+$/.test(m) && m.length > 2) continue; // CONSTANT_NAME
    if (m.length <= 1) continue; // generic T, K, V
    out.add(m);
  }
  return Array.from(out);
}


export function extractStructFields(rawBlock: string, ext: string): string[] {
  const allLines = rawBlock.split(/\r?\n/);
  const headerLine = allLines[0] ?? "";
  const lines = allLines.slice(1);
  const fields = new Set<string>();
  const cleanExt = ext.toLowerCase();

  // C# record primary constructor parameters: `public record UserDto(string Id, int MaxTokens)`
  if (cleanExt === ".cs" && /\brecord\b/.test(headerLine) && headerLine.includes("(")) {
    const parenMatch = headerLine.match(/\(([^)]+)\)/);
    if (parenMatch) {
      for (const part of parenMatch[1]!.split(",")) {
        const tokens = part.trim().split(/\s+/);
        const name = tokens[tokens.length - 1]?.replace(/[^a-zA-Z0-9_]/g, "");
        if (name && /^[a-zA-Z_]/.test(name)) fields.add(name);
      }
    }
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    if (trimmed === "}" || trimmed === "};") continue;

    if (cleanExt === ".py" || cleanExt === ".pyi") {
      // 1. Class-level type annotations (`@dataclass`, `TypedDict`, `BaseModel`)
      const annMatch = rawLine.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (annMatch && !["self", "cls", "def", "class", "return"].includes(annMatch[1]!)) {
        fields.add(annMatch[1]!);
      }
      // 2. Instance attributes in __init__ (`self.field_name = ...`)
      const selfMatch = trimmed.match(/^self\.([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^=]+)?=/);
      if (selfMatch) {
        fields.add(selfMatch[1]!);
      }
    } else if (cleanExt === ".go") {
      const m = rawLine.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+[a-zA-Z0-9_*[\].]+/);
      if (m && !["func", "type", "return", "var", "const"].includes(m[1]!)) {
        fields.add(m[1]!);
      }
    } else if (cleanExt === ".rs") {
      const m = rawLine.match(/^\s+(?:pub(?:\([^)]*\))?\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (m && m[1] !== "fn") fields.add(m[1]!);
    } else if (cleanExt === ".cs") {
      // Auto-properties (`public int MaxTokens { get; set; }`) OR public/internal fields (`public int MaxTokens;`)
      const propMatch = rawLine.match(/^\s+(?:public|internal|protected|readonly|required|\s)+[^\s()]+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\{|;|=)/);
      if (propMatch && !["class", "struct", "interface", "record", "void", "return"].includes(propMatch[1]!)) {
        fields.add(propMatch[1]!);
      }
    } else if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(cleanExt)) {
      if (trimmed.includes("(")) continue;
      const m = trimmed.match(/^(?:const\s+|mutable\s+)*[a-zA-Z_][a-zA-Z0-9_:<>,*&\s]*\s+\*?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=\s*[^;]+)?;/);
      if (m && !["public", "private", "protected", "return", "using", "typedef", "friend"].includes(m[1]!)) {
        fields.add(m[1]!);
      }
    } else {
      if (trimmed.includes("(") && !trimmed.includes(":")) continue;
      const m = trimmed.match(/^(?:readonly\s+|public\s+|private\s+|protected\s+)*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\??\s*:/);
      if (m) fields.add(m[1]!);
    }
  }
  return Array.from(fields);
}

function cleanSignatureHeader(lines: string[], startLine: number, endLine: number): string {
  const slice = lines.slice(startLine - 1, Math.min(endLine, startLine + 5));
  const joined = slice.join(" ").replace(/\s+/g, " ").trim();
  const braceIdx = joined.indexOf("{");
  if (braceIdx > 0) {
    return joined.slice(0, braceIdx).trim();
  }
  return joined.slice(0, 200);
}

function countTopLevelArgs(argText: string): number {
  const trimmed = argText.trim();
  if (!trimmed) return 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let commas = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    const prev = i > 0 ? trimmed[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) commas += 1;
    }
  }
  return commas + 1;
}

export function stripLineCommentsAndStrings(line: string, commentPrefix = "//"): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1] ?? "";
    const prev = i > 0 ? line[i - 1] : "";
    if (!inSingle && !inDouble) {
      if (commentPrefix === "//" && ch === "/" && next === "/") break;
      if (commentPrefix === "#" && ch === "#") break;
    }
    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
      out += " ";
      continue;
    }
    if (ch === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      out += " ";
      continue;
    }
    out += inSingle || inDouble ? " " : ch;
  }
  return out;
}

function extractCallReceiver(
  stripped: string,
  matchIdx: number
): { receiver?: string; member: boolean; receiverCall?: string } {
  let j = matchIdx - 1;
  while (j >= 0 && (stripped[j] === " " || stripped[j] === "\t")) j--;
  let isMember = false;
  if (j >= 1 && stripped[j] === ">" && stripped[j - 1] === "-") {
    isMember = true;
    j -= 2;
  } else if (j >= 1 && stripped[j] === ":" && stripped[j - 1] === ":") {
    isMember = true;
    j -= 2;
  } else if (j >= 0 && stripped[j] === ".") {
    isMember = true;
    j -= 1;
  }
  if (!isMember) return { member: false };
  while (j >= 0 && (stripped[j] === " " || stripped[j] === "\t")) j--;
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(stripped[j]!)) j--;
  const receiver = stripped.slice(j + 1, end).replace(/\s+/g, "");
  if (receiver) return { receiver, member: true };
  const prefix = stripped.slice(0, matchIdx);
  // Base-class calls: Python `super().method()` / `super(A, self).method()`, C# `base.Method()`.
  if (/\bsuper\s*\([^()]*\)\s*\.\s*$/.test(prefix)) return { receiver: "super", member: true };
  if (/\bsuper\s*\.\s*$/.test(prefix)) return { receiver: "super", member: true };
  if (/\bbase\s*\.\s*$/.test(prefix)) return { receiver: "base", member: true };
  // Chained factory call: `getService().method()` -> receiverCall `getService`.
  const chainMatch = prefix.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^()]*\)\s*\.\s*$/);
  if (chainMatch) return { member: true, receiverCall: chainMatch[1]! };
  return { member: true };
}

const C_FAMILY_STATEMENT_KEYWORDS = new Set([
  "return", "throw", "delete", "new", "co_return", "co_await", "co_yield", "if", "for",
  "while", "switch", "catch", "case", "else", "do", "goto", "using", "typedef", "namespace",
  "static_assert", "sizeof", "alignof", "typeid", "await", "yield", "with",
]);

/** Removes C-family attribute prefixes (`[[nodiscard]]`, `[Obsolete]`) and `template<...>`. */
function normalizeDeclarationCandidate(rawLine: string): string {
  return stripLineCommentsAndStrings(rawLine, "//")
    .trim()
    .replace(/^(?:\[\[[^\]]*\]\]\s*)+/, "")
    .replace(/^(?:\[[^[\]]*\]\s*)+/, "")
    .replace(/^template\s*<[^>]*>\s*/i, "")
    .trim();
}

/**
 * Detects a "pure" declaration line in C/C++/C# — a prototype/interface method that ends with `;`
 * and has no body, e.g. `bool Engine::cancel(int id);`. Such lines must never be counted as calls.
 */
export function isPureDeclarationLine(rawLine: string): boolean {
  const stripped = normalizeDeclarationCandidate(rawLine);
  if (!stripped.endsWith(";") || stripped.startsWith("#")) return false;
  const firstWord = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!firstWord || C_FAMILY_STATEMENT_KEYWORDS.has(firstWord)) return false;
  return /^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|inline|explicit|constexpr|extern|const|unsigned|signed|long|short|friend|typename|struct|class|enum|readonly|partial|sealed|new|operator)\s+)*[A-Za-z_][A-Za-z0-9_:<>,.*&\s?\[\]]*\s+(?:[A-Za-z_][A-Za-z0-9_]*::)?[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?;\s*$/.test(
    stripped
  );
}

/**
 * Detects the opening line of a declaration whose parameters span several physical lines,
 * e.g. `bool Engine::cancel(\n    int id);` — the header line itself must not be a call site.
 */
function isDeclarationHeaderStartLine(rawLine: string): boolean {
  const stripped = normalizeDeclarationCandidate(rawLine);
  if (!stripped || stripped.includes("{") || stripped.includes(";")) return false;
  if (stripped.startsWith("#")) return false;
  const firstWord = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!firstWord || C_FAMILY_STATEMENT_KEYWORDS.has(firstWord)) return false;
  const firstParen = stripped.indexOf("(");
  if (firstParen < 0) return false;
  const head = stripped.slice(0, firstParen).trim();
  if (!head.includes(" ")) return false;
  return /^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|inline|explicit|constexpr|extern|const|unsigned|signed|long|short|friend|typename|struct|class|enum|readonly|partial|sealed|new|operator)\s+)*[A-Za-z_][A-Za-z0-9_:<>,.*&\s?\[\]]*\s+(?:[A-Za-z_][A-Za-z0-9_]*::)?[A-Za-z_][A-Za-z0-9_]*$/.test(
    head
  );
}

/** Lines belonging to C/C++/C# prototypes (single-line or multi-line headers) are not call sites. */
function collectCFamilyDeclarationLines(lines: string[]): Set<number> {
  const declarationLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isPureDeclarationLine(line) || isDeclarationHeaderStartLine(line)) {
      declarationLines.add(i + 1);
      continue;
    }
    // Inline class bodies (`class Engine { public: bool cancel(int id); };`) hide a
    // prototype after `{`/`:`; mark the line when any brace segment is a declaration.
    if (line.includes("{")) {
      for (const segment of line.split(/[{}]/)) {
        if (segment.trim() && isPureDeclarationLine(segment)) {
          declarationLines.add(i + 1);
          break;
        }
      }
    }
  }
  return declarationLines;
}

function extractCallSitesFromLines(
  lines: string[],
  symbols: AstSymbol[],
  commentPrefix: "//" | "#" = "//",
  declarationLines?: ReadonlySet<number>
): AstCallSite[] {
  const calls: AstCallSite[] = [];
  const fnSymbols = symbols.filter((s) => s.kind === "function" || s.kind === "method");
  const declLines = new Set(fnSymbols.map((s) => s.line));

  const findEnclosingCaller = (lineNum: number): string | undefined => {
    let best: AstSymbol | undefined;
    for (const s of fnSymbols) {
      if (lineNum >= s.line && lineNum <= s.endLine) {
        if (!best || s.endLine - s.line < best.endLine - best.line) {
          best = s;
        }
      }
    }
    return best?.name;
  };

  const callRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const stripped = stripLineCommentsAndStrings(lines[i] ?? "", commentPrefix);
    if (!stripped.trim()) continue;
    const lineIsDeclaration = declarationLines?.has(lineNum) ?? false;

    for (const m of stripped.matchAll(callRe)) {
      const callee = m[1]!;
      if (NON_CALL_KEYWORDS.has(callee)) continue;
      const matchIdx = m.index ?? 0;

      // Skip the function declaration header itself (but not calls inside a one-line body).
      if (declLines.has(lineNum)) {
        const bodyOpen = stripped.indexOf("{");
        const isHeaderPart = bodyOpen < 0 || matchIdx < bodyOpen;
        const before = stripped.slice(0, matchIdx).trim();
        if (
          isHeaderPart &&
          /\b(def|func|fn|function|void|int|bool|string|auto|Task|public|private|protected|internal|static|async|virtual|override)\b/.test(
            before
          )
        ) {
          continue;
        }
      }

      // Find matching closing paren on this line (or estimate args)
      const openParenIdx = stripped.indexOf("(", matchIdx + callee.length);
      if (openParenIdx < 0) continue;
      // Ignore Rust macro invocations like `println!(...)`
      if (openParenIdx > 0 && stripped[openParenIdx - 1] === "!") continue;

      let depth = 0;
      let closeParenIdx = -1;
      for (let k = openParenIdx; k < stripped.length; k++) {
        if (stripped[k] === "(") depth += 1;
        else if (stripped[k] === ")") {
          depth -= 1;
          if (depth === 0) {
            closeParenIdx = k;
            break;
          }
        }
      }
      const argSlice =
        closeParenIdx > openParenIdx
          ? stripped.slice(openParenIdx + 1, closeParenIdx)
          : stripped.slice(openParenIdx + 1);
      const argsCount = countTopLevelArgs(argSlice);
      const caller = findEnclosingCaller(lineNum);
      const receiverInfo = extractCallReceiver(stripped, matchIdx);
      calls.push({
        ...(caller ? { caller } : {}),
        callee,
        line: lineNum,
        argsCount,
        ...(receiverInfo.receiver ? { receiver: receiverInfo.receiver } : {}),
        ...(receiverInfo.member ? { member: true } : {}),
        ...(receiverInfo.receiverCall ? { receiverCall: receiverInfo.receiverCall } : {}),
        ...(lineIsDeclaration ? { isDeclaration: true } : {}),
      });
    }
  }
  return calls;
}

// ── Lightweight Receiver-Type Inference (regex/line-based; NO full type checker) ──
//
// Method call sites only carry a receiver *name* (`service` in `service.cancel()`), not a
// static type. To stop attributing `b.cancel()` to `A.cancel` just because A and B share a
// method name, we infer a best-effort local map receiver -> declared type from the same file:
//   - TS/JS:    `const x = new Class()`, `let x: Class`, class fields `x: Class`,
//               parameter annotations `x: Class` (from symbol signatures).
//   - Python:   `x = Class()`, `x: Class`, `self.field = Class()`, parameter annotations.
//   - Go:       `var x Type`, `x := Type{}`, `x *Type` parameters, method receivers.
//   - Rust:     `let x: Type`, `let x = Type::new()/Type{..}`, `x: &Type` parameters.
//   - C/C++:    `Type x;`, `Type* x`, `Type& x`, `const Type& x`; `auto x = new Type()`/`Type{}`.
//   - C#:       `var x = new Type()`, `Type x`, `new Type()` parameters.
// Resolution also understands `this`/`self`/`cls`/`Self`, `super`/`base`, static receivers
// (`Class.method`, `Class::method`), inheritance parent maps (`class B extends A`, ...),
// flow-insensitive last-assignment-wins within a block (different blocks with different
// types stay unknown), and generic/nullable/array wrapper unwrapping (`Box<Order>` -> Order).
// Nothing here is type-checked: macros, factory returns, generics with multiple arguments,
// and dynamic receivers stay unknown; unknown receivers fall back to the importer heuristic.

/** Kinds that can appear to the left of a member call as a static/associated receiver. */
function isTypeDefinitionSymbol(sym: AstSymbol): boolean {
  return (
    sym.kind === "class" ||
    sym.kind === "struct" ||
    sym.kind === "interface" ||
    sym.kind === "type" ||
    sym.kind === "enum"
  );
}

/** One inferred assignment to a local/module variable (flow-insensitive last-assignment heuristic). */
export interface ReceiverTypeAssignment {
  line: number;
  /** Inferred type, or undefined when the assignment erased the previous inference. */
  type?: string;
  /** Innermost block opener line; differing block ids mean a possible branch conflict. */
  block: number;
}

/**
 * Best-effort receiver-name -> type data for one file.
 * `byScope` is keyed `"<enclosingCallableLine>#receiver"` (line 0 = module level),
 * `byClass` is keyed `"<className>#field"` (class fields / constructor parameter properties),
 * `byName` is a flat last-write-wins fallback, and `assignments` retains per-scope assignment
 * history for last-assignment-wins / branch-conflict handling.
 */
export interface ReceiverTypeIndex {
  byScope: Map<string, string>;
  byClass: Map<string, string>;
  byName: Map<string, string>;
  /** `class -> declared base class` pairs parsed from this file (for `super`/inheritance). */
  parents?: Map<string, string>;
  /** Per-scope assignment history used for last-assignment-wins / branch-conflict detection. */
  assignments?: Map<string, ReceiverTypeAssignment[]>;
}

interface ReceiverTypePattern {
  re: RegExp;
  nameGroup: number;
  typeGroup: number;
}

// Generic/nullable/array annotation expression, e.g. `Box<Order>`, `Order | null`, `Order[]`.
const TS_TYPE_EXPR = String.raw`[A-Za-z_$][\w$.]*(?:\s*<[^<>;=,)]*>)?(?:\s*\[\s*\])*`;
const CS_TYPE_EXPR = String.raw`[A-Z]\w*(?:<[^<>]*>)?(?:\s*\[\s*\])*`;
const RUST_TYPE_EXPR = String.raw`[A-Za-z_]\w*(?:<[^<>;=,)]*>)?`;

// TS/JS local declarations, class fields, generic `new` assignments, parameter annotations.
const TS_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*(${TS_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`(?:^|[=(,;])\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`this\.([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`^\s*(?:(?:public|private|protected|readonly|static|declare)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*(${TS_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`[(,]\s*([A-Za-z_$][\w$]*)\s*\??\s*:\s*(${TS_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
];
const TS_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  { re: new RegExp(String.raw`([A-Za-z_$][\w$]*)\s*\??\s*:\s*(${TS_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
];

const PY_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*\(/g, nameGroup: 1, typeGroup: 2 },
  { re: /^\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.]*(?:\[[^\]]*\])?)/g, nameGroup: 1, typeGroup: 2 },
  { re: /self\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*\(/g, nameGroup: 1, typeGroup: 2 },
];
const PY_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  { re: /([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.]*(?:\[[^\]]*\])?)/g, nameGroup: 1, typeGroup: 2 },
];

const GO_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: /\bvar\s+([A-Za-z_]\w*)\s+\*?([A-Za-z_][\w.]*)/g, nameGroup: 1, typeGroup: 2 },
  { re: /([A-Za-z_]\w*)\s*:=\s*&?([A-Za-z_][\w.]*)\s*\{/g, nameGroup: 1, typeGroup: 2 },
  { re: /^func\s*\(\s*([A-Za-z_]\w*)\s+\*?([A-Za-z_][\w.]*)/g, nameGroup: 1, typeGroup: 2 },
];
const GO_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  { re: /([A-Za-z_]\w*)\s+\*?\[?\]?([A-Za-z_][\w.]*)/g, nameGroup: 1, typeGroup: 2 },
];

const RUST_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: new RegExp(String.raw`\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*&?\s*(?:mut\s+)?(${RUST_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
  { re: /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*=\s*&?\s*(?:mut\s+)?([A-Za-z_]\w*)\s*(?:::|\{)/g, nameGroup: 1, typeGroup: 2 },
];
const RUST_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  // `b: &dyn Base`, `b: impl Base`, `b: &'a Base` all name a receiver type of `Base`.
  { re: new RegExp(String.raw`([A-Za-z_]\w*)\s*:\s*&?\s*(?:'\w+\s*)?(?:mut\s+)?(?:(?:dyn|impl)\s+)?(${RUST_TYPE_EXPR})`, "g"), nameGroup: 1, typeGroup: 2 },
];

const CPP_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: /^\s*(?:const\s+)?([A-Z]\w*(?:<[^<>]*>)?)\s*[&*]*\s+([A-Za-z_]\w*)\s*[;=,)]/g, nameGroup: 2, typeGroup: 1 },
  { re: /^\s*(?:const\s+)?([A-Z]\w*(?:<[^<>]*>)?)\s*[&*]*\s+([A-Za-z_]\w*)\s*\{/g, nameGroup: 2, typeGroup: 1 },
  // `auto* svc = new OrderService();` / `auto svc = OrderService{};`
  { re: /\bauto\s*\*?\s*&?\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Z]\w*(?:<[^<>]*>)?)/g, nameGroup: 1, typeGroup: 2 },
  { re: /\bauto\s*\*?\s*&?\s+([A-Za-z_]\w*)\s*=\s*([A-Z]\w*(?:<[^<>]*>)?)\s*\{/g, nameGroup: 1, typeGroup: 2 },
];
const CPP_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  { re: /(?:const\s+)?([A-Z]\w*(?:<[^<>]*>)?)\s*[&*]*\s+([A-Za-z_]\w*)/g, nameGroup: 2, typeGroup: 1 },
];

const CS_RECEIVER_PATTERNS: ReceiverTypePattern[] = [
  { re: /\bvar\s+([A-Za-z_]\w*)\s*=\s*new\s+([A-Z]\w*(?:<[^<>]*>)?)/g, nameGroup: 1, typeGroup: 2 },
  { re: /(?:^|[=(,;])\s*([A-Za-z_]\w*)\s*=\s*new\s+([A-Z]\w*(?:<[^<>]*>)?)/g, nameGroup: 1, typeGroup: 2 },
  { re: new RegExp(String.raw`^\s*(?:(?:public|private|protected|internal|static|readonly|volatile|const|event)\s+)*(${CS_TYPE_EXPR})\??\s+([A-Za-z_]\w*)\s*[;=,)]`, "g"), nameGroup: 2, typeGroup: 1 },
  { re: new RegExp(String.raw`^\s*(?:(?:public|private|protected|internal|static|readonly|volatile)\s+)*(${CS_TYPE_EXPR})\??\s+([A-Za-z_]\w*)\s*\{`, "g"), nameGroup: 2, typeGroup: 1 },
];
const CS_PARAM_TYPE_PATTERNS: ReceiverTypePattern[] = [
  { re: new RegExp(String.raw`(${CS_TYPE_EXPR})\??\s+([A-Za-z_]\w*)`, "g"), nameGroup: 2, typeGroup: 1 },
];

function lineReceiverPatterns(family: SourceLanguageFamily): ReceiverTypePattern[] | undefined {
  switch (family) {
    case "js":
      return TS_RECEIVER_PATTERNS;
    case "python":
      return PY_RECEIVER_PATTERNS;
    case "go":
      return GO_RECEIVER_PATTERNS;
    case "rust":
      return RUST_RECEIVER_PATTERNS;
    case "c":
      return CPP_RECEIVER_PATTERNS;
    case "csharp":
      return CS_RECEIVER_PATTERNS;
    default:
      return undefined;
  }
}

function paramReceiverPatterns(family: SourceLanguageFamily): ReceiverTypePattern[] | undefined {
  switch (family) {
    case "js":
      return TS_PARAM_TYPE_PATTERNS;
    case "python":
      return PY_PARAM_TYPE_PATTERNS;
    case "go":
      return GO_PARAM_TYPE_PATTERNS;
    case "rust":
      return RUST_PARAM_TYPE_PATTERNS;
    case "c":
      return CPP_PARAM_TYPE_PATTERNS;
    case "csharp":
      return CS_PARAM_TYPE_PATTERNS;
    default:
      return undefined;
  }
}

function findEnclosingCallableSymbol(ast: FileAstAnalysis, line: number): AstSymbol | undefined {
  let best: AstSymbol | undefined;
  for (const sym of ast.symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    if (line >= sym.line && line <= sym.endLine) {
      if (!best || sym.endLine - sym.line < best.endLine - best.line) best = sym;
    }
  }
  return best;
}

function findEnclosingTypeSymbol(ast: FileAstAnalysis, line: number): AstSymbol | undefined {
  let best: AstSymbol | undefined;
  for (const sym of ast.symbols) {
    if (!isTypeDefinitionSymbol(sym)) continue;
    if (line >= sym.line && line <= sym.endLine) {
      if (!best || sym.endLine - sym.line < best.endLine - best.line) best = sym;
    }
  }
  return best;
}

/** Splits the first top-level type argument (`Order, Map<A,B>` -> `Order`). */
function firstTopLevelTypeArg(inner: string): string {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "<" || ch === "[" || ch === "(") depth += 1;
    else if (ch === ">" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if ((ch === "," || ch === "|") && depth === 0) return inner.slice(0, i).trim();
  }
  return inner.trim();
}

/**
 * Reduces a type expression to the base type used for receiver matching:
 * strips qualifiers/pointers/references/nullability, unwraps arrays and a generic wrapper's
 * first type argument (`Box<Order>` -> `Order`, `Option<&Order>` -> `Order`), and treats a
 * multi-type union as ambiguous (`A | B` -> undefined) while `A | null` -> `A`.
 * Namespaces are stripped (`ns.Foo` -> `Foo`).
 */
export function unwrapTypeExpression(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw.trim();
  for (let guard = 0; guard < 8; guard++) {
    const before = text;
    text = text
      .replace(/^(?:readonly|const|mut|static|final|volatile|unsigned|signed|long|short)\s+/i, "")
      .replace(/^[&*]\s*/, "")
      .replace(/^(?:async\s+)/i, "")
      .trim();
    if (text.startsWith("(") && text.endsWith(")") && text.length > 2) {
      text = text.slice(1, -1).trim();
    }
    text = text.replace(/(?:\[\s*\])+\s*$/, "").replace(/\?\s*$/, "").trim();
    const unionParts = text.split("|").map((part) => part.trim()).filter(Boolean);
    if (unionParts.length > 1) {
      const meaningful = unionParts.filter(
        (part) => !/^(?:null|undefined|None|nil|void|never)$/i.test(part)
      );
      if (meaningful.length !== 1) return undefined;
      text = meaningful[0]!;
    }
    const angleIdx = text.indexOf("<");
    const bracketIdx = text.indexOf("[");
    const cutIdx =
      angleIdx > 0 && text.endsWith(">")
        ? angleIdx
        : bracketIdx > 0 && text.endsWith("]")
          ? bracketIdx
          : -1;
    if (cutIdx > 0) {
      text = firstTopLevelTypeArg(text.slice(cutIdx + 1, -1).trim());
      continue;
    }
    if (text === before) break;
  }
  text = text.trim();
  const last = text.split(/[.:]/).pop()?.trim();
  if (!last || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return undefined;
  return last;
}

/** Accepts usual PascalCase types plus locally declared/imported type names. */
function isPlausibleInferredType(typeName: string, ast: FileAstAnalysis): boolean {
  if (/^[A-Z]/.test(typeName)) return true;
  if (ast.symbols.some((sym) => isTypeDefinitionSymbol(sym) && sym.name === typeName)) return true;
  return ast.imports.some((imp) => imp.importedNames.includes(typeName));
}

/**
 * Go has no `extends`; embedding (`type Child struct { Base }`) is the parity equivalent for
 * method promotion. Parsed with a small brace-depth scan so named fields are not mistaken for
 * embedded types.
 */
function parseGoEmbeddedParents(content: string): Map<string, string> {
  const parents = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  const structStack: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  for (const raw of lines) {
    const line = stripLineCommentsAndStrings(raw, "//").trim();
    if (!line) continue;
    const depthBefore = depth;
    const structStart = line.match(/^type\s+([A-Z]\w*)\s+struct\s*\{/);
    if (structStart) {
      structStack.push({ name: structStart[1]!, depth: depthBefore });
    } else if (
      structStack.length > 0 &&
      depthBefore > structStack[structStack.length - 1]!.depth
    ) {
      const embedded = line.match(/^\*?(?:[A-Za-z_]\w*\.)?([A-Z]\w*)\s*(?:`[^`]*`)?$/);
      if (embedded) {
        const top = structStack[structStack.length - 1]!;
        if (!parents.has(top.name)) parents.set(top.name, embedded[1]!);
      }
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    while (structStack.length > 0 && depth <= structStack[structStack.length - 1]!.depth) {
      structStack.pop();
    }
  }
  return parents;
}

/**
 * Parses `class -> declared base class` pairs for one file (line/regex based).
 * Supported: TS/JS `extends`, Python `class B(A)`, C# `class/record B : A`,
 * C++ `class/struct B : public A`, Go struct embedding (`type Child struct { Base }`).
 * Rust traits/impl inheritance is intentionally skipped (no inheritance in Rust).
 */
export function parseClassParents(
  relPath: string,
  content: string,
  astInput?: FileAstAnalysis
): Map<string, string> {
  const ast = astInput ?? analyzeSourceFile(relPath, content);
  const family = sourceLanguageFamily(relPath);
  if (family === "go") return parseGoEmbeddedParents(content);
  const parents = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  const commentPrefix = family === "python" ? "#" : "//";
  const toBaseName = (raw: string): string | undefined => {
    const last = raw.trim().split(/[.:]/).pop()?.trim();
    return last && /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) ? last : undefined;
  };
  const knownType = (name: string): boolean =>
    ast.symbols.some((sym) => isTypeDefinitionSymbol(sym) && sym.name === name) ||
    ast.imports.some((imp) => imp.importedNames.includes(name));
  // Cross-file bases are not necessarily imported/declared in this file; accept PascalCase
  // names as class-like and keep lowercase only when they are a known type.
  const isLikelyTypeBase = (name: string): boolean => /^[A-Z]/.test(name) || knownType(name);

  for (const raw of lines) {
    const line = stripLineCommentsAndStrings(raw, commentPrefix).trim();
    if (!line) continue;
    if (family === "js") {
      const match = line.match(
        /\bclass\s+([A-Za-z_$][\w$]*)(?:\s*<[^>]*>)?\s+extends\s+([A-Za-z_$][\w$.]*)/
      );
      if (match) {
        const base = toBaseName(match[2]!);
        if (base && base !== match[1] && isLikelyTypeBase(base)) parents.set(match[1]!, base);
      }
    } else if (family === "python") {
      const match = line.match(/^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
      if (match) {
        const bases = match[2]!
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        for (const base of bases) {
          const name = toBaseName(base);
          if (!name || name === match[1]) continue;
          if (/^(?:object|ABC|Protocol|Generic|Enum|str|int|float|bool|dict|list|tuple|set)$/.test(name)) {
            continue;
          }
          if (isLikelyTypeBase(name)) {
            parents.set(match[1]!, name);
            break;
          }
        }
      }
    } else if (family === "csharp") {
      const match = line.match(
        /^(?:(?:public|internal|private|protected|abstract|sealed|static|partial|unsafe)\s+)*(?:class|record)\s+([A-Z]\w*)(?:\s*<[^>]*>)?\s*:\s*([A-Za-z_][\w.]*)/
      );
      if (match) {
        const base = toBaseName(match[2]!);
        if (base && base !== match[1] && isLikelyTypeBase(base)) parents.set(match[1]!, base);
      }
    } else if (family === "c") {
      const match = line.match(
        /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Z]\w*)(?:\s*<[^>]*>)?\s*:\s*(?:(?:public|protected|private|virtual)\s+)*([A-Za-z_][\w:]*)/
      );
      if (match) {
        const base = toBaseName(match[2]!);
        if (base && base !== match[1] && isLikelyTypeBase(base)) parents.set(match[1]!, base);
      }
    }
  }
  return parents;
}

/** True when `sub` transitively extends `base` in the supplied parent map (cycle-safe). */
export function isSubclassOf(
  parents: ReadonlyMap<string, string>,
  sub: string,
  base: string
): boolean {
  let current = parents.get(sub);
  const seen = new Set<string>();
  while (current) {
    if (current === base) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

/** Stem of a file name without extension (`engine.cpp` -> `engine`). */
function fileStemLower(relPath: string): string {
  return basename(relPath).replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * Implicit (import-free) scope for languages whose build system makes sibling files
 * visible without an explicit symbol import. Shared by blast radius, rename and the
 * semantic index so all features agree on package visibility.
 */
export function inImplicitPackageScope(
  targetFile: string,
  candidateFile: string,
  family: SourceLanguageFamily
): boolean {
  const sameDir = dirname(targetFile) === dirname(candidateFile);
  switch (family) {
    case "go":
      // A Go package is exactly one directory.
      return sameDir;
    case "csharp":
      // Namespace info is not modelled; same directory is the safe approximation.
      return sameDir;
    case "c":
      // Translation unit + its header share a stem (`engine.cpp` <-> `engine.hpp`).
      return sameDir || fileStemLower(targetFile) === fileStemLower(candidateFile);
    default:
      return false;
  }
}

/** Minimal workspace cache shape needed to build a type hierarchy (structurally compatible with slicer). */
export interface WorkspaceTypeHierarchySource {
  readonly rootDir: string;
  getFiles(): string[];
  getRawFile(relPath: string): { content: string } | undefined;
  getFileAnalysis(relPath: string): { ast: FileAstAnalysis } | undefined;
}

/**
 * Best-effort, lazily built workspace type hierarchy used for inheritance-aware receiver
 * matching: `B extends A` + `b.cancel()` may dispatch to `A.cancel` only when B (and every
 * class between B and A) does not override `cancel`.
 */
export interface WorkspaceTypeHierarchy {
  parentOf(typeName: string): string | undefined;
  isSubclassOf(subType: string, baseType: string): boolean;
  declaresMethod(typeName: string, methodName: string): boolean;
  /** True when a receiver typed `resolvedType` can dispatch the call to `targetClass.methodName`. */
  isCompatibleReceiver(resolvedType: string, targetClass: string, methodName: string): boolean;
}

export function createWorkspaceTypeHierarchy(
  index: WorkspaceTypeHierarchySource
): WorkspaceTypeHierarchy {
  const parents = new Map<string, string>();
  let parentsLoaded = false;
  const loadParents = (): void => {
    if (parentsLoaded) return;
    parentsLoaded = true;
    for (const relPath of index.getFiles()) {
      const raw = index.getRawFile(relPath);
      if (!raw) continue;
      for (const [child, parent] of parseClassParents(relPath, raw.content)) {
        if (!parents.has(child)) parents.set(child, parent);
      }
    }
  };

  const declaredCache = new Map<string, boolean>();
  const declaresMethod = (typeName: string, methodName: string): boolean => {
    const cacheKey = `${typeName}#${methodName}`;
    const cached = declaredCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let found = false;
    for (const relPath of index.getFiles()) {
      const raw = index.getRawFile(relPath);
      if (!raw || !raw.content.includes(typeName) || !raw.content.includes(methodName)) continue;
      const ast = index.getFileAnalysis(relPath)?.ast;
      if (!ast) continue;
      if (ast.symbols.some((sym) => sym.name === methodName && sym.parentClass === typeName)) {
        found = true;
        break;
      }
    }
    declaredCache.set(cacheKey, found);
    return found;
  };

  return {
    parentOf(typeName: string): string | undefined {
      loadParents();
      return parents.get(typeName);
    },
    isSubclassOf(subType: string, baseType: string): boolean {
      loadParents();
      return isSubclassOf(parents, subType, baseType);
    },
    declaresMethod,
    isCompatibleReceiver(resolvedType: string, targetClass: string, methodName: string): boolean {
      if (resolvedType === targetClass) return true;
      loadParents();
      if (!isSubclassOf(parents, resolvedType, targetClass)) return false;
      // Walk the inheritance chain from the receiver type up to (but excluding) the target
      // class. Any intermediate override means the call does not reach the target method.
      let current: string | undefined = resolvedType;
      const seen = new Set<string>();
      while (current && current !== targetClass) {
        if (declaresMethod(current, methodName)) return false;
        const next = parents.get(current);
        if (!next || seen.has(next)) return false;
        seen.add(next);
        current = next;
      }
      return true;
    },
  };
}

/** Innermost block opener line per source line (brace languages; indentation for Python). */
function computeLineBlockIds(codeLines: string[], family: SourceLanguageFamily): number[] {
  const blocks = new Array<number>(codeLines.length).fill(0);
  if (family === "python") {
    const stack: Array<{ indent: number; line: number }> = [];
    const controlRe =
      /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b/;
    for (let i = 0; i < codeLines.length; i++) {
      const line = codeLines[i] ?? "";
      if (!line.trim()) {
        blocks[i] = stack.length > 0 ? stack[stack.length - 1]!.line : 0;
        continue;
      }
      const indent = indentColumns(line);
      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) stack.pop();
      blocks[i] = stack.length > 0 ? stack[stack.length - 1]!.line : 0;
      if (controlRe.test(line.trim())) stack.push({ indent, line: i + 1 });
    }
    return blocks;
  }
  const stack: number[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    blocks[i] = stack.length > 0 ? stack[stack.length - 1]! : 0;
    const line = codeLines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") stack.push(i + 1);
      else if (ch === "}") stack.pop();
    }
  }
  return blocks;
}

function extractSignatureParamText(signature: string): string {
  const open = signature.indexOf("(");
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return signature.slice(open + 1, i);
    }
  }
  return signature.slice(open + 1);
}

/**
 * Infers receiver-name -> declared-type data for one file. Pure regex/line heuristics over
 * comment/string-masked lines, plus parameter annotations parsed out of extracted symbol
 * signatures (so multi-line signatures still contribute).
 *  - last assignment in a scope wins for calls after it; assignments spread across different
 *    blocks (if/else/loop) with different types are treated as unknown;
 *  - generic/array/nullable wrappers are unwrapped to a base type (`Box<Order>` -> `Order`);
 *  - `class B extends A` and equivalents are recorded in `parents` for super/inheritance.
 */
export function inferReceiverTypeIndex(
  relPath: string,
  content: string,
  astInput?: FileAstAnalysis
): ReceiverTypeIndex {
  const ast = astInput ?? analyzeSourceFile(relPath, content);
  const family = sourceLanguageFamily(relPath);
  const rawLines = content.split(/\r?\n/);
  const codeLines =
    family === "python"
      ? maskPythonSource(rawLines).maskedLines
      : rawLines.map((line) => stripLineCommentsAndStrings(line, "//"));
  const blockIds = computeLineBlockIds(codeLines, family);

  const index: ReceiverTypeIndex = {
    byScope: new Map<string, string>(),
    byClass: new Map<string, string>(),
    byName: new Map<string, string>(),
    parents: parseClassParents(relPath, content, ast),
    assignments: new Map<string, ReceiverTypeAssignment[]>(),
  };

  const record = (
    receiver: string | undefined,
    rawType: string | undefined,
    line: number,
    scopeLine?: number,
    mode: "assignment" | "static" = "assignment"
  ): void => {
    if (!receiver || !rawType) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(receiver)) return;
    if (
      receiver === "this" ||
      receiver === "self" ||
      receiver === "cls" ||
      receiver === "super" ||
      receiver === "base"
    ) {
      return;
    }
    const callable = findEnclosingCallableSymbol(ast, line);
    let type = unwrapTypeExpression(rawType);
    if (!type || type === receiver) return;
    if (type === "Self") {
      type = callable?.parentClass;
      if (!type) return;
    }
    if (!isPlausibleInferredType(type, ast)) return;
    const scopeKey =
      scopeLine !== undefined ? String(scopeLine) : callable ? String(callable.line) : "0";
    const enclosingType = findEnclosingTypeSymbol(ast, line);
    index.byScope.set(`${scopeKey}#${receiver}`, type);
    if (mode === "assignment") {
      const isClassField = scopeLine === undefined && !callable && enclosingType !== undefined;
      if (!isClassField) {
        const key = `${scopeKey}#${receiver}`;
        const list = index.assignments!.get(key) ?? [];
        list.push({ line, block: blockIds[line - 1] ?? 0, type });
        index.assignments!.set(key, list);
      }
    }
    const classScope = callable?.parentClass ?? enclosingType?.name;
    if (classScope) index.byClass.set(`${classScope}#${receiver}`, type);
    index.byName.set(receiver, type);
  };

  const applyPatterns = (
    patterns: ReceiverTypePattern[],
    text: string,
    line: number,
    scopeLine?: number,
    mode: "assignment" | "static" = "assignment"
  ): void => {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(text)) !== null) {
        record(match[pattern.nameGroup], match[pattern.typeGroup], line, scopeLine, mode);
        if (match.index === pattern.re.lastIndex) pattern.re.lastIndex += 1;
      }
    }
  };

  const linePatterns = lineReceiverPatterns(family);
  if (linePatterns) {
    for (let i = 0; i < codeLines.length; i++) {
      applyPatterns(linePatterns, codeLines[i] ?? "", i + 1);
    }
  }

  // Parameter annotations are recovered from extracted signatures (covers multi-line headers).
  const paramPatterns = paramReceiverPatterns(family);
  if (paramPatterns) {
    for (const sym of ast.symbols) {
      if (sym.kind !== "function" && sym.kind !== "method") continue;
      if (!sym.signature) continue;
      const params = extractSignatureParamText(sym.signature);
      if (!params) continue;
      applyPatterns(paramPatterns, params, sym.line, sym.line, "static");
    }
  }

  return index;
}

/** Flat fallback form: receiver name -> inferred type (last write wins). */
export function inferReceiverTypes(
  relPath: string,
  content: string,
  astInput?: FileAstAnalysis
): Map<string, string> {
  return inferReceiverTypeIndex(relPath, content, astInput).byName;
}

interface AssignmentLookup {
  found: boolean;
  type?: string;
}

/**
 * Flow-insensitive assignment lookup: the last assignment before the call wins, unless
 * different inferred types live in different blocks (branches), which is reported as unknown.
 */
function lookupAssignmentType(
  index: ReceiverTypeIndex,
  key: string,
  callLine: number
): AssignmentLookup {
  const entries = index.assignments?.get(key);
  if (!entries || entries.length === 0) return { found: false };
  const before = entries.filter((entry) => entry.line < callLine);
  if (before.length === 0) return { found: false };
  const last = before[before.length - 1]!;
  if (!last.type) return { found: true };
  const types = new Set<string>();
  const blocks = new Set<number>();
  for (const entry of before) {
    if (entry.type) types.add(entry.type);
    blocks.add(entry.block);
  }
  if (types.size > 1 && blocks.size > 1) return { found: true };
  return { found: true, type: last.type };
}

/**
 * Resolves the static type of a member-call receiver, using the call's enclosing callable
 * (`this`/`self`/`Self` -> caller's parentClass, `super`/`base` -> parent class, flow-insensitive
 * last assignment in scope, class fields) and falling back to a static/associated receiver
 * (`Class.method`, `Class::method`). Returns `undefined` when the receiver type stays unknown.
 */
export function resolveReceiverType(
  call: Pick<AstCallSite, "receiver" | "line">,
  ast: FileAstAnalysis,
  index: ReceiverTypeIndex
): string | undefined {
  const receiver = call.receiver;
  if (!receiver) return undefined;
  const callable = findEnclosingCallableSymbol(ast, call.line);
  if (receiver === "super" || receiver === "base") {
    if (!callable?.parentClass) return undefined;
    return index.parents?.get(callable.parentClass);
  }
  if (receiver === "this" || receiver === "self" || receiver === "cls" || receiver === "Self") {
    return callable?.parentClass;
  }
  if (callable) {
    const scoped = lookupAssignmentType(index, `${callable.line}#${receiver}`, call.line);
    if (scoped.found) return scoped.type;
    const scopedStatic = index.byScope.get(`${callable.line}#${receiver}`);
    if (scopedStatic) return scopedStatic;
    if (callable.parentClass) {
      const classScoped = index.byClass.get(`${callable.parentClass}#${receiver}`);
      if (classScoped) return classScoped;
    }
  }
  const moduleScoped = lookupAssignmentType(index, `0#${receiver}`, call.line);
  if (moduleScoped.found) return moduleScoped.type;
  const moduleStatic = index.byScope.get(`0#${receiver}`);
  if (moduleStatic) return moduleStatic;
  const typeSymbol = ast.symbols.find((sym) => sym.name === receiver && isTypeDefinitionSymbol(sym));
  if (typeSymbol) return typeSymbol.name;
  // Associated/static call such as `OrderService.cancel(...)` or `Engine::cancel(...)`.
  if (/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) return receiver;
  return undefined;
}

/**
 * Splits a scoped symbol query (`Class.method`, `Class::method`) into container and member.
 * Bare names return `{ member }` unchanged.
 */
export function splitQualifiedSymbolName(raw: string): { member: string; container?: string } {
  const trimmed = raw.trim();
  if (trimmed.includes("::")) {
    const parts = trimmed.split("::");
    const member = parts[parts.length - 1]?.trim() ?? trimmed;
    const container = parts.slice(0, -1).join("::").trim();
    return container ? { member, container } : { member };
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot > 0 && dot < trimmed.length - 1) {
    return { member: trimmed.slice(dot + 1), container: trimmed.slice(0, dot) };
  }
  return { member: trimmed };
}

function checkBraceBalanceSyntax(
  lines: string[],
  commentPrefix: "//" | "#" = "//"
): Array<{ line: number; column?: number; message: string }> {
  const errors: Array<{ line: number; column?: number; message: string }> = [];
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    let line = raw;
    if (commentPrefix === "//") {
      // Handle /* ... */ block comments
      let cleaned = "";
      for (let j = 0; j < line.length; j++) {
        if (!inBlockComment && line[j] === "/" && line[j + 1] === "*") {
          inBlockComment = true;
          j += 1;
          continue;
        }
        if (inBlockComment && line[j] === "*" && line[j + 1] === "/") {
          inBlockComment = false;
          j += 1;
          continue;
        }
        if (!inBlockComment) cleaned += line[j];
      }
      line = stripLineCommentsAndStrings(cleaned, "//");
    } else {
      line = stripLineCommentsAndStrings(raw, "#");
    }

    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push({ ch, line: i + 1 });
      } else if (ch === ")" || ch === "]" || ch === "}") {
        const expected = pairs[ch]!;
        const top = stack.pop();
        if (!top || top.ch !== expected) {
          errors.push({
            line: i + 1,
            column: c + 1,
            message: `Unmatched closing '${ch}'`,
          });
          return errors;
        }
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    errors.push({
      line: unclosed.line,
      message: `Unclosed '${unclosed.ch}' opened at line ${unclosed.line}`,
    });
  }
  return errors;
}

// ── 1. TypeScript / JavaScript (@babel/parser) ──────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any --
 * Babel AST interop: the parser module is resolved lazily at runtime and the
 * repo carries no @babel/types dependency, so AST nodes are traversed as
 * untyped `any`. Hand-rolling the recursive BabelNode shape here would be a
 * large, error-prone mirror of an external AST contract. */
interface BabelParserModule {
  parse(
    input: string,
    options?: {
      sourceType?: "module" | "script" | "unambiguous";
      plugins?: string[];
      errorRecovery?: boolean;
    }
  ): any;
}

let cachedBabelParser: BabelParserModule | null | undefined;

function loadBabelParser(): BabelParserModule | null {
  if (cachedBabelParser !== undefined) return cachedBabelParser;
  for (const candidate of ["@babel/parser", "/usr/share/nodejs/@babel/parser"]) {
    try {
      cachedBabelParser = requireFn(candidate) as BabelParserModule;
      return cachedBabelParser;
    } catch {
      // try next
    }
  }
  cachedBabelParser = null;
  return null;
}

function parseWithBabel(relPath: string, content: string, parser: BabelParserModule): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const ext = extname(relPath).toLowerCase();
  const plugins: string[] = ["typescript", "decorators-legacy", "classProperties", "topLevelAwait"];
  if (ext === ".tsx" || ext === ".jsx" || ext === ".js" || ext === ".mjs") {
    plugins.push("jsx");
  }

  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const calls: AstCallSite[] = [];
  const syntaxErrors: Array<{ line: number; column?: number; message: string }> = [];

  let ast: any;
  try {
    ast = parser.parse(content, {
      sourceType: "unambiguous",
      plugins,
      errorRecovery: true,
    });
    if (Array.isArray(ast.errors) && ast.errors.length > 0) {
      for (const err of ast.errors) {
        syntaxErrors.push({
          line: err.loc?.line ?? 1,
          column: err.loc?.column,
          message: String(err.message ?? "Syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""),
        });
      }
    }
  } catch (err: any) {
    syntaxErrors.push({
      line: err?.loc?.line ?? 1,
      column: err?.loc?.column,
      message: String(err?.message ?? "Syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""),
    });
    const fallback = parseWithStructuralScanner(relPath, content);
    return { ...fallback, syntaxErrors };
  }

  const sliceNodeText = (node: any): string => {
    if (typeof node?.start === "number" && typeof node?.end === "number") {
      return content.slice(node.start, node.end);
    }
    return "";
  };

  const addSymbol = (
    name: string | undefined,
    kind: SymbolKind,
    exported: boolean,
    outerNode: any,
    innerNode: any,
    extras?: Partial<AstSymbol>
  ) => {
    if (!name || typeof name !== "string") return;
    const line: number = outerNode?.loc?.start?.line ?? innerNode?.loc?.start?.line ?? 1;
    const endLine: number = outerNode?.loc?.end?.line ?? innerNode?.loc?.end?.line ?? line;
    const bodyStartLine: number | undefined = innerNode?.body?.loc?.start?.line;
    const rawText = sliceNodeText(outerNode);
    const sig = cleanSignatureHeader(lines, line, bodyStartLine ?? endLine);
    const fields =
      kind === "interface" || kind === "type" || kind === "class"
        ? extractStructFields(rawText, ext)
        : undefined;
    symbols.push({
      name,
      kind,
      exported,
      line,
      endLine,
      ...(bodyStartLine ? { bodyStartLine } : {}),
      signature: sig,
      referencedTypes: extractPascalCaseTypes(rawText, name),
      ...(fields && fields.length > 0 ? { fields } : {}),
      ...extras,
    });
  };

  const handleDeclaration = (decl: any, outerNode: any, exported: boolean) => {
    if (!decl) return;
    switch (decl.type) {
      case "FunctionDeclaration":
      case "TSDeclareFunction": {
        const name = decl.id?.name;
        const paramsCount = Array.isArray(decl.params) ? decl.params.length : 0;
        const returnType = decl.returnType?.typeAnnotation
          ? sliceNodeText(decl.returnType.typeAnnotation).slice(0, 80)
          : undefined;
        addSymbol(name, "function", exported, outerNode, decl, {
          paramsCount,
          ...(returnType ? { returnType } : {}),
        });
        break;
      }
      case "ClassDeclaration": {
        const className = decl.id?.name;
        addSymbol(className, "class", exported, outerNode, decl);
        const bodyItems = decl.body?.body;
        if (Array.isArray(bodyItems)) {
          for (const member of bodyItems) {
            if (member.type === "ClassMethod" || member.type === "TSDeclareMethod") {
              const methodName = member.key?.name ?? member.key?.value;
              if (methodName && methodName !== "constructor") {
                const paramsCount = Array.isArray(member.params) ? member.params.length : 0;
                addSymbol(methodName, "method", exported, member, member, {
                  paramsCount,
                  ...(className ? { parentClass: className } : {}),
                });
              }
            }
          }
        }
        break;
      }
      case "TSInterfaceDeclaration": {
        addSymbol(decl.id?.name, "interface", exported, outerNode, decl);
        break;
      }
      case "TSTypeAliasDeclaration": {
        addSymbol(decl.id?.name, "type", exported, outerNode, decl);
        break;
      }
      case "TSEnumDeclaration": {
        addSymbol(decl.id?.name, "enum", exported, outerNode, decl);
        break;
      }
      case "VariableDeclaration": {
        if (!Array.isArray(decl.declarations)) break;
        for (const d of decl.declarations) {
          const name = d.id?.name;
          if (!name) continue;
          const init = d.init;
          const isFunc =
            init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression";
          const paramsCount = isFunc && Array.isArray(init.params) ? init.params.length : undefined;
          addSymbol(
            name,
            isFunc ? "function" : "variable",
            exported,
            decl.declarations.length === 1 ? outerNode : d,
            isFunc ? init : d,
            paramsCount !== undefined ? { paramsCount } : undefined
          );
        }
        break;
      }
    }
  };

  const body = ast.program?.body ?? [];
  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration") {
      const mod = stmt.source?.value;
      if (typeof mod === "string") {
        const names: string[] = [];
        for (const spec of stmt.specifiers ?? []) {
          const importedName = spec.imported?.name ?? spec.local?.name;
          if (importedName) names.push(importedName);
        }
        const startL = stmt.loc?.start?.line ?? 1;
        const endL = stmt.loc?.end?.line ?? startL;
        imports.push({
          module: mod,
          importedNames: names,
          line: startL,
          endLine: endL,
          raw: sliceNodeText(stmt).replace(/\s+/g, " ").trim(),
        });
      }
    } else if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.source?.value) {
        const startL = stmt.loc?.start?.line ?? 1;
        const endL = stmt.loc?.end?.line ?? startL;
        const names: string[] = [];
        for (const spec of stmt.specifiers ?? []) {
          const localName = spec.local?.name ?? spec.exported?.name;
          if (localName) names.push(localName);
        }
        imports.push({
          module: stmt.source.value,
          importedNames: names,
          line: startL,
          endLine: endL,
          raw: sliceNodeText(stmt).replace(/\s+/g, " ").trim(),
        });
      }
      if (stmt.declaration) {
        handleDeclaration(stmt.declaration, stmt, true);
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      if (stmt.declaration) {
        handleDeclaration(stmt.declaration, stmt, true);
      }
    } else if (stmt.type === "ExportAllDeclaration") {
      if (stmt.source?.value) {
        const startL = stmt.loc?.start?.line ?? 1;
        const endL = stmt.loc?.end?.line ?? startL;
        imports.push({
          module: stmt.source.value,
          importedNames: ["*"],
          line: startL,
          endLine: endL,
          raw: sliceNodeText(stmt).replace(/\s+/g, " ").trim(),
        });
      }
    } else {
      handleDeclaration(stmt, stmt, false);
    }
  }

  const walkCalls = (node: any, enclosingCaller?: string) => {
    if (!node || typeof node !== "object") return;
    let currentCaller = enclosingCaller;
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "ClassMethod" ||
        node.type === "ObjectMethod") &&
      (node.id?.name || node.key?.name)
    ) {
      currentCaller = node.id?.name ?? node.key?.name;
    } else if (
      node.type === "VariableDeclarator" &&
      node.id?.name &&
      (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
    ) {
      currentCaller = node.id.name;
    }

    if (
      node.type === "CallExpression" ||
      node.type === "OptionalCallExpression" ||
      node.type === "NewExpression"
    ) {
      const callee = node.callee;
      let calleeName: string | undefined;
      let receiver: string | undefined;
      let receiverCall: string | undefined;
      let member = false;
      if (callee?.type === "Identifier") {
        calleeName = callee.name;
      } else if (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") {
        calleeName = callee.property?.name;
        member = true;
        // Unwrap TS non-null / as / parenthesized wrappers around the receiver expression.
        let obj = callee.object;
        while (
          obj &&
          (obj.type === "TSNonNullExpression" ||
            obj.type === "TSAsExpression" ||
            obj.type === "TSTypeAssertion" ||
            obj.type === "ParenthesizedExpression")
        ) {
          obj = obj.expression;
        }
        if (obj?.type === "Identifier") {
          receiver = obj.name;
        } else if (obj?.type === "ThisExpression") {
          receiver = "this";
        } else if (obj?.type === "Super") {
          receiver = "super";
        } else if (obj?.type === "CallExpression" || obj?.type === "OptionalCallExpression") {
          // Factory chain: `getService().cancel()`.
          if (obj.callee?.type === "Identifier") receiverCall = obj.callee.name;
        } else if (
          obj?.type === "MemberExpression" ||
          obj?.type === "OptionalMemberExpression"
        ) {
          if (!obj.computed && typeof obj.property?.name === "string") receiver = obj.property.name;
          else if (obj.object?.type === "Identifier") receiver = obj.object.name;
        }
      }
      if (calleeName && calleeName !== "require" && calleeName !== "import") {
        calls.push({
          ...(currentCaller ? { caller: currentCaller } : {}),
          callee: calleeName,
          line: node.loc?.start?.line ?? 1,
          argsCount: Array.isArray(node.arguments) ? node.arguments.length : 0,
          ...(receiver ? { receiver } : {}),
          ...(member ? { member: true } : {}),
          ...(receiverCall ? { receiverCall } : {}),
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      ) {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === "string") {
            walkCalls(item, currentCaller);
          }
        }
      } else if (child && typeof child.type === "string") {
        walkCalls(child, currentCaller);
      }
    }
  };

  walkCalls(ast.program, undefined);

  return {
    relPath,
    totalLines: lines.length,
    backend: "babel",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 2. Python (`.py`, `.pyi`) Indentation-Scoped AST Analyzer ────────────

function indentColumns(line: string): number {
  let cols = 0;
  for (const ch of line) {
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += 4;
    else break;
  }
  return cols;
}

interface PythonMaskResult {
  maskedLines: string[];
  inMultilineString: boolean[];
  unclosedTriple: '"""' | "'''" | null;
}

/**
 * Masks Python comments and string literals (including multi-line triple-quoted strings)
 * with spaces while preserving line structure, so bracket/colon analysis never trips on
 * string contents or docstrings.
 */
function maskPythonSource(lines: string[]): PythonMaskResult {
  const maskedLines: string[] = [];
  const inMultilineString: boolean[] = [];
  let inSingle = false;
  let inDouble = false;
  let triple: '"""' | "'''" | null = null;

  for (let i = 0; i < lines.length; i++) {
    inMultilineString.push(triple !== null);
    const raw = lines[i] ?? "";
    let out = "";
    let j = 0;
    while (j < raw.length) {
      if (triple !== null) {
        if (raw.startsWith(triple, j)) {
          triple = null;
          out += "   ";
          j += 3;
        } else {
          out += " ";
          j += 1;
        }
        continue;
      }
      const ch = raw[j]!;
      if (inSingle || inDouble) {
        if (ch === "\\") {
          out += "  ";
          j += 2;
          continue;
        }
        if ((inSingle && ch === "'") || (inDouble && ch === '"')) {
          inSingle = false;
          inDouble = false;
        }
        out += " ";
        j += 1;
        continue;
      }
      if (ch === "#") {
        out += " ".repeat(raw.length - j);
        break;
      }
      if (raw.startsWith('"""', j) || raw.startsWith("'''", j)) {
        triple = raw.slice(j, j + 3) as '"""' | "'''";
        out += "   ";
        j += 3;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        out += " ";
        j += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        out += " ";
        j += 1;
        continue;
      }
      out += ch;
      j += 1;
    }
    // Single/double quoted strings cannot span physical lines without a backslash continuation.
    inSingle = false;
    inDouble = false;
    maskedLines.push(out);
  }

  return { maskedLines, inMultilineString, unclosedTriple: triple };
}

const PY_COMPOUND_KEYWORDS = new Set([
  "def", "class", "if", "elif", "else", "for", "while", "with",
  "try", "except", "finally", "match", "case",
]);

/** Returns the index of the first `:` at bracket depth 0 that is not a `:=` walrus. */
function findTopLevelColon(masked: string): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0 && masked[i + 1] !== "=") return i;
  }
  return -1;
}

/**
 * Structural Python syntax guard (heuristic, not a full parser):
 *  - unbalanced `()[]{}` across logical lines,
 *  - missing `:` after `def/class/if/elif/else/for/while/with/try/except/finally/match/case`,
 *  - `def`/`class` without a name,
 *  - compound statements illegally starting a one-line suite (`def f(): if x`).
 * Bracket depth is tracked so multi-line signatures are not false positives, and
 * triple-quoted strings/docstrings are masked out.
 */
function checkPythonSyntax(lines: string[], masked: PythonMaskResult): Array<{ line: number; column?: number; message: string }> {
  const errors: Array<{ line: number; column?: number; message: string }> = [];
  if (masked.unclosedTriple !== null) {
    errors.push({
      line: lines.length,
      message: `Unclosed triple-quoted string (${masked.unclosedTriple})`,
    });
  }

  const stack: Array<{ ch: string; line: number }> = [];
  const depthBefore: number[] = [];
  const depthAfter: number[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let unbalanced = false;

  for (let i = 0; i < masked.maskedLines.length; i++) {
    depthBefore.push(stack.length);
    const line = masked.maskedLines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push({ ch, line: i + 1 });
      } else if (ch === ")" || ch === "]" || ch === "}") {
        const top = stack.pop();
        if (!top || top.ch !== pairs[ch]) {
          errors.push({ line: i + 1, column: c + 1, message: `Unmatched closing '${ch}'` });
          unbalanced = true;
          break;
        }
      }
    }
    depthAfter.push(stack.length);
    if (unbalanced) break;
  }
  if (unbalanced) return errors;
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    errors.push({
      line: unclosed.line,
      message: `Unclosed '${unclosed.ch}' opened at line ${unclosed.line}`,
    });
    return errors;
  }

  const maskedLines = masked.maskedLines;
  const consumed = new Set<number>();

  for (let i = 0; i < maskedLines.length; i++) {
    if (consumed.has(i) || masked.inMultilineString[i]) continue;
    if (depthBefore[i]! > 0) continue;
    const line = maskedLines[i]!;
    if (!line.trim()) continue;
    if (i > 0 && /\\\s*$/.test(maskedLines[i - 1]!.trimEnd())) continue;

    let header = line.trimStart();
    let kw = header.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (!kw) continue;
    if (kw === "async") {
      const rest = header.slice(5).trimStart();
      const inner = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (!inner || (inner !== "def" && inner !== "for" && inner !== "with")) continue;
      kw = inner;
      header = rest;
    }
    if (!PY_COMPOUND_KEYWORDS.has(kw)) continue;

    if (kw === "def" || kw === "class") {
      if (!new RegExp(`^${kw}\\s+[A-Za-z_][A-Za-z0-9_]*`).test(header)) {
        errors.push({ line: i + 1, message: `Python '${kw}' statement is missing a name` });
        continue;
      }
    }

    // Scan the (possibly multi-line) header for its terminating top-level ':'.
    let colonLine = -1;
    let colonPos = -1;
    let headerEndLine = i + 1;
    for (let j = i; j < Math.min(maskedLines.length, i + 50); j++) {
      const text = j === i ? header : maskedLines[j]!;
      const pos = findTopLevelColon(text);
      if (pos >= 0) {
        colonLine = j;
        colonPos = pos;
        headerEndLine = j + 1;
        break;
      }
      const continues = (depthAfter[j]! > depthBefore[i]!) || /\\\s*$/.test(maskedLines[j]!);
      if (!continues) break;
      if (j > i) consumed.add(j);
    }

    if (colonLine < 0) {
      // `match` and `case` are soft keywords: skip ordinary assignments/attribute access
      // (`match = re.match(...)`, `case.group(1)`) so they don't look like broken statements.
      if (
        (kw === "match" || kw === "case") &&
        new RegExp(`^${kw}\\s*(?:[=(.,\\[+\\-*/%]|$)`).test(header)
      ) {
        continue;
      }
      errors.push({ line: i + 1, message: `Python '${kw}' statement is missing ':' at line ${i + 1}` });
      continue;
    }

    // A one-line suite may only contain simple statements, never another compound statement.
    const colonText = colonLine === i ? header : maskedLines[colonLine]!;
    const inlineSuite = colonText.slice(colonPos + 1).trim();
    const inlineWord = inlineSuite.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (inlineWord && (PY_COMPOUND_KEYWORDS.has(inlineWord) || inlineWord === "async")) {
      errors.push({
        line: headerEndLine,
        message: `Python '${kw}' one-line suite cannot start with compound statement '${inlineWord}' (missing ':'?)`,
      });
    }
  }

  return errors;
}

export function parsePython(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];

  // Mask comments/strings first so multi-line docstrings never trip bracket/colon checks.
  const masked = maskPythonSource(lines);
  const inMultilineString = masked.inMultilineString;
  const syntaxErrors = checkPythonSyntax(lines, masked);

  const findHeaderEndLine = (startIdx: number): number => {
    let parenDepth = 0;
    for (let i = startIdx; i < Math.min(lines.length, startIdx + 20); i++) {
      const stripped = stripLineCommentsAndStrings(lines[i] ?? "", "#");
      for (const ch of stripped) {
        if (ch === "(" || ch === "[") parenDepth += 1;
        else if (ch === ")" || ch === "]") parenDepth = Math.max(0, parenDepth - 1);
      }
      if (parenDepth === 0 && stripped.trimEnd().endsWith(":")) {
        return i + 1;
      }
    }
    return startIdx + 1;
  };

  const findPyBlockEndLine = (_declIdx: number, headerEndLine: number, baseIndent: number): number => {
    let lastCodeLine = headerEndLine;
    for (let i = headerEndLine; i < lines.length; i++) {
      if (inMultilineString[i]) {
        lastCodeLine = i + 1;
        continue;
      }
      const raw = lines[i] ?? "";
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const ind = indentColumns(raw);
      if (ind <= baseIndent) {
        break;
      }
      lastCodeLine = i + 1;
    }
    return lastCodeLine;
  };

  let pendingDecoratorStart: number | undefined;
  const activeClassStack: Array<{ name: string; indent: number; endLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (inMultilineString[i]) continue;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const ind = indentColumns(raw);
    while (activeClassStack.length > 0 && i + 1 > activeClassStack[activeClassStack.length - 1]!.endLine) {
      activeClassStack.pop();
    }

    if (trimmed.startsWith("@")) {
      if (pendingDecoratorStart === undefined) pendingDecoratorStart = i + 1;
      continue;
    }

    // Python imports: `from X import a, b` or `import X, Y as Z`
    const fromImportMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+\(?([^)]+)\)?/);
    if (fromImportMatch) {
      pendingDecoratorStart = undefined;
      const mod = fromImportMatch[1]!;
      const names = fromImportMatch[2]!
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
        .filter(Boolean);
      imports.push({
        module: mod,
        importedNames: names,
        line: i + 1,
        endLine: i + 1,
        raw: trimmed,
      });
      continue;
    }

    const directImportMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.,\s]+)/);
    if (directImportMatch) {
      pendingDecoratorStart = undefined;
      const specs = directImportMatch[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) {
        const modName = spec.split(/\s+as\s+/)[0]!.trim();
        const shortName = modName.split(".").pop()!;
        imports.push({
          module: modName,
          importedNames: [shortName, "*"],
          line: i + 1,
          endLine: i + 1,
          raw: trimmed,
        });
      }
      continue;
    }

    // Class declaration: `class Name(Base):`
    const classMatch = raw.match(/^(\s*)class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const name = classMatch[2]!;
      const bases = classMatch[3] ?? "";
      const startLine = pendingDecoratorStart ?? i + 1;
      pendingDecoratorStart = undefined;
      const headerEnd = findHeaderEndLine(i);
      const endLine = findPyBlockEndLine(i, headerEnd, ind);
      const rawBlock = lines.slice(startLine - 1, endLine).join("\n");
      const isDataType =
        /\b(TypedDict|NamedTuple|BaseModel|Protocol|Enum|IntEnum|StrEnum)\b/.test(bases) ||
        rawBlock.includes("@dataclass");
      const kind: SymbolKind = isDataType ? "interface" : "class";

      const pyFields = extractStructFields(rawBlock, ".py");
      symbols.push({
        name,
        kind,
        exported: !name.startsWith("_"),
        line: startLine,
        endLine,
        bodyStartLine: headerEnd,
        signature: lines[i]!.trim(),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(pyFields.length > 0 ? { fields: pyFields } : {}),
      });
      activeClassStack.push({ name, indent: ind, endLine });
      continue;
    }

    // Function / method declaration: `[async] def name(params...) -> Ret:`
    const defMatch = raw.match(/^(\s*)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (defMatch) {
      const name = defMatch[2]!;
      const startLine = pendingDecoratorStart ?? i + 1;
      pendingDecoratorStart = undefined;
      const headerEnd = findHeaderEndLine(i);
      const endLine = findPyBlockEndLine(i, headerEnd, ind);

      const headerText = lines
        .slice(i, headerEnd)
        .map((l) => stripLineCommentsAndStrings(l, "#").trim())
        .join(" ");

      // Colon placement is validated by checkPythonSyntax(); here only guard an empty body.
      if (headerText.trimEnd().endsWith(":") && endLine <= headerEnd && !headerText.replace(/^.*:\s*/, "").trim()) {
        syntaxErrors.push({
          line: headerEnd,
          message: `IndentationError: expected an indented block after 'def ${name}'`,
        });
      }

      const openParen = headerText.indexOf("(");
      const closeParen = headerText.lastIndexOf(")");
      const paramStr =
        openParen >= 0 && closeParen > openParen ? headerText.slice(openParen + 1, closeParen) : "";
      const rawParams = paramStr
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p !== "/" && p !== "*");
      const filteredParams = rawParams.filter(
        (p, idx) => !(idx === 0 && (p === "self" || p === "cls" || p.startsWith("self:") || p.startsWith("cls:")))
      );

      const enclosingClass =
        activeClassStack.length > 0 && ind > activeClassStack[activeClassStack.length - 1]!.indent
          ? activeClassStack[activeClassStack.length - 1]!.name
          : undefined;

      const rawBlock = lines.slice(startLine - 1, endLine).join("\n");
      symbols.push({
        name,
        kind: enclosingClass ? "method" : "function",
        exported: !name.startsWith("_"),
        line: startLine,
        endLine,
        bodyStartLine: headerEnd,
        signature: headerText,
        paramsCount: filteredParams.length,
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(enclosingClass ? { parentClass: enclosingClass } : {}),
      });
      continue;
    }

    // Top-level TypeAlias: `PolicyMode: TypeAlias = ...` or `type PolicyMode = ...`
    if (ind === 0) {
      const typeAliasMatch =
        trimmed.match(/^type\s+([A-Z][a-zA-Z0-9_]*)\s*=/) ??
        trimmed.match(/^([A-Z][a-zA-Z0-9_]*)\s*(?::\s*TypeAlias)?\s*=\s*(?:Union|Literal|Optional|Callable|tuple|dict|list|\[)/);
      if (typeAliasMatch) {
        const name = typeAliasMatch[1]!;
        symbols.push({
          name,
          kind: "type",
          exported: !name.startsWith("_"),
          line: i + 1,
          endLine: i + 1,
          signature: trimmed,
          referencedTypes: extractPascalCaseTypes(trimmed, name),
        });
      }
    }

    pendingDecoratorStart = undefined;
  }

  const calls = extractCallSitesFromLines(lines, symbols, "#");

  return {
    relPath,
    totalLines: lines.length,
    backend: "python-ast",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

// ── Helper: Find Brace-Balanced Span for C-family / Go / Rust / C# ────────

function findBraceSpan(
  lines: string[],
  startIdx: number
): { endLine: number; bodyStartLine?: number } {
  let depth = 0;
  let opened = false;
  let bodyStartLine: number | undefined;
  for (let i = startIdx; i < lines.length; i++) {
    const stripped = stripLineCommentsAndStrings(lines[i] ?? "", "//");
    for (const ch of stripped) {
      if (ch === "{") {
        if (!opened) {
          opened = true;
          bodyStartLine = i + 1;
        }
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (opened && depth <= 0) {
          return { endLine: i + 1, ...(bodyStartLine ? { bodyStartLine } : {}) };
        }
      }
    }
    if (!opened && stripped.trim().endsWith(";")) {
      return { endLine: i + 1 };
    }
  }
  return { endLine: lines.length, ...(bodyStartLine ? { bodyStartLine } : {}) };
}

// ── 3. Go (`.go`) AST Analyzer ────────────────────────────────────────────

export function parseGo(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "//");

  let inImportBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (trimmed.startsWith("import (")) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (trimmed.startsWith(")")) {
        inImportBlock = false;
        continue;
      }
      const m = trimmed.match(/^(?:([a-zA-Z0-9_.]+)\s+)?"([^"]+)"/);
      if (m) {
        const pkgPath = m[2]!;
        const pkgShort = m[1] ?? pkgPath.split("/").pop()!;
        imports.push({
          module: pkgPath,
          importedNames: [pkgShort, "*"],
          line: i + 1,
          endLine: i + 1,
          raw: trimmed,
        });
      }
      continue;
    }

    const singleImp = trimmed.match(/^import\s+(?:([a-zA-Z0-9_.]+)\s+)?"([^"]+)"/);
    if (singleImp) {
      const pkgPath = singleImp[2]!;
      const pkgShort = singleImp[1] ?? pkgPath.split("/").pop()!;
      imports.push({
        module: pkgPath,
        importedNames: [pkgShort, "*"],
        line: i + 1,
        endLine: i + 1,
        raw: trimmed,
      });
      continue;
    }

    // Go func or receiver method: `func (r *Recv) Name(params...) ...` or `func Name(params...) ...`
    const funcMatch = raw.match(
      /^func\s+(?:\(\s*(?:[a-zA-Z0-9_]+\s+)?\*?([a-zA-Z0-9_]+)(?:\[[^\]]*\])?\s*\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/
    );
    if (funcMatch) {
      const receiver = funcMatch[1];
      const name = funcMatch[2]!;
      const paramStr = funcMatch[3] ?? "";
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const paramsCount = countTopLevelArgs(paramStr);

      symbols.push({
        name,
        kind: receiver ? "method" : "function",
        exported: /^[A-Z]/.test(name),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        paramsCount,
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(receiver ? { parentClass: receiver } : {}),
      });
      continue;
    }

    // Go type declaration: `type Name struct {` / `type Name interface {` / `type Name ...`
    const typeMatch = raw.match(/^type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(struct|interface|[^\s{]+)/);
    if (typeMatch) {
      const name = typeMatch[1]!;
      const kindKw = typeMatch[2]!;
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const kind: SymbolKind =
        kindKw === "struct" ? "struct" : kindKw === "interface" ? "interface" : "type";
      const goFields = extractStructFields(rawBlock, ".go");
      symbols.push({
        name,
        kind,
        exported: /^[A-Z]/.test(name),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(goFields.length > 0 ? { fields: goFields } : {}),
      });
    }
  }

  const calls = extractCallSitesFromLines(lines, symbols, "//");
  return {
    relPath,
    totalLines: lines.length,
    backend: "go-ast",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

// ── 4. Rust (`.rs`) AST Analyzer ──────────────────────────────────────────

export function parseRust(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "//");

  const activeImplStack: Array<{ targetType: string; endLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    while (activeImplStack.length > 0 && i + 1 > activeImplStack[activeImplStack.length - 1]!.endLine) {
      activeImplStack.pop();
    }

    // `use crate::types::{BudgetPolicy, PolicyMode};` or `use super::resolver::resolve_budget;`
    const useMatch = trimmed.match(/^(?:pub\s+)?use\s+([^;]+);/);
    if (useMatch) {
      const spec = useMatch[1]!.trim();
      const braceMatch = spec.match(/^(.+)::\{([^}]+)\}$/);
      if (braceMatch) {
        const mod = braceMatch[1]!;
        const names = braceMatch[2]!
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
          .filter(Boolean);
        imports.push({ module: mod, importedNames: names, line: i + 1, endLine: i + 1, raw: trimmed });
      } else {
        const parts = spec.split("::");
        const last = parts.pop()!.trim();
        const mod = parts.join("::") || spec;
        imports.push({
          module: mod,
          importedNames: [last, "*"],
          line: i + 1,
          endLine: i + 1,
          raw: trimmed,
        });
      }
      continue;
    }

    // `impl<...> [Trait for] TypeName {`
    const implMatch = trimmed.match(/^impl(?:\s*<[^>]*>)?\s+(?:[a-zA-Z0-9_:<>]+\s+for\s+)?([A-Z][a-zA-Z0-9_]*)/);
    if (implMatch) {
      const targetType = implMatch[1]!;
      const { endLine } = findBraceSpan(lines, i);
      activeImplStack.push({ targetType, endLine });
      continue;
    }

    // `[pub] [async] [const] [unsafe] fn name<...>(params...)`
    const fnMatch = raw.match(
      /^(\s*)(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/
    );
    if (fnMatch) {
      const exported = Boolean(fnMatch[2]);
      const name = fnMatch[3]!;
      const paramStr = fnMatch[4] ?? "";
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const rawParams = paramStr
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const filteredParams = rawParams.filter(
        (p) => !/^(&\s*(mut\s+)?)?self\b/.test(p) && !/^mut\s+self\b/.test(p)
      );
      const enclosingImpl = activeImplStack[activeImplStack.length - 1]?.targetType;

      symbols.push({
        name,
        kind: enclosingImpl ? "method" : "function",
        exported: exported || Boolean(enclosingImpl),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        paramsCount: filteredParams.length,
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(enclosingImpl ? { parentClass: enclosingImpl } : {}),
      });
      continue;
    }

    // `[pub] struct / enum / trait / type Name`
    const typeMatch = raw.match(
      /^(\s*)(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+([A-Z][a-zA-Z0-9_]*)/
    );
    if (typeMatch) {
      const exported = Boolean(typeMatch[2]);
      const kw = typeMatch[3]!;
      const name = typeMatch[4]!;
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const kind: SymbolKind =
        kw === "enum" ? "enum" : kw === "struct" ? "struct" : kw === "trait" ? "interface" : "type";
      const rsFields = extractStructFields(rawBlock, ".rs");
      symbols.push({
        name,
        kind,
        exported,
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(rsFields.length > 0 ? { fields: rsFields } : {}),
      });
    }
  }

  const calls = extractCallSitesFromLines(lines, symbols, "//");
  return {
    relPath,
    totalLines: lines.length,
    backend: "rust-ast",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

// ── 5. C / C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`) AST Analyzer ──

const CPP_CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "alignof", "delete", "new",
]);

export function parseCCpp(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "//");

  // Pure prototypes/declarations (`bool Engine::cancel(int id);`) are not call sites.
  const declarationLines = collectCFamilyDeclarationLines(lines);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // `#include "header.h"` or `#include <header>`
    const includeMatch = trimmed.match(/^#\s*include\s+["<]([^">]+)[">]/);
    if (includeMatch) {
      const hdr = includeMatch[1]!;
      const stem = basename(hdr).replace(/\.(h|hpp|hxx|hh)$/i, "");
      imports.push({
        module: hdr,
        importedNames: [stem, "*"],
        line: i + 1,
        endLine: i + 1,
        raw: trimmed,
      });
      continue;
    }

    // `class / struct / enum [class] Name`
    const typeMatch = raw.match(
      /^(\s*)(?:template\s*<[^>]*>\s*)?(class|struct|enum(?:\s+class)?)\s+([A-Z][a-zA-Z0-9_]*)\b[^;]*$/
    );
    if (typeMatch) {
      const kw = typeMatch[2]!;
      const name = typeMatch[3]!;
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const kind: SymbolKind = kw.startsWith("enum")
        ? "enum"
        : kw === "struct"
          ? "struct"
          : "class";
      const cppFields = extractStructFields(rawBlock, ".cpp");
      symbols.push({
        name,
        kind,
        exported: true,
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(cppFields.length > 0 ? { fields: cppFields } : {}),
      });
      continue;
    }

    // `using Name = ...;` or `typedef ... Name;`
    const usingMatch = trimmed.match(/^using\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*(.+);$/);
    if (usingMatch) {
      const name = usingMatch[1]!;
      symbols.push({
        name,
        kind: "type",
        exported: true,
        line: i + 1,
        endLine: i + 1,
        signature: trimmed,
        referencedTypes: extractPascalCaseTypes(trimmed, name),
      });
      continue;
    }

    // C/C++ function or method definition: `[static|inline|virtual|constexpr] RetType [Class::]funcName(params...)`
    if (!trimmed.startsWith("#")) {
      const fnMatch = raw.match(
        /^(\s*)(?:(?:static|inline|virtual|explicit|constexpr|extern)\s+)*[a-zA-Z_][a-zA-Z0-9_:<>,\s*&]*\s+(?:([A-Z][a-zA-Z0-9_]*)::)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:\{|$)/
      );
      if (fnMatch) {
        const classScope = fnMatch[2];
        const name = fnMatch[3]!;
        const paramStr = fnMatch[4] ?? "";
        if (!CPP_CONTROL_KEYWORDS.has(name)) {
          const { endLine, bodyStartLine } = findBraceSpan(lines, i);
          if (bodyStartLine !== undefined || extname(relPath).startsWith(".h")) {
            const rawBlock = lines.slice(i, endLine).join("\n");
            const cleanParamStr = paramStr.trim() === "void" ? "" : paramStr;
            symbols.push({
              name,
              kind: classScope ? "method" : "function",
              exported: true,
              line: i + 1,
              endLine,
              ...(bodyStartLine ? { bodyStartLine } : {}),
              signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
              paramsCount: countTopLevelArgs(cleanParamStr),
              referencedTypes: extractPascalCaseTypes(rawBlock, name),
              ...(classScope ? { parentClass: classScope } : {}),
            });
          }
        }
      }
    }
  }

  const calls = extractCallSitesFromLines(lines, symbols, "//", declarationLines);
  return {
    relPath,
    totalLines: lines.length,
    backend: "cpp-ast",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

// ── 6. C# (`.cs`) AST Analyzer ────────────────────────────────────────────

export function parseCSharp(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "//");

  // Interface/abstract method prototypes (`void Cancel(int id);`) are not call sites.
  const declarationLines = collectCFamilyDeclarationLines(lines);

  const activeClassStack: Array<{ name: string; endLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("[")) continue;

    while (activeClassStack.length > 0 && i + 1 > activeClassStack[activeClassStack.length - 1]!.endLine) {
      activeClassStack.pop();
    }

    // `using Namespace.Sub;`
    const usingMatch = trimmed.match(/^using\s+(?:static\s+)?([a-zA-Z0-9_.]+)\s*;/);
    if (usingMatch) {
      const ns = usingMatch[1]!;
      const last = ns.split(".").pop()!;
      imports.push({
        module: ns,
        importedNames: [last, "*"],
        line: i + 1,
        endLine: i + 1,
        raw: trimmed,
      });
      continue;
    }

    // C# class / interface / struct / record / enum
    const typeMatch = raw.match(
      /^(\s*)(?:(?:public|internal|private|protected|abstract|sealed|static|partial)\s+)*(class|interface|struct|record|enum)\s+([A-Z][a-zA-Z0-9_]*)/
    );
    if (typeMatch) {
      const kw = typeMatch[2]!;
      const name = typeMatch[3]!;
      const { endLine, bodyStartLine } = findBraceSpan(lines, i);
      const rawBlock = lines.slice(i, endLine).join("\n");
      const kind: SymbolKind =
        kw === "enum"
          ? "enum"
          : kw === "struct"
            ? "struct"
            : kw === "interface" || kw === "record"
              ? "interface"
              : "class";
      const csFields = extractStructFields(rawBlock, ".cs");
      symbols.push({
        name,
        kind,
        exported: /\b(public|internal)\b/.test(raw),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
        ...(csFields.length > 0 ? { fields: csFields } : {}),
      });
      if (kw === "class" || kw === "struct" || kw === "record") {
        activeClassStack.push({ name, endLine });
      }
      continue;
    }

    // C# method inside class/struct
    const methodMatch = raw.match(
      /^(\s*)(?:(?:public|internal|private|protected|static|async|virtual|override|abstract)\s+)+([a-zA-Z_][a-zA-Z0-9_<>,.?[\]]*)\s+([A-Z][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/
    );
    if (methodMatch) {
      const retType = methodMatch[2]!;
      const name = methodMatch[3]!;
      const paramStr = methodMatch[4] ?? "";
      const enclosingClass = activeClassStack[activeClassStack.length - 1]?.name;
      if (name !== enclosingClass && !CPP_CONTROL_KEYWORDS.has(name)) {
        const { endLine, bodyStartLine } = findBraceSpan(lines, i);
        const rawBlock = lines.slice(i, endLine).join("\n");
        symbols.push({
          name,
          kind: enclosingClass ? "method" : "function",
          exported: /\b(public|internal)\b/.test(raw),
          line: i + 1,
          endLine,
          ...(bodyStartLine ? { bodyStartLine } : {}),
          signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
          paramsCount: countTopLevelArgs(paramStr),
          returnType: retType,
          referencedTypes: extractPascalCaseTypes(rawBlock, name),
          ...(enclosingClass ? { parentClass: enclosingClass } : {}),
        });
      }
    }
  }

  const calls = extractCallSitesFromLines(lines, symbols, "//", declarationLines);
  return {
    relPath,
    totalLines: lines.length,
    backend: "csharp-ast",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

// ── Fallback Structural Scanner ───────────────────────────────────────────

export function parseWithStructuralScanner(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "//");

  const declPatterns: Array<{ kind: SymbolKind; regex: RegExp }> = [
    { kind: "function", regex: /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s+([a-zA-Z0-9_$]+)\s*[<(]/ },
    { kind: "class", regex: /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+([a-zA-Z0-9_$]+)/ },
    { kind: "interface", regex: /^(\s*)(export\s+)?interface\s+([a-zA-Z0-9_$]+)/ },
    { kind: "type", regex: /^(\s*)(export\s+)?type\s+([a-zA-Z0-9_$]+)\s*(?:<[^>]*>)?\s*=/ },
    { kind: "enum", regex: /^(\s*)(export\s+)?(const\s+)?enum\s+([a-zA-Z0-9_$]+)/ },
    { kind: "function", regex: /^(\s*)(export\s+)?(?:const|let)\s+([a-zA-Z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/ },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const importMatch = trimmed.match(
      /^(?:import|export)\s+(?:type\s+)?(?:(\{[^}]*\}|\*\s+as\s+[a-zA-Z0-9_$]+|[a-zA-Z0-9_$]+)\s+from\s+)?["']([^"']+)["']/
    );
    if (importMatch) {
      const clause = importMatch[1] ?? "";
      const mod = importMatch[2] ?? "";
      const names = clause
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
        .filter(Boolean);
      imports.push({
        module: mod,
        importedNames: names,
        line: i + 1,
        endLine: i + 1,
        raw: trimmed,
      });
      continue;
    }

    for (const { kind, regex } of declPatterns) {
      const m = line.match(regex);
      if (m) {
        const exported = Boolean(m[2]);
        const name = m[m.length - 1]!;
        const { endLine, bodyStartLine } = findBraceSpan(lines, i);
        const rawBlock = lines.slice(i, endLine).join("\n");
        symbols.push({
          name,
          kind,
          exported,
          line: i + 1,
          endLine,
          ...(bodyStartLine ? { bodyStartLine } : {}),
          signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
          referencedTypes: extractPascalCaseTypes(rawBlock, name),
        });
        break;
      }
    }
  }

  const calls = extractCallSitesFromLines(lines, symbols, "//");
  return {
    relPath,
    totalLines: lines.length,
    backend: "structural",
    symbols,
    imports,
    calls,
    syntaxErrors,
  };
}

/**
 * Main entry point: analyze a source file across TypeScript/JS, Python, Go, Rust, C/C++, or C#.
 */
function enrichSymbolFields(relPath: string, content: string, analysis: FileAstAnalysis): FileAstAnalysis {
  const ext = extname(relPath).toLowerCase();
  const lines = content.split(/\r?\n/);
  for (const sym of analysis.symbols) {
    if (!sym.fields && (sym.kind === "interface" || sym.kind === "class" || sym.kind === "struct" || sym.kind === "type")) {
      const rawBlock = lines.slice(sym.line - 1, sym.endLine).join("\n");
      const fields = extractStructFields(rawBlock, ext);
      if (fields.length > 0) sym.fields = fields;
    }
  }
  return analysis;
}

export function analyzeSourceFile(relPath: string, content: string): FileAstAnalysis {
  const ext = extname(relPath).toLowerCase();
  const tsJsExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  if (tsJsExts.includes(ext)) {
    const babelParser = loadBabelParser();
    if (babelParser) {
      return { ...parseWithBabel(relPath, content, babelParser), engine: "babel" };
    }
    return { ...parseWithStructuralScanner(relPath, content), engine: "structural" };
  }

  // True-AST backend when the optional tree-sitter bindings are installed.
  // `GRAPHFLOW_TREE_SITTER=0` forces the structural analyzers (fallback if bindings are absent).
  if (process.env.GRAPHFLOW_TREE_SITTER !== "0" && isTreeSitterAvailable()) {
    const treeSitterResult = analyzeWithTreeSitter(relPath, content);
    if (treeSitterResult) {
      return { ...treeSitterResult, engine: "tree-sitter" };
    }
  }

  if (ext === ".py" || ext === ".pyi") {
    return { ...enrichSymbolFields(relPath, content, parsePython(relPath, content)), engine: "structural" };
  }
  if (ext === ".go") {
    return { ...enrichSymbolFields(relPath, content, parseGo(relPath, content)), engine: "structural" };
  }
  if (ext === ".rs") {
    return { ...enrichSymbolFields(relPath, content, parseRust(relPath, content)), engine: "structural" };
  }
  if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(ext)) {
    return { ...enrichSymbolFields(relPath, content, parseCCpp(relPath, content)), engine: "structural" };
  }
  if (ext === ".cs") {
    return { ...enrichSymbolFields(relPath, content, parseCSharp(relPath, content)), engine: "structural" };
  }
  return { ...parseWithStructuralScanner(relPath, content), engine: "structural" };
}

/**
 * Resolve an import specifier across TS/JS (`./foo.js`), Python (`.types`, `pkg.types`),
 * Rust (`crate::types`, `super::types`), C/C++ (`"types.h"`), Go, or C#.
 */
export function resolveRelativeImportPath(
  rootDir: string,
  fromRelPath: string,
  moduleSpec: string,
  knownFiles?: ReadonlySet<string>
): string | undefined {
  const fromDir = dirname(fromRelPath);
  const ext = extname(fromRelPath).toLowerCase();
  const relCandidates: string[] = [];

  if (ext === ".py" || ext === ".pyi") {
    // Python relative `.foo` or dotted `src.foo`
    const leadingDots = moduleSpec.match(/^\.+/)?.[0]?.length ?? 0;
    const cleanMod = moduleSpec.replace(/^\.+/, "").replace(/\./g, "/");
    if (leadingDots > 0) {
      let baseDir = fromDir;
      for (let d = 1; d < leadingDots; d++) baseDir = dirname(baseDir);
      const joined = (baseDir === "." ? cleanMod : join(baseDir, cleanMod)).replace(/\\/g, "/");
      relCandidates.push(`${joined}.py`, `${joined}/__init__.py`);
    } else if (cleanMod) {
      const sameDir = (fromDir === "." ? cleanMod : join(fromDir, cleanMod)).replace(/\\/g, "/");
      relCandidates.push(`${sameDir}.py`, `${cleanMod}.py`, `src/${cleanMod}.py`, `${cleanMod}/__init__.py`);
    }
  } else if (ext === ".rs") {
    const cleanRust = moduleSpec
      .replace(/^(crate|super|self)::/, "")
      .replace(/::/g, "/");
    const sameDir = (fromDir === "." ? cleanRust : join(fromDir, cleanRust)).replace(/\\/g, "/");
    relCandidates.push(
      `${sameDir}.rs`,
      `src/${cleanRust}.rs`,
      `${cleanRust}.rs`,
      `src/${cleanRust}/mod.rs`
    );
  } else if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(ext)) {
    const sameDir = (fromDir === "." ? moduleSpec : join(fromDir, moduleSpec)).replace(/\\/g, "/");
    relCandidates.push(sameDir, moduleSpec, `include/${moduleSpec}`, `src/${moduleSpec}`);
  } else if (moduleSpec.startsWith(".")) {
    const baseRel = (fromDir === "." ? moduleSpec : join(fromDir, moduleSpec)).replace(/\\/g, "/");
    if (!baseRel.startsWith("..")) {
      const stripped = baseRel.replace(/\.(js|mjs|cjs)$/i, "");
      relCandidates.push(
        baseRel,
        `${stripped}.ts`,
        `${stripped}.tsx`,
        `${stripped}.js`,
        `${stripped}.mjs`,
        `${stripped}/index.ts`,
        `${stripped}/index.js`
      );
    }
  }

  if (knownFiles) {
    for (const rel of relCandidates) {
      if (knownFiles.has(rel)) return rel;
    }
    return undefined;
  }
  for (const rel of relCandidates) {
    if (existsSync(join(rootDir, rel))) return rel;
  }
  return undefined;
}
