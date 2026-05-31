import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index";

const RE_FN = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)*fn\s+(\w+)/;
const RE_STRUCT = /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/;
const RE_ENUM = /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/;
const RE_TRAIT = /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/;
const RE_IMPL = /^\s*impl(?:\s*<[^>]*>)?\s+(?:[\w:<>,\s]+?\s+for\s+)?([A-Za-z_][\w]*)/;
const RE_CONST = /^\s*(pub(?:\([^)]*\))?\s+)?const\s+(\w+)/;
const RE_STATIC = /^\s*(pub(?:\([^)]*\))?\s+)?static\s+(?:mut\s+)?(\w+)/;
const RE_MOD = /^\s*(pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/;
const RE_MACRO = /^\s*macro_rules!\s*(\w+)/;
const RE_USE = /^\s*(?:pub\s+)?use\s+([\w:]+)/;

export const rustIndexer: LanguageIndexer = {
  language: "rust",
  extensions: [".rs"],
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

      const tests: Array<[RegExp, string, number, number]> = [
        [RE_FN, "function", 1, 2],
        [RE_STRUCT, "struct", 1, 2],
        [RE_ENUM, "enum", 1, 2],
        [RE_TRAIT, "trait", 1, 2],
        [RE_CONST, "const", 1, 2],
        [RE_STATIC, "const", 1, 2],
        [RE_MOD, "module", 1, 2],
      ];
      let matched = false;
      for (const [re, kind, pubGroup, nameGroup] of tests) {
        const m = re.exec(line);
        if (m) {
          symbols.push({
            name: m[nameGroup]!,
            kind,
            exported: Boolean(m[pubGroup]),
            line: lineNo,
            file: filePath,
          });
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const macroMatch = RE_MACRO.exec(line);
      if (macroMatch) {
        symbols.push({
          name: macroMatch[1]!,
          kind: "macro",
          exported: true,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const implMatch = RE_IMPL.exec(line);
      if (implMatch) {
        symbols.push({
          name: implMatch[1]!,
          kind: "impl",
          exported: false,
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const useMatch = RE_USE.exec(line);
      if (useMatch) {
        const normalized = useMatch[1]!.replace(/::/g, "/");
        imports.push({ module: normalized, raw: useMatch[0]!.trim() });
      }
    }

    return { symbols, imports };
  },
};
