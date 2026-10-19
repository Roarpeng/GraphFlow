/**
 * GraphFlow 3.3.5 — Optional tree-sitter TRUE-AST backend (`src/tree-sitter-engine.ts`)
 *
 * Opt-in backend for the 5 non-TS/JS language families:
 *   Python (.py/.pyi), Go (.go), Rust (.rs), C/C++ (.c/.h/.cc/.cpp/.hpp/.cxx/.hxx), C# (.cs).
 *
 * Enabled via `GRAPHFLOW_TREE_SITTER=1` (see `analyzeSourceFile` in ast-engine.ts). This module
 * is deliberately dependency-isolated: tree-sitter + grammar packages are lazy `require`d and a
 * missing native binding simply makes the backend unavailable (callers fall back to the
 * structural analyzers). It only type-imports ast-engine to avoid a runtime import cycle.
 *
 * The CST -> `FileAstAnalysis` mapping mirrors the structural analyzers' public shape exactly:
 * symbols (name/kind/exported/line/endLine/signature/paramsCount/referencedTypes/fields/
 * parentClass), imports, calls (callee/receiver/member/argsCount/caller/isDeclaration) and
 * syntaxErrors from ERROR/MISSING nodes. It is a best-effort mapping, not a semantic model.
 */

import { createRequire } from "node:module";
import { basename, extname } from "node:path";
import type {
  AstBackend,
  AstCallSite,
  AstImport,
  AstSymbol,
  FileAstAnalysis,
  SymbolKind,
} from "./ast-engine.js";

const requireFn = createRequire(__filename);

// ── tree-sitter node typings (structural subset used by this mapping) ────────

interface TsPoint {
  row: number;
  column: number;
}

interface TsNode {
  type: string;
  isMissing: boolean;
  hasError: boolean;
  startIndex: number;
  endIndex: number;
  startPosition: TsPoint;
  endPosition: TsPoint;
  namedChildren: TsNode[];
  children: TsNode[];
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(language: unknown): void;
  parse(input: string): TsTree;
}

interface TsParserCtor {
  new (): TsParser;
}

/** Language families handled by the optional tree-sitter backend (C and C++ are distinct grammars). */
export type TreeSitterFamily = "python" | "go" | "rust" | "c" | "cpp" | "csharp";

const GRAMMAR_MODULES: Record<TreeSitterFamily, string> = {
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  rust: "tree-sitter-rust",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  csharp: "tree-sitter-c-sharp",
};

const FAMILY_BACKEND: Record<TreeSitterFamily, AstBackend> = {
  python: "python-ast",
  go: "go-ast",
  rust: "rust-ast",
  c: "cpp-ast",
  cpp: "cpp-ast",
  csharp: "csharp-ast",
};

let cachedParserCtor: TsParserCtor | null | undefined;
const grammarCache = new Map<TreeSitterFamily, unknown | null>();
const parserCache = new Map<TreeSitterFamily, TsParser | undefined>();

function loadParserCtor(): TsParserCtor | null {
  if (cachedParserCtor !== undefined) return cachedParserCtor;
  try {
    const loaded: unknown = requireFn("tree-sitter");
    if (typeof loaded === "function") {
      cachedParserCtor = loaded as TsParserCtor;
    } else if (loaded && typeof loaded === "object") {
      const holder = loaded as { Parser?: TsParserCtor; default?: TsParserCtor };
      cachedParserCtor = holder.Parser ?? holder.default ?? null;
    } else {
      cachedParserCtor = null;
    }
  } catch {
    cachedParserCtor = null;
  }
  return cachedParserCtor;
}

function loadGrammar(family: TreeSitterFamily): unknown | null {
  if (grammarCache.has(family)) return grammarCache.get(family) ?? null;
  let grammar: unknown | null = null;
  try {
    grammar = requireFn(GRAMMAR_MODULES[family]) as unknown;
  } catch {
    grammar = null;
  }
  grammarCache.set(family, grammar);
  return grammar;
}

function getParser(family: TreeSitterFamily): TsParser | undefined {
  if (parserCache.has(family)) return parserCache.get(family);
  const ctor = loadParserCtor();
  const grammar = loadGrammar(family);
  if (!ctor || !grammar) {
    parserCache.set(family, undefined);
    return undefined;
  }
  try {
    const parser = new ctor();
    parser.setLanguage(grammar);
    parserCache.set(family, parser);
    return parser;
  } catch {
    parserCache.set(family, undefined);
    return undefined;
  }
}

/** True when the tree-sitter core and every supported grammar package loads successfully. */
export function isTreeSitterAvailable(): boolean {
  if (!loadParserCtor()) return false;
  return (Object.keys(GRAMMAR_MODULES) as TreeSitterFamily[]).every(
    (family) => loadGrammar(family) !== null
  );
}

export function treeSitterFamilyForPath(relPath: string): TreeSitterFamily | undefined {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".py" || ext === ".pyi") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".c") return "c";
  if (ext === ".h") return "cpp"; // C++ grammar is a mostly-superset; C headers fall back below.
  if ([".cc", ".cpp", ".hpp", ".cxx", ".hxx"].includes(ext)) return "cpp";
  if (ext === ".cs") return "csharp";
  return undefined;
}

// ── Shared context/helpers ───────────────────────────────────────────────────

interface AnalysisContext {
  relPath: string;
  content: string;
  family: TreeSitterFamily;
  lines: string[];
  symbols: AstSymbol[];
  imports: AstImport[];
  calls: AstCallSite[];
  syntaxErrors: Array<{ line: number; column?: number; message: string }>;
  /** Symbols created from declarations/prototypes (dropped when a same-file definition exists). */
  prototypes: Set<AstSymbol>;
  /** Synthetic declaration call sites (C/C++ prototype parity with the structural analyzer). */
  declarationCalls: AstCallSite[];
}

interface PushSymbolOptions {
  name: string | undefined;
  kind: SymbolKind;
  exported: boolean;
  node: TsNode;
  startNode?: TsNode | undefined;
  bodyNode?: TsNode | undefined;
  paramsCount?: number | undefined;
  returnType?: string | undefined;
  parentClass?: string | undefined;
  fields?: string[] | undefined;
  prototype?: boolean | undefined;
}

function textOf(ctx: AnalysisContext, node: TsNode | null | undefined): string {
  if (!node) return "";
  return ctx.content.slice(node.startIndex, node.endIndex);
}

function nameOf(ctx: AnalysisContext, node: TsNode | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = textOf(ctx, node).trim();
  return text || undefined;
}

