import { createRequire } from "node:module";
import type * as TsNs from "typescript";
import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index";

const requireFn = createRequire(__filename);

let tsModule: typeof TsNs | null | undefined;

function loadTs(): typeof TsNs | null {
  if (tsModule !== undefined) return tsModule;
  try {
    tsModule = requireFn("typescript") as typeof TsNs;
  } catch {
    tsModule = null;
  }
  return tsModule;
}

const EXTS = [".ts", ".tsx", ".js", ".jsx"];

function extOf(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  return idx < 0 ? "" : relPath.slice(idx).toLowerCase();
}

function extractFromAst(relPath: string, content: string, ts: typeof TsNs): ExtractionResult {
  const ext = extOf(relPath);
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX :
    ext === ".jsx" ? ts.ScriptKind.JSX :
    ext === ".js" ? ts.ScriptKind.JS :
    ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];

  const estimateComplexity = (text: string): number => {
    const hits = text.match(/\b(if|else if|for|while|case|catch|\&\&|\|\|)\b/g);
    return 1 + (hits?.length ?? 0);
  };

  const getVisibility = (node: TsNs.Node): "public" | "protected" | "private" => {
    const flags = ts.getCombinedModifierFlags(node as TsNs.Declaration);
    if ((flags & ts.ModifierFlags.Private) !== 0) return "private";
    if ((flags & ts.ModifierFlags.Protected) !== 0) return "protected";
    return "public";
  };

  const summarizeJsDoc = (node: TsNs.Node): string | undefined => {
    const jsdocs = (node as unknown as { jsDoc?: Array<{ comment?: string | TsNs.NodeArray<TsNs.JSDocComment> }> }).jsDoc;
    if (!jsdocs || jsdocs.length === 0) {
      return undefined;
    }
    const text = jsdocs
      .map((item: { comment?: string | TsNs.NodeArray<TsNs.JSDocComment> }) => {
        if (typeof item.comment === "string") {
          return item.comment;
        }
        return "";
      })
      .join(" ")
      .trim();
    return text || undefined;
  };

  const declarationType = (node: TsNs.SignatureDeclarationBase): { paramsCount: number; returnType?: string } => {
    const paramsCount = node.parameters.length;
    let returnType: string | undefined;
    if (node.type) {
      returnType = node.type.getText(sourceFile).slice(0, 80);
    }
    return { paramsCount, ...(returnType ? { returnType } : {}) };
  };

  const addDecl = (
    nameNode: TsNs.Node | undefined,
    kind: string,
    exported: boolean,
    sourceNode: TsNs.Node,
    extras?: Partial<DeclaredSymbol>
  ): void => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const name = nameNode.text;
    if (!name) return;
    const start = nameNode.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    const signature = sourceNode.getText(sourceFile).split(/\r?\n/)[0]?.slice(0, 240) ?? `${kind} ${name}`;
    const jsdoc = summarizeJsDoc(sourceNode);
    symbols.push({
      name,
      kind,
      exported,
      line: line + 1,
      file: relPath,
      signature,
      ...(jsdoc ? { jsdoc } : {}),
      visibility: getVisibility(sourceNode),
      complexity: estimateComplexity(sourceNode.getText(sourceFile)),
      ...extras,
    });
  };

  const hasExport = (node: TsNs.Node): boolean => {
    const flags = ts.getCombinedModifierFlags(node as TsNs.Declaration);
    return (flags & ts.ModifierFlags.Export) !== 0;
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      addDecl(stmt.name, "function", hasExport(stmt), stmt, declarationType(stmt));
    } else if (ts.isClassDeclaration(stmt)) {
      addDecl(stmt.name, "class", hasExport(stmt), stmt);
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          addDecl(member.name, "method", false, member, declarationType(member));
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      addDecl(stmt.name, "interface", hasExport(stmt), stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addDecl(stmt.name, "type", hasExport(stmt), stmt);
    } else if (ts.isEnumDeclaration(stmt)) {
      addDecl(stmt.name, "enum", hasExport(stmt), stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExport(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addDecl(decl.name, "variable", exported, decl);
        }
      }
    } else if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (ts.isStringLiteral(spec)) imports.push({ module: spec.text, raw: spec.text });
    } else if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) imports.push({ module: spec.text, raw: spec.text });
    }
  }

  const visit = (node: TsNs.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "require" && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) imports.push({ module: arg.text, raw: arg.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { symbols, imports };
}

function fallbackExtract(relPath: string, content: string): ExtractionResult {
  const lines = content.split(/\r?\n/);
  const symbols: DeclaredSymbol[] = [];
  for (let i = 0; i < lines.length && symbols.length < 80; i += 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed.startsWith("export ") || trimmed.startsWith("function ")) {
      const summary = trimmed.slice(0, 200);
      symbols.push({
        name: summary,
        kind: "raw",
        exported: trimmed.startsWith("export "),
        line: i + 1,
        file: relPath,
      });
    }
  }
  const imports: ImportTarget[] = [];
  const matches = content.matchAll(/(?:import\s+[^"']+from\s+|require\()\s*["']([^"']+)["']/g);
  for (const match of matches) {
    const target = match[1]?.trim();
    if (target) imports.push({ module: target, raw: target });
    if (imports.length >= 120) break;
  }
  return { symbols, imports };
}

export const typescriptIndexer: LanguageIndexer = {
  language: "typescript",
  extensions: EXTS,
  extract(filePath: string, content: string): ExtractionResult {
    const ts = loadTs();
    if (!ts) return fallbackExtract(filePath, content);
    try {
      return extractFromAst(filePath, content, ts);
    } catch {
      return fallbackExtract(filePath, content);
    }
  },
};
