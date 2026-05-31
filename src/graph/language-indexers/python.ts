import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index";

const RE_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const RE_CLASS = /^(\s*)class\s+(\w+)/;
const RE_VAR = /^(\w+)\s*(?::\s*[^=]+)?=\s*[^=]/;
const RE_IMPORT = /^\s*import\s+([\w.]+)/;
const RE_FROM = /^\s*from\s+([\w.]+)\s+import\b/;

function stripTripleQuotes(line: string, state: { open: string | null }): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.open) {
      const end = line.indexOf(state.open, i);
      if (end < 0) return out;
      i = end + 3;
      state.open = null;
      continue;
    }
    const t3 = line.slice(i, i + 3);
    if (t3 === '"""' || t3 === "'''") {
      const closeIdx = line.indexOf(t3, i + 3);
      if (closeIdx < 0) {
        state.open = t3;
        return out;
      }
      i = closeIdx + 3;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

export const pythonIndexer: LanguageIndexer = {
  language: "python",
  extensions: [".py"],
  extract(filePath: string, content: string): ExtractionResult {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const lines = content.split(/\r?\n/);
    const state = { open: null as string | null };

    for (let idx = 0; idx < lines.length; idx += 1) {
      const raw = lines[idx] ?? "";
      const inString = state.open !== null;
      const line = stripTripleQuotes(raw, state);
      if (inString && state.open !== null) continue;
      if (!line.trim() || line.trim().startsWith("#")) continue;

      const lineNo = idx + 1;
      const defMatch = RE_DEF.exec(line);
      if (defMatch) {
        const indent = defMatch[1]!.length;
        const name = defMatch[2]!;
        symbols.push({
          name,
          kind: indent === 0 ? "function" : "method",
          exported: !name.startsWith("_"),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const classMatch = RE_CLASS.exec(line);
      if (classMatch) {
        const name = classMatch[2]!;
        symbols.push({
          name,
          kind: "class",
          exported: !name.startsWith("_"),
          line: lineNo,
          file: filePath,
        });
        continue;
      }

      const fromMatch = RE_FROM.exec(line);
      if (fromMatch) {
        imports.push({ module: fromMatch[1]!, raw: fromMatch[0]!.trim() });
        continue;
      }

      const importMatch = RE_IMPORT.exec(line);
      if (importMatch) {
        imports.push({ module: importMatch[1]!, raw: importMatch[0]!.trim() });
        continue;
      }

      if (!/^\s/.test(line)) {
        const varMatch = RE_VAR.exec(line);
        if (varMatch) {
          const name = varMatch[1]!;
          if (!["import", "from", "return", "if", "for", "while", "class", "def", "with", "try", "raise", "yield", "pass", "global", "nonlocal", "assert", "del", "print"].includes(name)) {
            symbols.push({
              name,
              kind: "variable",
              exported: !name.startsWith("_"),
              line: lineNo,
              file: filePath,
            });
          }
        }
      }
    }

    return { symbols, imports };
  },
};