function lastPathSegment(text: string): string {
  const parts = text
    .trim()
    .split(/::|\.|->/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? text.trim();
}

/** Normalizes a type expression to a bare type name (`*pkg.Service[T]` -> `Service`). */
function cleanTypeName(text: string): string {
  const withoutGenerics = text.trim().replace(/<[\s\S]*$/, "").replace(/\[[\s\S]*$/, "");
  const withoutPointers = withoutGenerics.replace(/^[\s*&]+/, "");
  return lastPathSegment(withoutPointers);
}

function nodeLine(node: TsNode): number {
  return node.startPosition.row + 1;
}

function nodeEndLine(node: TsNode): number {
  return node.endPosition.row + 1;
}

function signatureOf(ctx: AnalysisContext, node: TsNode, bodyNode?: TsNode): string {
  const startLine = node.startPosition.row;
  const bodyLine = bodyNode ? bodyNode.startPosition.row : node.endPosition.row;
  const endLine = Math.min(ctx.lines.length - 1, bodyLine, startLine + 4);
  let joined = ctx.lines
    .slice(startLine, endLine + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const brace = joined.indexOf("{");
  if (brace > 0) joined = joined.slice(0, brace).trim();
  return joined.slice(0, 220);
}

function walkNodes(node: TsNode, visit: (node: TsNode, ancestors: TsNode[]) => void): void {
  const ancestors: TsNode[] = [];
  const visitRec = (current: TsNode): void => {
    visit(current, ancestors);
    ancestors.push(current);
    for (const child of current.namedChildren) visitRec(child);
    ancestors.pop();
  };
  visitRec(node);
}

function countArguments(node: TsNode | null | undefined): number {
  if (!node) return 0;
  return node.namedChildren.filter((child) => child.type !== "comment").length;
}

function identifierText(ctx: AnalysisContext, node: TsNode | null | undefined): string | undefined {
  if (!node) return undefined;
  const direct = nameOf(ctx, node);
  if (direct && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(direct)) return direct;
  if (node.type === "generic_name" || node.type === "generic_function") {
    for (const child of node.namedChildren) {
      const found = identifierText(ctx, child);
      if (found && child.type !== "type_argument_list") return found;
    }
  }
  if (node.type === "qualified_identifier" || node.type === "scoped_identifier") {
    const nameChild = node.childForFieldName("name");
    if (nameChild) return identifierText(ctx, nameChild);
  }
  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "field_identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier" ||
      child.type === "namespace_identifier"
    ) {
      return nameOf(ctx, child);
    }
  }
  return undefined;
}

const BUILTIN_TYPE_NAMES = new Set([
  "Array", "ReadonlyArray", "Promise", "Record", "Partial", "Map", "Set", "WeakMap", "Date",
  "RegExp", "Error", "TypeError", "String", "Number", "Boolean", "Object", "Function", "Symbol",
  "BigInt", "Buffer", "Uint8Array", "Optional", "Union", "List", "Dict", "Tuple", "Sequence",
  "Mapping", "Callable", "Any", "Literal", "Final", "ClassVar", "TypeVar", "Generic", "Protocol",
  "TypedDict", "NamedTuple", "Self", "None", "True", "False", "Exception", "ValueError", "RuntimeError", "KeyError",
  "Option", "Result", "Vec", "Box", "Rc", "Arc", "RefCell", "Mutex", "RwLock", "HashMap", "HashSet",
  "BTreeMap", "BTreeSet", "Cow", "Pin", "PhantomData", "Some", "Ok", "Err", "Default", "Clone",
  "Copy", "Debug", "Display", "Send", "Sync", "Context", "WaitGroup", "Reader", "Writer", "Task",
  "IEnumerable", "IList", "IDictionary", "IReadOnlyList", "CancellationToken", "Action", "Func",
  "Guid", "DateTime", "TimeSpan", "StringBuilder", "ILogger", "IService",
]);

function collectReferencedTypes(rawText: string, selfName?: string): string[] {
  const matches = rawText.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  const out = new Set<string>();
  for (const match of matches) {
    if (match === selfName) continue;
    if (BUILTIN_TYPE_NAMES.has(match)) continue;
    if (/^[A-Z0-9_]+$/.test(match) && match.length > 2) continue;
    if (match.length <= 1) continue;
    out.add(match);
  }
  return Array.from(out);
}

function pushSymbol(ctx: AnalysisContext, options: PushSymbolOptions): AstSymbol | undefined {
  if (!options.name) return undefined;
  const name = options.name;
  const startNode = options.startNode ?? options.node;
  const rawText = textOf(ctx, options.node);
  const line = nodeLine(startNode);
  const endLine = nodeEndLine(options.node);
  const bodyStartLine = options.bodyNode
    ? options.bodyNode.startPosition.row + 1
    : options.node.endPosition.row > options.node.startPosition.row
      ? options.node.startPosition.row + 2
      : undefined;
  const referencedTypes = collectReferencedTypes(rawText, name);
  const symbol: AstSymbol = {
    name,
    kind: options.kind,
    exported: options.exported,
    line,
    endLine,
    signature: signatureOf(ctx, options.node, options.bodyNode),
    referencedTypes,
    ...(bodyStartLine !== undefined ? { bodyStartLine } : {}),
    ...(options.paramsCount !== undefined ? { paramsCount: options.paramsCount } : {}),
    ...(options.returnType ? { returnType: options.returnType } : {}),
    ...(options.fields && options.fields.length > 0 ? { fields: Array.from(new Set(options.fields)) } : {}),
    ...(options.parentClass ? { parentClass: options.parentClass } : {}),
  };
  ctx.symbols.push(symbol);
  if (options.prototype) ctx.prototypes.add(symbol);
  return symbol;
}

function findEnclosingCaller(symbols: AstSymbol[], line: number): string | undefined {
  let best: AstSymbol | undefined;
  for (const symbol of symbols) {
    if (symbol.kind !== "function" && symbol.kind !== "method") continue;
    if (line >= symbol.line && line <= symbol.endLine) {
      if (!best || symbol.endLine - symbol.line < best.endLine - best.line) best = symbol;
    }
  }
  return best?.name;
}

function findChildOfType(node: TsNode | null | undefined, type: string): TsNode | undefined {
  if (!node) return undefined;
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
    const nested = findChildOfType(child, type);
    if (nested) return nested;
  }
  return undefined;
}

// ── Imports ─────────────────────────────────────────────────────────────────

function makeImport(
  ctx: AnalysisContext,
  node: TsNode,
  module: string,
  importedNames: string[],
  rawNode?: TsNode
): AstImport {
  return {
    module,
    importedNames,
    line: nodeLine(node),
    endLine: nodeEndLine(node),
    raw: (textOf(ctx, rawNode ?? node).replace(/\s+/g, " ").trim() || module).slice(0, 240),
  };
}

function parsePythonImports(ctx: AnalysisContext, node: TsNode): void {
  const raw = textOf(ctx, node).trim();
  if (node.type === "import_from_statement") {
    const match = raw.match(/^from\s+([\w.]+)\s+import\s+\(?([\s\S]*?)\)?$/);
    if (!match) return;
    const module = match[1] ?? raw;
    const names = (match[2] ?? "")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim().replace(/[()]/g, "") ?? "")
      .filter(Boolean);
    ctx.imports.push(makeImport(ctx, node, module, names));
    return;
  }
  if (node.type === "import_statement") {
    const specs = raw
      .replace(/^import\s+/, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const spec of specs) {
      const module = spec.split(/\s+as\s+/)[0]?.trim() ?? spec;
      const short = module.split(".").pop() ?? module;
      ctx.imports.push(makeImport(ctx, node, module, [short, "*"], node));
    }
  }
}

function parseGoImports(ctx: AnalysisContext, node: TsNode): void {
  const specs =
    node.type === "import_spec" ? [node] : node.namedChildren.filter((child) => child.type === "import_spec");
  for (const spec of specs) {
    const raw = textOf(ctx, spec).trim();
    const match = raw.match(/^(?:([A-Za-z_][\w]*|\.|_)\s+)?"([^"]+)"/);
    if (!match) continue;
    const pkgPath = match[2] ?? raw;
    const pkgShort = match[1] ?? pkgPath.split("/").filter(Boolean).pop() ?? pkgPath;
    ctx.imports.push(makeImport(ctx, spec, pkgPath, [pkgShort, "*"], spec));
  }
}

