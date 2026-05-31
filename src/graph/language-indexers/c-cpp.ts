import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index";

const RE_FUNC = /^\s*((?:(?:static|inline|extern|virtual|constexpr|explicit|friend)\s+)*)((?:[\w:*&<>~]+\s+)+)(\w+)\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:=\s*\w+\s*)?[;{]/;
const RE_CLASS = /^\s*(class|struct)\s+(\w+)\s*(?:final\s*)?[:{]/;
const RE_ENUM = /^\s*enum(?:\s+class)?\s+(\w+)/;
const RE_TYPEDEF = /^\s*typedef\s+.+?\s+(\w+)\s*;/;
const RE_DEFINE = /^\s*#\s*define\s+(\w+)/;
const RE_NAMESPACE = /^\s*namespace\s+(\w+)/;
const RE_INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/;

const FUNC_NAME_BLACKLIST = new Set([
  "if", "else", "for", "while", "switch", "return", "do", "case", "sizeof", "typeof",
  "new", "delete", "throw", "try", "catch", "operator",
]);

export const cppIndexer: LanguageIndexer = {
  language: "c-cpp",
  extensions: [".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"],
  extract(filePath: string, content: string): ExtractionResult {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const lines = content.split(/\r?\n/);
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
      if (!line.trim()) continue;
      const lineNo = idx + 1;

      const incMatch = RE_INCLUDE.exec(line);
      if (incMatch) {
        imports.push({ module: incMatch[1]!, raw: incMatch[0]!.trim() });
        continue;
      }

      const defMatch = RE_DEFINE.exec(line);
      if (defMatch) {
        symbols.push({
          name: defMatch[1]!,
          kind: "macro",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const nsMatch = RE_NAMESPACE.exec(line);
      if (nsMatch) {
        symbols.push({
          name: nsMatch[1]!,
          kind: "namespace",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const enumMatch = RE_ENUM.exec(line);
      if (enumMatch) {
        symbols.push({
          name: enumMatch[1]!,
          kind: "enum",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const classMatch = RE_CLASS.exec(line);
      if (classMatch) {
        symbols.push({
          name: classMatch[2]!,
          kind: classMatch[1] === "class" ? "class" : "struct",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const typedefMatch = RE_TYPEDEF.exec(line);
      if (typedefMatch) {
        symbols.push({
          name: typedefMatch[1]!,
          kind: "type",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const funcMatch = RE_FUNC.exec(line);
      if (funcMatch) {
        const name = funcMatch[3]!;
        if (FUNC_NAME_BLACKLIST.has(name)) continue;
        const modifiers = funcMatch[1] ?? "";
        symbols.push({
          name,
          kind: "function",
          exported: !/\bstatic\b/.test(modifiers),
          line: lineNo,
          file: filePath,
        });
      }
    }

    return { symbols, imports };
  },
};
