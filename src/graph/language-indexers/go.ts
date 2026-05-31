import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index";

const RE_PACKAGE = /^package\s+(\w+)/;
const RE_FUNC = /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/;
const RE_TYPE_STRUCT = /^type\s+(\w+)\s+(struct|interface)\b/;
const RE_TYPE_ALIAS = /^type\s+(\w+)\s+(?!struct|interface)\S/;
const RE_VAR = /^var\s+(\w+)/;
const RE_CONST = /^const\s+(\w+)/;
const RE_IMPORT_SINGLE = /^import\s+(?:\w+\s+)?"([^"]+)"/;
const RE_IMPORT_GROUP_ITEM = /^\s*(?:\w+\s+)?"([^"]+)"/;

function isExported(name: string): boolean {
  const first = name.charAt(0);
  return first >= "A" && first <= "Z";
}

export const goIndexer: LanguageIndexer = {
  language: "go",
  extensions: [".go"],
  extract(filePath: string, content: string): ExtractionResult {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const lines = content.split(/\r?\n/);
    let inImportGroup = false;
    let inBlockComment = false;

    for (let idx = 0; idx < lines.length; idx += 1) {
      let line = lines[idx] ?? "";
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      const blockStart = line.indexOf("/*");
      if (blockStart >= 0 && line.indexOf("*/", blockStart) < 0) {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      }
      const slashIdx = line.indexOf("//");
      if (slashIdx >= 0) line = line.slice(0, slashIdx);
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lineNo = idx + 1;

      if (inImportGroup) {
        if (trimmed === ")") {
          inImportGroup = false;
          continue;
        }
        const m = RE_IMPORT_GROUP_ITEM.exec(line);
        if (m) imports.push({ module: m[1]!, raw: trimmed });
        continue;
      }

      if (trimmed === "import (") {
        inImportGroup = true;
        continue;
      }

      const pkgMatch = RE_PACKAGE.exec(line);
      if (pkgMatch) {
        symbols.push({
          name: pkgMatch[1]!,
          kind: "package",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const importSingle = RE_IMPORT_SINGLE.exec(line);
      if (importSingle) {
        imports.push({ module: importSingle[1]!, raw: trimmed });
        continue;
      }

      const funcMatch = RE_FUNC.exec(line);
      if (funcMatch) {
        const name = funcMatch[1]!;
        symbols.push({
          name,
          kind: "func",
          exported: isExported(name),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const tsMatch = RE_TYPE_STRUCT.exec(line);
      if (tsMatch) {
        const name = tsMatch[1]!;
        symbols.push({
          name,
          kind: tsMatch[2] === "interface" ? "interface" : "struct",
          exported: isExported(name),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const tAlias = RE_TYPE_ALIAS.exec(line);
      if (tAlias) {
        const name = tAlias[1]!;
        symbols.push({
          name,
          kind: "type",
          exported: isExported(name),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const varMatch = RE_VAR.exec(line);
      if (varMatch) {
        const name = varMatch[1]!;
        symbols.push({
          name,
          kind: "variable",
          exported: isExported(name),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const constMatch = RE_CONST.exec(line);
      if (constMatch) {
        const name = constMatch[1]!;
        symbols.push({
          name,
          kind: "const",
          exported: isExported(name),
          line: lineNo,
          file: filePath,
        });
      }
    }

    return { symbols, imports };
  },
};