function parseRustImports(ctx: AnalysisContext, node: TsNode): void {
  let spec = textOf(ctx, node).trim();
  spec = spec.replace(/^(?:pub(?:\([^)]*\))?\s+)?use\s+/, "").replace(/;\s*$/, "").trim();
  if (!spec) return;
  const braceMatch = spec.match(/^(.+?)::\{(.+)\}$/);
  if (braceMatch) {
    const module = braceMatch[1]!.trim();
    const names = braceMatch[2]!
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter(Boolean);
    ctx.imports.push(makeImport(ctx, node, module, names));
    return;
  }
  const parts = spec.split("::").map((part) => part.trim()).filter(Boolean);
  const last = parts.pop() ?? spec;
  const module = parts.join("::") || spec;
  ctx.imports.push(makeImport(ctx, node, module, [last, "*"]));
}

function parseCInclude(ctx: AnalysisContext, node: TsNode): void {
  const pathNode = node.childForFieldName("path");
  const rawPath = textOf(ctx, pathNode ?? node).trim();
  const header = rawPath.replace(/^["<]|[">]$/g, "").trim();
  if (!header) return;
  const stem = basename(header).replace(/\.(h|hpp|hxx|hh)$/i, "");
  ctx.imports.push(makeImport(ctx, node, header, [stem, "*"]));
}

function parseCSharpUsing(ctx: AnalysisContext, node: TsNode): void {
  let spec = textOf(ctx, node).trim();
  spec = spec.replace(/^global\s+/, "").replace(/^using\s+/, "").replace(/;\s*$/, "").trim();
  const aliasMatch = spec.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
  if (aliasMatch) {
    const alias = aliasMatch[1]!;
    const target = aliasMatch[2]!.trim();
    const last = target.split(".").pop() ?? target;
    ctx.imports.push(makeImport(ctx, node, target, [last, alias, "*"]));
    return;
  }
  if (spec.startsWith("static ")) spec = spec.slice("static ".length).trim();
  if (!spec) return;
  const last = spec.split(".").filter(Boolean).pop() ?? spec;
  ctx.imports.push(makeImport(ctx, node, spec, [last, "*"]));
}

// ── Calls ───────────────────────────────────────────────────────────────────

interface ParsedCall {
  callee: string;
  receiver?: string;
  member: boolean;
  argsCount: number;
}

function isCallInDeclarationHeader(ancestors: TsNode[]): boolean {
  for (const ancestor of ancestors) {
    if (
      ancestor.type === "function_definition" ||
      ancestor.type === "method_declaration" ||
      ancestor.type === "function_declaration" ||
      ancestor.type === "declaration" ||
      ancestor.type === "field_declaration" ||
      ancestor.type === "abstract_method_declaration"
    ) {
      const body = ancestor.childForFieldName("body");
      if (!body) return true;
    }
  }
  return false;
}

function receiverLeaf(ctx: AnalysisContext, node: TsNode | null | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "identifier":
    case "field_identifier":
    case "type_identifier":
    case "property_identifier":
    case "namespace_identifier":
    case "self":
    case "super":
      return nameOf(ctx, node);
    case "this_expression":
      return "this";
    case "self_expression":
      return "self";
    case "base_expression":
      return "base";
    case "member_access_expression":
    case "field_expression":
    case "selector_expression":
    case "attribute": {
      const fieldNode =
        node.childForFieldName("field") ??
        node.childForFieldName("name") ??
        node.childForFieldName("attribute");
      return receiverLeaf(ctx, fieldNode);
    }
    default: {
      const text = textOf(ctx, node).trim();
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined;
    }
  }
}

function pythonReceiverName(ctx: AnalysisContext, object: TsNode | null | undefined): string | undefined {
  if (!object) return undefined;
  // `super().method()` / `super(A, self).method()`: the receiver is the base-class view.
  if (object.type === "call") {
    const innerFn = object.childForFieldName("function");
    if (innerFn?.type === "identifier" && nameOf(ctx, innerFn) === "super") return "super";
    return undefined;
  }
  return receiverLeaf(ctx, object);
}

