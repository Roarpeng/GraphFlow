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

  const addDecl = (nameNode: TsNs.Node | undefined, kind: string, exported: boolean): void => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const name = nameNode.text;
    if (!name) return;
    const start = nameNode.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    symbols.push({ name, kind, exported, line: line + 1, file: relPath });
  };

  const hasExport = (node: TsNs.Node): boolean => {
    const flags = ts.getCombinedModifierFlags(node as TsNs.Declaration);
    return (flags & ts.ModifierFlags.Export) !== 0;
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      addDecl(stmt.name, "function", hasExport(stmt));
    } else if (ts.isClassDeclaration(stmt)) {
      addDecl(stmt.name, "class", hasExport(stmt));
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          addDecl(member.name, "method", false);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      addDecl(stmt.name, "interface", hasExport(stmt));
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addDecl(stmt.name, "type", hasExport(stmt));
    } else if (ts.isEnumDeclaration(stmt)) {
      addDecl(stmt.name, "enum", hasExport(stmt));
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExport(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addDecl(decl.name, "variable", exported);
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
