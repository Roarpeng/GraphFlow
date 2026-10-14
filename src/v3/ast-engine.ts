/**
 * GraphFlow 3.0 — Multi-Language Surgical AST Engine
 *
 * First-class AST & structural extraction for 6 language families:
 *   1. TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) via `@babel/parser`
 *   2. Python (`.py`, `.pyi`) via indentation-scoped AST analyzer
 *   3. Go (`.go`) via receiver/func/struct/interface AST analyzer
 *   4. Rust (`.rs`) via fn/impl/struct/enum/trait AST analyzer
 *   5. C / C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`, `.hxx`) via preprocessor & declaration AST analyzer
 *   6. C# (`.cs`) via namespace/class/interface/struct/method AST analyzer
 *
 * Extracts for all languages:
 *   - Symbols (`function`, `class`, `method`, `interface`, `type`, `enum`, `variable`)
 *     with exact 1-based `line` and `endLine`, `signature`, `exported`, `paramsCount`,
 *     and `referencedTypes` (for automatic Cross-File Type-Closure Slicing).
 *   - Imports (`module`, `importedNames`, `line`, `endLine`)
 *   - Calls (`caller`, `callee`, `line`, `argsCount`) for Blast-Radius Call-Site Slicing.
 *   - Syntax diagnostics (`syntaxErrors`) for zero-LLM static guard verification.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const requireFn = createRequire(__filename);

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable";

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
}

export interface FileAstAnalysis {
  relPath: string;
  totalLines: number;
  backend: AstBackend;
  symbols: AstSymbol[];
  imports: AstImport[];
  calls: AstCallSite[];
  syntaxErrors: Array<{ line: number; column?: number; message: string }>;
}

export const SUPPORTED_SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx",
  ".cs",
]);

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
  const lines = rawBlock.split(/\r?\n/).slice(1); // skip header line
  const fields = new Set<string>();
  const cleanExt = ext.toLowerCase();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    if (trimmed === "}" || trimmed === "};") continue;

    if (cleanExt === ".py" || cleanExt === ".pyi") {
      if (trimmed.startsWith("def ") || trimmed.startsWith("async def ") || trimmed.startsWith("@")) break;
      const m = rawLine.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (m && m[1] !== "self" && m[1] !== "cls") fields.add(m[1]!);
    } else if (cleanExt === ".go") {
      const m = rawLine.match(/^\s+([A-Z][a-zA-Z0-9_]*)\s+[a-zA-Z0-9_*[\].]+/);
      if (m) fields.add(m[1]!);
    } else if (cleanExt === ".rs") {
      const m = rawLine.match(/^\s+(?:pub(?:\([^)]*\))?\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (m) fields.add(m[1]!);
    } else if (cleanExt === ".cs") {
      const m = rawLine.match(/^\s+(?:public|internal)\s+[^\s()]+\s+([A-Z][a-zA-Z0-9_]*)\s*\{\s*get;/);
      if (m) fields.add(m[1]!);
    } else if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(cleanExt)) {
      if (trimmed.includes("(")) continue;
      const m = trimmed.match(/^(?:const\s+)?[a-zA-Z_][a-zA-Z0-9_:<>,*&\s]*\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=\s*[^;]+)?;/);
      if (m && !["public", "private", "protected", "return", "using", "typedef"].includes(m[1]!)) {
        fields.add(m[1]!);
      }
    } else {
      // TS/JS interface/type/class property
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

function stripLineCommentsAndStrings(line: string, commentPrefix = "//"): string {
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

function extractCallSitesFromLines(
  lines: string[],
  symbols: AstSymbol[],
  commentPrefix: "//" | "#" = "//"
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

    for (const m of stripped.matchAll(callRe)) {
      const callee = m[1]!;
      if (NON_CALL_KEYWORDS.has(callee)) continue;
      const matchIdx = m.index ?? 0;

      // Skip if this is the function declaration header itself
      if (declLines.has(lineNum)) {
        const before = stripped.slice(0, matchIdx).trim();
        if (
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
      calls.push({
        ...(caller ? { caller } : {}),
        callee,
        line: lineNum,
        argsCount,
      });
    }
  }
  return calls;
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
      if (callee?.type === "Identifier") {
        calleeName = callee.name;
      } else if (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") {
        calleeName = callee.property?.name;
      }
      if (calleeName && calleeName !== "require" && calleeName !== "import") {
        calls.push({
          ...(currentCaller ? { caller: currentCaller } : {}),
          callee: calleeName,
          line: node.loc?.start?.line ?? 1,
          argsCount: Array.isArray(node.arguments) ? node.arguments.length : 0,
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

export function parsePython(relPath: string, content: string): FileAstAnalysis {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const syntaxErrors = checkBraceBalanceSyntax(lines, "#");

  // Track multiline triple-quoted strings so indentation inside docstrings is ignored
  const inMultilineString = new Array<boolean>(lines.length).fill(false);
  let activeTriple: '"""' | "'''" | null = null;
  for (let i = 0; i < lines.length; i++) {
    inMultilineString[i] = activeTriple !== null;
    const raw = lines[i] ?? "";
    let j = 0;
    while (j < raw.length) {
      if (!activeTriple && raw[j] === "#") break;
      const sub3 = raw.slice(j, j + 3);
      if (sub3 === '"""' || sub3 === "'''") {
        if (activeTriple === sub3) activeTriple = null;
        else if (!activeTriple) activeTriple = sub3;
        j += 3;
        continue;
      }
      j += 1;
    }
  }
  if (activeTriple !== null) {
    syntaxErrors.push({
      line: lines.length,
      message: `Unclosed triple-quoted string (${activeTriple})`,
    });
  }

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

      symbols.push({
        name,
        kind,
        exported: !name.startsWith("_"),
        line: startLine,
        endLine,
        bodyStartLine: headerEnd,
        signature: lines[i]!.trim(),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
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

      // Syntax check: ensure header ends with `:` and body is non-empty
      if (!headerText.trimEnd().endsWith(":")) {
        syntaxErrors.push({
          line: headerEnd,
          message: `Python function '${name}' header missing ':'`,
        });
      } else if (endLine <= headerEnd && !headerText.replace(/^.*:\s*/, "").trim()) {
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
        kindKw === "interface" || kindKw === "struct" ? "interface" : "type";
      symbols.push({
        name,
        kind,
        exported: /^[A-Z]/.test(name),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
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
        kw === "enum" ? "enum" : kw === "trait" || kw === "struct" ? "interface" : "type";
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
          ? "interface"
          : "class";
      symbols.push({
        name,
        kind,
        exported: true,
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
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

  const calls = extractCallSitesFromLines(lines, symbols, "//");
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
          : kw === "interface" || kw === "struct" || kw === "record"
            ? "interface"
            : "class";
      symbols.push({
        name,
        kind,
        exported: /\b(public|internal)\b/.test(raw),
        line: i + 1,
        endLine,
        ...(bodyStartLine ? { bodyStartLine } : {}),
        signature: cleanSignatureHeader(lines, i + 1, bodyStartLine ?? endLine),
        referencedTypes: extractPascalCaseTypes(rawBlock, name),
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

  const calls = extractCallSitesFromLines(lines, symbols, "//");
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
    if (!sym.fields && (sym.kind === "interface" || sym.kind === "class" || sym.kind === "type")) {
      const rawBlock = lines.slice(sym.line - 1, sym.endLine).join("\n");
      const fields = extractStructFields(rawBlock, ext);
      if (fields.length > 0) sym.fields = fields;
    }
  }
  return analysis;
}

export function analyzeSourceFile(relPath: string, content: string): FileAstAnalysis {
  const ext = extname(relPath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const babelParser = loadBabelParser();
    if (babelParser) {
      return parseWithBabel(relPath, content, babelParser);
    }
    return parseWithStructuralScanner(relPath, content);
  }
  if (ext === ".py" || ext === ".pyi") {
    return enrichSymbolFields(relPath, content, parsePython(relPath, content));
  }
  if (ext === ".go") {
    return enrichSymbolFields(relPath, content, parseGo(relPath, content));
  }
  if (ext === ".rs") {
    return enrichSymbolFields(relPath, content, parseRust(relPath, content));
  }
  if ([".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(ext)) {
    return enrichSymbolFields(relPath, content, parseCCpp(relPath, content));
  }
  if (ext === ".cs") {
    return enrichSymbolFields(relPath, content, parseCSharp(relPath, content));
  }
  return parseWithStructuralScanner(relPath, content);
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