function parsePythonCall(ctx: AnalysisContext, node: TsNode): ParsedCall | undefined {
  const fn = node.childForFieldName("function");
  if (!fn) return undefined;
  const args = node.childForFieldName("arguments");
  if (fn.type === "identifier") {
    const callee = nameOf(ctx, fn);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  if (fn.type === "attribute") {
    const attr = fn.childForFieldName("attribute");
    const object = fn.childForFieldName("object");
    const callee = nameOf(ctx, attr);
    if (!callee) return undefined;
    const receiver = pythonReceiverName(ctx, object);
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  return undefined;
}

function parseGoCall(ctx: AnalysisContext, node: TsNode): ParsedCall | undefined {
  const fn = node.childForFieldName("function");
  if (!fn) return undefined;
  const args = node.childForFieldName("arguments");
  if (fn.type === "identifier") {
    const callee = nameOf(ctx, fn);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  if (fn.type === "selector_expression") {
    const field = fn.childForFieldName("field");
    const operand = fn.childForFieldName("operand");
    const callee = nameOf(ctx, field);
    if (!callee) return undefined;
    const receiver = receiverLeaf(ctx, operand);
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  if (fn.type === "parenthesized_expression") {
    return undefined;
  }
  const callee = identifierText(ctx, fn);
  return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
}

function parseRustCall(ctx: AnalysisContext, node: TsNode): ParsedCall | undefined {
  const fn = node.childForFieldName("function");
  if (!fn) return undefined;
  const args = node.childForFieldName("arguments");
  if (fn.type === "identifier") {
    const callee = nameOf(ctx, fn);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  if (fn.type === "field_expression") {
    const field = fn.childForFieldName("field");
    const value = fn.childForFieldName("value");
    const callee = nameOf(ctx, field);
    if (!callee) return undefined;
    const receiver = receiverLeaf(ctx, value);
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  if (fn.type === "scoped_identifier") {
    const nameNode = fn.childForFieldName("name");
    const pathNode = fn.childForFieldName("path");
    const callee = nameOf(ctx, nameNode);
    if (!callee) return undefined;
    const receiver = lastPathSegment(textOf(ctx, pathNode)) || undefined;
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  if (fn.type === "generic_function") {
    const inner = fn.childForFieldName("function") ?? fn.namedChildren[0];
    const callee = identifierText(ctx, inner);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  return undefined;
}

function parseCCall(ctx: AnalysisContext, node: TsNode): ParsedCall | undefined {
  const fn = node.childForFieldName("function");
  if (!fn) return undefined;
  const args = node.childForFieldName("arguments");
  if (fn.type === "identifier") {
    const callee = nameOf(ctx, fn);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  if (fn.type === "field_expression") {
    const field = fn.childForFieldName("field");
    const argument = fn.childForFieldName("argument");
    const callee = nameOf(ctx, field);
    if (!callee) return undefined;
    const receiver = receiverLeaf(ctx, argument);
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  if (fn.type === "qualified_identifier") {
    const nameNode = fn.childForFieldName("name");
    const scopeNode = fn.childForFieldName("scope");
    const callee = nameOf(ctx, nameNode);
    if (!callee) return undefined;
    const receiver = lastPathSegment(textOf(ctx, scopeNode)) || undefined;
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  if (fn.type === "template_function") {
    const inner = fn.childForFieldName("name") ?? fn.namedChildren[0];
    const callee = identifierText(ctx, inner);
    if (!callee) return undefined;
    const argsNode = node.childForFieldName("arguments") ?? findChildOfType(node, "argument_list");
    return { callee, member: false, argsCount: countArguments(argsNode) };
  }
  const callee = identifierText(ctx, fn);
  return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
}

function parseCSharpCall(ctx: AnalysisContext, node: TsNode): ParsedCall | undefined {
  if (node.type === "object_creation_expression") {
    const typeNode = node.childForFieldName("type");
    const callee = identifierText(ctx, typeNode);
    if (!callee) return undefined;
    const args = findChildOfType(node, "argument_list");
    return { callee, member: false, argsCount: countArguments(args) };
  }
  const fn = node.childForFieldName("function");
  if (!fn) return undefined;
  const args = findChildOfType(node, "argument_list");
  if (fn.type === "identifier" || fn.type === "generic_name") {
    const callee = identifierText(ctx, fn);
    return callee ? { callee, member: false, argsCount: countArguments(args) } : undefined;
  }
  if (fn.type === "member_access_expression") {
    const nameNode = fn.childForFieldName("name") ?? fn.childForFieldName("member");
    const expression = fn.childForFieldName("expression") ?? fn.childForFieldName("receiver");
    const callee = nameOf(ctx, nameNode);
    if (!callee) return undefined;
    const receiver = receiverLeaf(ctx, expression);
    return { callee, member: true, argsCount: countArguments(args), ...(receiver ? { receiver } : {}) };
  }
  return undefined;
}

function parseCallNode(
  ctx: AnalysisContext,
  node: TsNode
): ParsedCall | undefined {
  switch (ctx.family) {
    case "python":
      return node.type === "call" ? parsePythonCall(ctx, node) : undefined;
    case "go":
      return node.type === "call_expression" ? parseGoCall(ctx, node) : undefined;
    case "rust":
      return node.type === "call_expression" ? parseRustCall(ctx, node) : undefined;
    case "c":
    case "cpp":
      return node.type === "call_expression" ? parseCCall(ctx, node) : undefined;
    case "csharp":
      return node.type === "invocation_expression" || node.type === "object_creation_expression"
        ? parseCSharpCall(ctx, node)
        : undefined;
  }
}

/**
 * Tree-sitter does not emit `call_expression` nodes for tokens nested inside a
 * Rust macro (`format!("{}={}", device.id(), device.read())`). Scan the macro
 * token text for `receiver.method(` so `impl Trait` calls inside macros still
 * reach blast radius. Direct calls already recorded by `collectCalls` win.
 */
function collectRustMacroMethodCalls(ctx: AnalysisContext, root: TsNode): void {
  const methodRe = /\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
  walkNodes(root, (node) => {
    if (node.type !== "macro_invocation") return;
    const text = textOf(ctx, node);
    const baseLine = nodeLine(node);
    const macroLines = text.split(/\r?\n/);
    for (let offset = 0; offset < macroLines.length; offset++) {
      const code = (macroLines[offset] ?? "").replace(/\b[A-Za-z_]\w*\s*!/g, " ");
      methodRe.lastIndex = 0;
      for (const match of code.matchAll(methodRe)) {
        const receiver = match[1];
        const callee = match[2];
        if (!receiver || !callee) continue;
        const lineNo = baseLine + offset;
        const duplicate = ctx.calls.some(
          (existing) =>
            existing.line === lineNo &&
            existing.callee === callee &&
            (existing.receiver ?? "") === receiver
        );
        if (duplicate) continue;
        const caller = findEnclosingCaller(ctx.symbols, lineNo);
        ctx.calls.push({
          callee,
          line: lineNo,
          argsCount: 0,
          ...(caller ? { caller } : {}),
          receiver,
          member: true,
        });
      }
    }
  });
}

function collectCalls(ctx: AnalysisContext, root: TsNode): void {
  walkNodes(root, (node, ancestors) => {
    const parsed = parseCallNode(ctx, node);
    if (!parsed) return;
    const line = nodeLine(node);
    const caller = findEnclosingCaller(ctx.symbols, line);
    const isDeclaration =
      (ctx.family === "c" || ctx.family === "cpp" || ctx.family === "csharp") &&
      isCallInDeclarationHeader(ancestors);
    ctx.calls.push({
      callee: parsed.callee,
      line,
      argsCount: parsed.argsCount,
      ...(caller ? { caller } : {}),
      ...(parsed.receiver ? { receiver: parsed.receiver } : {}),
      ...(parsed.member ? { member: true } : {}),
      ...(isDeclaration ? { isDeclaration: true } : {}),
    });
  });
}

interface DeclarationCallInfo {
  callee: string;
  line: number;
  argsCount: number;
  receiver?: string | undefined;
  member?: boolean | undefined;
}

/**
 * Structural-analyzer parity: C/C++ prototypes are recorded as call entries with
 * `isDeclaration: true` (blast radius/rename filter them out). Synthetic entries are queued
 * separately so they never shadow real executable calls at the same line, and are deduped by
 * line+callee.
 */
function pushDeclarationCall(ctx: AnalysisContext, info: DeclarationCallInfo): void {
  const duplicate =
    ctx.declarationCalls.some(
      (existing) => existing.line === info.line && existing.callee === info.callee
    ) ||
    ctx.calls.some(
      (existing) =>
        existing.line === info.line && existing.callee === info.callee && existing.isDeclaration
    );
  if (duplicate) return;
  ctx.declarationCalls.push({
    callee: info.callee,
    line: info.line,
    argsCount: info.argsCount,
    ...(info.receiver ? { receiver: info.receiver } : {}),
    ...(info.member ? { member: true } : {}),
    isDeclaration: true,
  });
}

// ── Python symbols ──────────────────────────────────────────────────────────

function pythonParams(ctx: AnalysisContext, node: TsNode): { paramsCount: number } {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return { paramsCount: 0 };
  let count = 0;
  let firstParamText = "";
  for (const child of parameters.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "typed_parameter" ||
      child.type === "default_parameter" ||
      child.type === "typed_default_parameter" ||
      child.type === "list_splat_pattern" ||
      child.type === "dictionary_splat_pattern"
    ) {
      if (count === 0) firstParamText = textOf(ctx, child).trim().split(/[:\s=]/)[0] ?? "";
      count += 1;
    }
  }
  if (firstParamText === "self" || firstParamText === "cls") count -= 1;
  return { paramsCount: Math.max(0, count) };
}

function pythonClassFields(ctx: AnalysisContext, classNode: TsNode): string[] {
  const fields = new Set<string>();
  const body = classNode.childForFieldName("body");
  if (!body) return [];
  walkNodes(body, (node) => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    const typeNode = node.childForFieldName("type");
    if (!left) return;
    if (left.type === "identifier" && typeNode) {
      const name = nameOf(ctx, left);
      if (name) fields.add(name);
    } else if (left.type === "attribute") {
      const objectNode = left.childForFieldName("object");
      const attributeNode = left.childForFieldName("attribute");
      if (objectNode?.type === "identifier" && textOf(ctx, objectNode) === "self") {
        const name = nameOf(ctx, attributeNode);
        if (name) fields.add(name);
      }
    }
  });
  return Array.from(fields);
}

function collectPythonSymbols(
  ctx: AnalysisContext,
  node: TsNode,
  classStack: AstSymbol[],
  decoratedStart?: TsNode
): void {
  switch (node.type) {
    case "import_from_statement":
    case "import_statement":
      parsePythonImports(ctx, node);
      return;
    case "decorated_definition": {
      const definition = node.childForFieldName("definition") ?? findChildOfType(node, "class_definition");
      if (definition) {
        const actual =
          definition.type === "class_definition" || definition.type === "function_definition"
            ? definition
            : findChildOfType(node, "function_definition");
        if (actual) collectPythonSymbols(ctx, actual, classStack, node);
      }
      return;
    }
    case "class_definition": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      if (!name) return;
      const symbol = pushSymbol(ctx, {
        name,
        kind: "class",
        exported: !name.startsWith("_"),
        node,
        ...(decoratedStart ? { startNode: decoratedStart } : {}),
        bodyNode: node.childForFieldName("body") ?? undefined,
        fields: pythonClassFields(ctx, node),
      });
      if (!symbol) return;
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) {
          collectPythonSymbols(ctx, child, [...classStack, symbol]);
        }
      }
      return;
    }
    case "function_definition": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      if (!name) return;
      const parentClass = classStack.length > 0 ? classStack[classStack.length - 1]?.name : undefined;
      pushSymbol(ctx, {
        name,
        kind: parentClass ? "method" : "function",
        exported: !name.startsWith("_"),
        node,
        ...(decoratedStart ? { startNode: decoratedStart } : {}),
        bodyNode: node.childForFieldName("body") ?? undefined,
        paramsCount: pythonParams(ctx, node).paramsCount,
        ...(parentClass ? { parentClass } : {}),
      });
      return;
    }
    default: {
      for (const child of node.namedChildren) {
        collectPythonSymbols(ctx, child, classStack);
      }
    }
  }
}

// ── Go symbols ──────────────────────────────────────────────────────────────

function goParamsCount(node: TsNode): number {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return 0;
  let count = 0;
  for (const child of parameters.namedChildren) {
    if (child.type !== "parameter_declaration" && child.type !== "variadic_parameter_declaration") {
      continue;
    }
    // Go groups names sharing one type: `(a, b int)` declares two parameters.
    const names = child.namedChildren.filter(
      (grandchild) => grandchild.type === "identifier"
    ).length;
    count += Math.max(1, names);
  }
  return count;
}

function goReceiverType(ctx: AnalysisContext, methodNode: TsNode): string | undefined {
  const receiver = methodNode.childForFieldName("receiver");
  if (!receiver) return undefined;
  const parameter = receiver.namedChildren.find(
    (child) => child.type === "parameter_declaration"
  );
  if (!parameter) return undefined;
  const typeNode = parameter.childForFieldName("type");
  if (!typeNode) return undefined;
  return cleanTypeName(textOf(ctx, typeNode));
}

function goStructFields(ctx: AnalysisContext, typeNode: TsNode | null): string[] {
  const fields: string[] = [];
  if (!typeNode) return fields;
  const structBody = findChildOfType(typeNode, "field_declaration_list");
  if (!structBody) return fields;
  for (const declaration of structBody.namedChildren) {
    if (declaration.type !== "field_declaration") continue;
    const nameNode = declaration.childForFieldName("name");
    const name = nameNode ? nameOf(ctx, nameNode) : undefined;
    if (name) {
      fields.push(name);
      continue;
    }
    // Embedded field (`Base` / `*Base`): the promoted parent type also acts as a field.
    const typeNode = declaration.childForFieldName("type");
    if (typeNode) {
      const embedded = cleanTypeName(textOf(ctx, typeNode));
      if (embedded) fields.push(embedded);
    }
  }
  return fields;
}

function collectGoSymbols(ctx: AnalysisContext, node: TsNode): void {
  switch (node.type) {
    case "import_declaration":
      parseGoImports(ctx, node);
      return;
    case "type_declaration": {
      for (const spec of node.namedChildren) {
        if (spec.type !== "type_spec") continue;
        const name = nameOf(ctx, spec.childForFieldName("name"));
        const typeNode = spec.childForFieldName("type");
        if (!name || !typeNode) continue;
        const kind: SymbolKind =
          typeNode.type === "struct_type"
            ? "struct"
            : typeNode.type === "interface_type"
              ? "interface"
              : "type";
        pushSymbol(ctx, {
          name,
          kind,
          exported: /^[A-Z]/.test(name),
          node: spec,
          bodyNode: kind === "struct" || kind === "interface" ? typeNode : undefined,
          fields: kind === "struct" ? goStructFields(ctx, typeNode) : undefined,
        });
      }
      return;
    }
    case "method_declaration": {
      const name =
        nameOf(ctx, node.childForFieldName("name")) ??
        identifierText(ctx, node.namedChildren.find((child) => child.type === "field_identifier"));
      if (!name) return;
      const receiverType = goReceiverType(ctx, node);
      pushSymbol(ctx, {
        name,
        kind: "method",
        exported: /^[A-Z]/.test(name),
        node,
        bodyNode: node.childForFieldName("body") ?? undefined,
        paramsCount: goParamsCount(node),
        ...(receiverType ? { parentClass: receiverType } : {}),
      });
      return;
    }
    case "function_declaration": {
      const name = nameOf(ctx, node.childForFieldName("name")) ?? identifierText(ctx, node.namedChildren[1]);
      if (!name) return;
      pushSymbol(ctx, {
        name,
        kind: "function",
        exported: /^[A-Z]/.test(name),
        node,
        bodyNode: node.childForFieldName("body") ?? undefined,
        paramsCount: goParamsCount(node),
      });
      return;
    }
    default:
      for (const child of node.namedChildren) collectGoSymbols(ctx, child);
  }
}

// ── Rust symbols ────────────────────────────────────────────────────────────

function rustParamsCount(node: TsNode): number {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return 0;
  let count = 0;
  for (const child of parameters.namedChildren) {
    if (child.type === "parameter" || child.type === "variadic_parameter") count += 1;
  }
  return count;
}

function rustFields(ctx: AnalysisContext, itemNode: TsNode): string[] {
  const body = itemNode.childForFieldName("body");
  if (!body) return [];
  const fields: string[] = [];
  for (const declaration of body.namedChildren) {
    if (declaration.type !== "field_declaration") continue;
    const nameNode = declaration.childForFieldName("name");
    const name = nameNode ? nameOf(ctx, nameNode) : undefined;
    if (name) fields.push(name);
  }
  return fields;
}

function collectRustSymbols(
  ctx: AnalysisContext,
  node: TsNode,
  implStack: string[]
): void {
  switch (node.type) {
    case "use_declaration":
      parseRustImports(ctx, node);
      return;
    case "impl_item": {
      const typeNode = node.childForFieldName("type");
      const implType = typeNode ? cleanTypeName(textOf(ctx, typeNode)) : undefined;
      const body = node.childForFieldName("body") ?? findChildOfType(node, "declaration_list");
      if (!body) return;
      for (const child of body.namedChildren) {
        collectRustSymbols(ctx, child, implType ? [...implStack, implType] : implStack);
      }
      return;
    }
    case "struct_item":
    case "enum_item":
    case "trait_item":
    case "type_item": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      if (!name) return;
      const kind: SymbolKind =
        node.type === "struct_item"
          ? "struct"
          : node.type === "enum_item"
            ? "enum"
            : node.type === "trait_item"
              ? "interface"
              : "type";
      const visibility = node.childForFieldName("visibility") ?? findChildOfType(node, "visibility_modifier");
      pushSymbol(ctx, {
        name,
        kind,
        exported: Boolean(visibility),
        node,
        bodyNode: node.childForFieldName("body") ?? undefined,
        ...(kind === "struct" ? { fields: rustFields(ctx, node) } : {}),
      });
      if (node.type === "trait_item") {
        const body = node.childForFieldName("body") ?? findChildOfType(node, "declaration_list");
        // Trait methods are methods of the trait (`parentClass = <trait name>`), so a
        // `dyn Base`/`impl Base` receiver can resolve `b.cancel()` to `Base.cancel`.
        if (body) {
          for (const child of body.namedChildren) {
            collectRustSymbols(ctx, child, [...implStack, name]);
          }
        }
      }
      return;
    }
    case "function_item":
    case "function_signature_item": {
      const name = nameOf(ctx, node.childForFieldName("name")) ?? identifierText(ctx, node.namedChildren[1]);
      if (!name) return;
      const parentClass = implStack.length > 0 ? implStack[implStack.length - 1] : undefined;
      const visibility = node.childForFieldName("visibility") ?? findChildOfType(node, "visibility_modifier");
      pushSymbol(ctx, {
        name,
        kind: parentClass ? "method" : "function",
        exported: Boolean(visibility) || Boolean(parentClass),
        node,
        // `function_signature_item` (trait method declaration) has no body.
        bodyNode: node.childForFieldName("body") ?? undefined,
        paramsCount: rustParamsCount(node),
        ...(parentClass ? { parentClass } : {}),
      });
      return;
    }
    case "mod_item": {
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) collectRustSymbols(ctx, child, implStack);
      } else {
        for (const child of node.namedChildren) collectRustSymbols(ctx, child, implStack);
      }
      return;
    }
    default:
      for (const child of node.namedChildren) collectRustSymbols(ctx, child, implStack);
  }
}

// ── C/C++ symbols ───────────────────────────────────────────────────────────

interface CDeclaratorInfo {
  name?: string | undefined;
  nameLine?: number | undefined;
  scope?: string | undefined;
  paramsCount?: number | undefined;
  /** True for function-pointer variables (`void (*cb)(int)`) — they are fields, not methods. */
  isFunctionPointer?: boolean | undefined;
}

function analyzeCDeclarator(ctx: AnalysisContext, declarator: TsNode | null | undefined): CDeclaratorInfo {
  if (!declarator) return {};
  if (declarator.type === "function_declarator") {
    const inner = declarator.childForFieldName("declarator");
    const parameters = declarator.childForFieldName("parameters");
    const info = analyzeCDeclarator(ctx, inner);
    return {
      ...info,
      paramsCount: parameters
        ? parameters.namedChildren.filter(
            (child) =>
              child.type === "parameter_declaration" || child.type === "variadic_parameter_declaration"
          ).length
        : 0,
      ...(inner?.type === "parenthesized_declarator" ? { isFunctionPointer: true } : {}),
    };
  }
  if (declarator.type === "qualified_identifier") {
    const scopeNode = declarator.childForFieldName("scope");
    const nameNode = declarator.childForFieldName("name");
    return {
      name: nameOf(ctx, nameNode),
      nameLine: nameNode ? nodeLine(nameNode) : nodeLine(declarator),
      scope: scopeNode ? lastPathSegment(textOf(ctx, scopeNode)) : undefined,
    };
  }
  if (declarator.type === "identifier" || declarator.type === "field_identifier") {
    return { name: nameOf(ctx, declarator), nameLine: nodeLine(declarator) };
  }
  if (declarator.type === "pointer_declarator" || declarator.type === "reference_declarator") {
    return analyzeCDeclarator(ctx, declarator.childForFieldName("declarator"));
  }
  if (declarator.type === "parenthesized_declarator") {
    return analyzeCDeclarator(ctx, declarator.namedChildren[0]);
  }
  for (const child of declarator.namedChildren) {
    const info = analyzeCDeclarator(ctx, child);
    if (info.name) return info;
  }
  return {};
}

function cFieldsAndPrototypes(
  ctx: AnalysisContext,
  bodyNode: TsNode,
  className: string
): { fields: string[] } {
  const fields: string[] = [];
  const visit = (node: TsNode): void => {
    for (const child of node.namedChildren) {
      if (child.type === "field_declaration") {
        const typeNode = child.childForFieldName("type");
        const declarator = child.childForFieldName("declarator");
        const info = analyzeCDeclarator(ctx, declarator);
        if (info.paramsCount !== undefined && info.name && info.isFunctionPointer !== true) {
          pushSymbol(ctx, {
            name: info.name,
            kind: "method",
            exported: true,
            node: child,
            paramsCount: info.paramsCount,
            parentClass: className,
            prototype: true,
          });
          pushDeclarationCall(ctx, {
            callee: info.name,
            line: info.nameLine ?? nodeLine(child),
            argsCount: info.paramsCount,
          });
        } else if (info.name) {
          fields.push(info.name);
        } else if (typeNode && declarator) {
          const plain = analyzeCDeclarator(ctx, declarator);
          if (plain.name) fields.push(plain.name);
        }
      } else if (
        child.type === "access_specifier" ||
        child.type === "comment" ||
        child.type === "function_definition" ||
        child.type === "class_specifier" ||
        child.type === "struct_specifier" ||
        child.type === "enum_specifier"
      ) {
        // Nested type definitions are handled by the caller's traversal.
        continue;
      } else {
        visit(child);
      }
    }
  };
  visit(bodyNode);
  return { fields };
}

function collectCCppSymbols(
  ctx: AnalysisContext,
  node: TsNode,
  classStack: AstSymbol[]
): void {
  switch (node.type) {
    case "preproc_include":
      parseCInclude(ctx, node);
      return;
    case "class_specifier":
    case "struct_specifier": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      const body = node.childForFieldName("body");
      if (!name || !body) return;
      const kind: SymbolKind = node.type === "class_specifier" ? "class" : "struct";
      const symbol = pushSymbol(ctx, {
        name,
        kind,
        exported: true,
        node,
        bodyNode: body,
      });
      if (!symbol) return;
      // Member prototype symbols + field names (collected before recursive traversal).
      const { fields } = cFieldsAndPrototypes(ctx, body, name);
      if (fields.length > 0) {
        const stored = ctx.symbols[ctx.symbols.indexOf(symbol)];
        if (stored) stored.fields = Array.from(new Set([...(stored.fields ?? []), ...fields]));
      }
      for (const child of body.namedChildren) {
        collectCCppSymbols(ctx, child, [...classStack, symbol]);
      }
      return;
    }
    case "enum_specifier": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      const body = node.childForFieldName("body");
      if (!name || !body) return;
      pushSymbol(ctx, { name, kind: "enum", exported: true, node, bodyNode: body });
      return;
    }
    case "type_definition": {
      const declarator = node.childForFieldName("declarator");
      const info = analyzeCDeclarator(ctx, declarator);
      const typeNode =
        node.childForFieldName("type") ??
        node.namedChildren.find(
          (child) =>
            child.type === "struct_specifier" ||
            child.type === "class_specifier" ||
            child.type === "union_specifier"
        );
      const body = typeNode?.childForFieldName("body") ?? null;
      if (
        typeNode &&
        body &&
        (typeNode.type === "struct_specifier" || typeNode.type === "class_specifier")
      ) {
        // `typedef struct Base { ... } Base;` — the struct itself is the useful declaration.
        const innerName = nameOf(ctx, typeNode.childForFieldName("name"));
        if (innerName) {
          collectCCppSymbols(ctx, typeNode, classStack);
          if (info.name && info.name !== innerName) {
            pushSymbol(ctx, { name: info.name, kind: "type", exported: true, node });
          }
        } else if (info.name) {
          const kind: SymbolKind =
            typeNode.type === "class_specifier" ? "class" : "struct";
          const symbol = pushSymbol(ctx, {
            name: info.name,
            kind,
            exported: true,
            node: typeNode,
            bodyNode: body,
          });
          if (symbol) {
            const { fields } = cFieldsAndPrototypes(ctx, body, info.name);
            if (fields.length > 0) {
              const stored = ctx.symbols[ctx.symbols.indexOf(symbol)];
              if (stored) stored.fields = Array.from(new Set(fields));
            }
            for (const child of body.namedChildren) {
              collectCCppSymbols(ctx, child, [...classStack, symbol]);
            }
          }
        }
        return;
      }
      if (info.name) {
        pushSymbol(ctx, { name: info.name, kind: "type", exported: true, node });
      }
      return;
    }
    case "namespace_definition": {
      const body = node.childForFieldName("body");
      if (body) for (const child of body.namedChildren) collectCCppSymbols(ctx, child, classStack);
      return;
    }
    case "template_declaration": {
      for (const child of node.namedChildren) collectCCppSymbols(ctx, child, classStack);
      return;
    }
    case "linkage_specification": {
      const body = node.childForFieldName("body");
      if (body) for (const child of body.namedChildren) collectCCppSymbols(ctx, child, classStack);
      return;
    }
    case "function_definition": {
      const declarator = node.childForFieldName("declarator");
      const info = analyzeCDeclarator(ctx, declarator);
      const body = node.childForFieldName("body");
      if (!info.name) {
        if (body) for (const child of body.namedChildren) collectCCppSymbols(ctx, child, classStack);
        return;
      }
      const parentClass = info.scope ?? (classStack.length > 0 ? classStack[classStack.length - 1]?.name : undefined);
      pushSymbol(ctx, {
        name: info.name,
        kind: parentClass ? "method" : "function",
        exported: true,
        node,
        bodyNode: body ?? undefined,
        paramsCount: info.paramsCount ?? 0,
        ...(parentClass ? { parentClass } : {}),
      });
      if (body) for (const child of body.namedChildren) collectCCppSymbols(ctx, child, classStack);
      return;
    }
    case "declaration": {
      const declarator = node.childForFieldName("declarator");
      const info = analyzeCDeclarator(ctx, declarator);
      if (info.name && info.paramsCount !== undefined) {
        const parentClass = classStack.length > 0 ? classStack[classStack.length - 1]?.name : undefined;
        pushSymbol(ctx, {
          name: info.name,
          kind: parentClass ? "method" : "function",
          exported: true,
          node,
          ...(info.paramsCount !== undefined ? { paramsCount: info.paramsCount } : {}),
          ...(parentClass ? { parentClass } : {}),
          prototype: true,
        });
        pushDeclarationCall(ctx, {
          callee: info.name,
          line: info.nameLine ?? nodeLine(node),
          argsCount: info.paramsCount,
          ...(info.scope ? { receiver: info.scope } : {}),
          ...(info.scope ? { member: true } : {}),
        });
      }
      return;
    }
    case "field_declaration": {
      // Only relevant when reached outside a class body (e.g. local); class bodies are handled above.
      return;
    }
    default:
      for (const child of node.namedChildren) collectCCppSymbols(ctx, child, classStack);
  }
}

// ── C# symbols ──────────────────────────────────────────────────────────────

function csharpModifiersText(ctx: AnalysisContext, node: TsNode): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.type === "modifier") parts.push(textOf(ctx, child));
  }
  return parts.join(" ").toLowerCase();
}

function csharpParamsCount(node: TsNode): number {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return 0;
  return parameters.namedChildren.filter(
    (child) =>
      child.type === "parameter" ||
      child.type === "parameter_array" ||
      child.type === "this_parameter"
  ).length;
}

function csharpClassFields(ctx: AnalysisContext, classNode: TsNode): string[] {
  const fields: string[] = [];
  // Positional records expose their primary-constructor parameters as properties.
  if (classNode.type === "record_declaration") {
    const parameterList = classNode.namedChildren.find((child) => child.type === "parameter_list");
    for (const parameter of parameterList?.namedChildren ?? []) {
      if (parameter.type !== "parameter") continue;
      const nameNode = parameter.childForFieldName("name");
      const name = nameNode ? nameOf(ctx, nameNode) : undefined;
      if (name) fields.push(name);
    }
  }
  const body = classNode.childForFieldName("body") ?? findChildOfType(classNode, "declaration_list");
  if (!body) return fields;
  for (const child of body.namedChildren) {
    if (child.type === "field_declaration") {
      const variable = findChildOfType(child, "variable_declaration");
      if (!variable) continue;
      for (const declarator of variable.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const nameNode = declarator.childForFieldName("name") ?? declarator.namedChildren[0];
        const name = nameNode ? nameOf(ctx, nameNode) : undefined;
        if (name) fields.push(name);
      }
    } else if (child.type === "property_declaration") {
      const nameNode = child.childForFieldName("name") ?? child.namedChildren.find((c) => c.type === "identifier");
      const name = nameNode ? nameOf(ctx, nameNode) : undefined;
      if (name) fields.push(name);
    } else if (child.type === "event_declaration" || child.type === "event_field_declaration") {
      const nameNode = child.childForFieldName("name") ?? findChildOfType(child, "identifier");
      const name = nameNode ? nameOf(ctx, nameNode) : undefined;
      if (name) fields.push(name);
    }
  }
  return fields;
}

function collectCSharpSymbols(
  ctx: AnalysisContext,
  node: TsNode,
  classStack: AstSymbol[]
): void {
  switch (node.type) {
    case "using_directive":
      parseCSharpUsing(ctx, node);
      return;
    case "namespace_declaration":
    case "file_scoped_namespace_declaration": {
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) collectCSharpSymbols(ctx, child, classStack);
      } else {
        for (const child of node.namedChildren) collectCSharpSymbols(ctx, child, classStack);
      }
      return;
    }
    case "class_declaration":
    case "interface_declaration":
    case "struct_declaration":
    case "record_declaration":
    case "record_struct_declaration":
    case "enum_declaration": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      if (!name) return;
      const modifiers = csharpModifiersText(ctx, node);
      // tree-sitter-c-sharp keeps `record`/`struct`/`class` as anonymous tokens, not modifiers.
      const isRecordStruct =
        node.type === "record_struct_declaration" ||
        (node.type === "record_declaration" && node.children.some((child) => child.type === "struct"));
      const kind: SymbolKind =
        node.type === "class_declaration"
          ? "class"
          : node.type === "struct_declaration" || isRecordStruct
            ? "struct"
            : node.type === "record_declaration"
              ? "class"
              : node.type === "enum_declaration"
                ? "enum"
                : "interface";
      const symbol = pushSymbol(ctx, {
        name,
        kind,
        exported: /\b(public|internal)\b/.test(modifiers),
        node,
        bodyNode: node.childForFieldName("body") ?? undefined,
        fields: node.type === "enum_declaration" ? undefined : csharpClassFields(ctx, node),
      });
      if (!symbol) return;
      const body = node.childForFieldName("body") ?? findChildOfType(node, "declaration_list");
      if (body) {
        for (const child of body.namedChildren) {
          collectCSharpSymbols(ctx, child, [...classStack, symbol]);
        }
      }
      return;
    }
    case "method_declaration": {
      const name = nameOf(ctx, node.childForFieldName("name"));
      if (!name) return;
      const parentClass = classStack.length > 0 ? classStack[classStack.length - 1]?.name : undefined;
      const modifiers = csharpModifiersText(ctx, node);
      const returnNode = node.childForFieldName("returns") ?? node.childForFieldName("return_type");
      pushSymbol(ctx, {
        name,
        kind: parentClass ? "method" : "function",
        exported: /\b(public|internal)\b/.test(modifiers),
        node,
        bodyNode: node.childForFieldName("body") ?? undefined,
        paramsCount: csharpParamsCount(node),
        ...(returnNode ? { returnType: textOf(ctx, returnNode).trim() } : {}),
        ...(parentClass ? { parentClass } : {}),
      });
      return;
    }
    case "constructor_declaration":
      // Structural parity: constructors are not emitted as symbols.
      return;
    case "local_function_statement":
      return;
    default:
      for (const child of node.namedChildren) collectCSharpSymbols(ctx, child, classStack);
  }
}

// ── Syntax errors ───────────────────────────────────────────────────────────

const PY_COMPOUND_HEADER_RE =
  /^(?:async\s+)?(def|class|if|elif|else|for|while|with|try|except|finally|match|case)\b/;

/**
 * Python `if order_id` / `def f(x)` header without `:` is an ERROR/MISSING node in the CST.
 * Mirror the structural analyzer's wording (`... missing ':' ...`) instead of a generic
 * "Syntax error near ..." so the gf_edit syntax guard message stays actionable.
 */
function pythonMissingColonMessage(ctx: AnalysisContext, node: TsNode): string | undefined {
  const rawLine = ctx.lines[node.startPosition.row] ?? "";
  const code = (rawLine.split("#")[0] ?? "").trim();
  const keywordMatch = code.match(PY_COMPOUND_HEADER_RE);
  if (!keywordMatch) return undefined;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let hasTopLevelColon = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const prev = i > 0 ? code[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) {
      hasTopLevelColon = true;
      break;
    }
  }
  // A multi-line header continues on the following line; let the generic parser message stand.
  if (depth > 0) return undefined;
  if (hasTopLevelColon) return undefined;
  return `Python '${keywordMatch[1]}' statement is missing ':' at line ${node.startPosition.row + 1}`;
}

function collectSyntaxErrors(ctx: AnalysisContext, root: TsNode): void {
  if (!root.hasError) return;
  const limit = 10;
  const visit = (node: TsNode): void => {
    if (ctx.syntaxErrors.length >= limit) return;
    if (node.type === "ERROR") {
      const special = ctx.family === "python" ? pythonMissingColonMessage(ctx, node) : undefined;
      if (special) {
        ctx.syntaxErrors.push({
          line: nodeLine(node),
          column: node.startPosition.column,
          message: special,
        });
      } else {
        const snippet = textOf(ctx, node).trim().split(/\r?\n/)[0] ?? "";
        ctx.syntaxErrors.push({
          line: nodeLine(node),
          column: node.startPosition.column,
          message: `Syntax error${snippet ? ` near '${snippet.slice(0, 60)}'` : ""}`,
        });
      }
    } else if (node.isMissing) {
      const special = ctx.family === "python" ? pythonMissingColonMessage(ctx, node) : undefined;
      ctx.syntaxErrors.push({
        line: nodeLine(node),
        column: node.startPosition.column,
        message:
          special ??
          (ctx.family === "python" && node.type === ":"
            ? `Python statement is missing ':' at line ${node.startPosition.row + 1}`
            : `Missing ${node.type}`),
      });
    }
    // Use all children (not just named ones): MISSING tokens are anonymous nodes.
    for (const child of node.children) visit(child);
  };
  visit(root);
}

// ── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Alias for callers that prefer an explicit `parseTreeSitterFile` name.
 * Returns `undefined` exactly like `analyzeWithTreeSitter`.
 */
export function parseTreeSitterFile(
  relPath: string,
  content: string
): FileAstAnalysis | undefined {
  return analyzeWithTreeSitter(relPath, content);
}

/**
 * Analyzes one file with tree-sitter. Returns `undefined` when the file type is unsupported,
 * the tree-sitter core/grammar cannot be loaded, or parsing fails to produce a tree.
 * The caller (ast-engine) decides whether to use the result (opt-in env flag).
 */
export function analyzeWithTreeSitter(
  relPath: string,
  content: string
): FileAstAnalysis | undefined {
  const family = treeSitterFamilyForPath(relPath);
  if (!family) return undefined;

  // C vs C++ share one extension family; try the preferred grammar and fall back to the
  // other one when the preferred grammar reports parse errors (e.g. `foo.cpp` written in C
  // or a `.h` header containing C++ classes).
  const candidates: TreeSitterFamily[] =
    family === "c" || family === "cpp"
      ? family === "c"
        ? ["c", "cpp"]
        : ["cpp", "c"]
      : [family];
  let chosenFamily: TreeSitterFamily | undefined;
  let root: TsNode | undefined;
  for (const candidate of candidates) {
    const parser = getParser(candidate);
    if (!parser) continue;
    let tree: TsTree;
    try {
      tree = parser.parse(content);
    } catch {
      continue;
    }
    const candidateRoot = tree.rootNode;
    if (!candidateRoot) continue;
    if (!root || (root.hasError && !candidateRoot.hasError)) {
      root = candidateRoot;
      chosenFamily = candidate;
    }
    if (!candidateRoot.hasError) break;
  }
  if (!root || !chosenFamily) return undefined;

  const ctx: AnalysisContext = {
    relPath,
    content,
    family: chosenFamily,
    lines: content.split(/\r?\n/),
    symbols: [],
    imports: [],
    calls: [],
    syntaxErrors: [],
    prototypes: new Set<AstSymbol>(),
    declarationCalls: [],
  };

  switch (chosenFamily) {
    case "python":
      collectPythonSymbols(ctx, root, []);
      break;
    case "go":
      collectGoSymbols(ctx, root);
      break;
    case "rust":
      collectRustSymbols(ctx, root, []);
      break;
    case "c":
    case "cpp":
      collectCCppSymbols(ctx, root, []);
      break;
    case "csharp":
      collectCSharpSymbols(ctx, root, []);
      break;
  }

  collectCalls(ctx, root);
  if (chosenFamily === "rust") collectRustMacroMethodCalls(ctx, root);
  // Synthetic prototype entries come last so real executable calls win same-name lookups.
  ctx.calls.push(...ctx.declarationCalls);
  collectSyntaxErrors(ctx, root);

  // A declaration prototype is redundant when the same file also defines the symbol.
  const symbols = ctx.symbols.filter((symbol) => {
    if (!ctx.prototypes.has(symbol)) return true;
    return !ctx.symbols.some(
      (other) =>
        other !== symbol &&
        !ctx.prototypes.has(other) &&
        other.name === symbol.name &&
        (other.parentClass ?? "") === (symbol.parentClass ?? "")
    );
  });
  symbols.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1));

  return {
    relPath,
    totalLines: ctx.lines.length,
    backend: FAMILY_BACKEND[chosenFamily],
    symbols,
    imports: ctx.imports,
    calls: ctx.calls,
    syntaxErrors: ctx.syntaxErrors,
    engine: "tree-sitter",
  };
}
