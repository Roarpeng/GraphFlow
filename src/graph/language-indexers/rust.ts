import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

/**
 * Rust indexer using tree-sitter AST (upgraded from line-level regex).
 *
 * Extracts: functions, structs, enums, traits, impl blocks, constants,
 * statics, modules, macro_rules, use declarations.
 *
 * Visibility (`pub`) is determined by the presence of a `visibility_modifier`
 * child node, matching the previous regex-based `pub` detection.
 */
export const rustIndexer: LanguageIndexer = {
  language: "rust",
  extensions: [".rs"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("rust");
      tree = parser.parse(content);
    } catch {
      // Fallback to regex if tree-sitter WASM unavailable
      return rustRegexFallback(filePath, content);
    }

    const traverse = (node: TreeSitterSyntaxNode) => {
      const lineNo = node.startPosition.row + 1;
      const hasPub = node.children?.some((c) => c.type === "visibility_modifier") ?? false;

      switch (node.type) {
        case "function_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "parameter" || c.type === "self_parameter"
              ).length;
            }
            const isAsync = node.children?.some((c) => c.type === "async") ?? false;
            symbols.push({
              name: nameNode.text,
              kind: "function",
              exported: hasPub,
              line: lineNo,
              file: filePath,
              paramsCount,
              signature: `${isAsync ? "async " : ""}fn ${nameNode.text}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "struct_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "struct",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "enum_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "enum",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "trait_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "trait",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "impl_item": {
          const typeNode = node.childForFieldName("type");
          const traitNode = node.childForFieldName("trait");
          if (typeNode) {
            const name = traitNode ? `${traitNode.text} for ${typeNode.text}` : typeNode.text;
            symbols.push({
              name,
              kind: "impl",
              exported: false,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "const_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "const",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "static_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "const",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "mod_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "module",
              exported: hasPub,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "macro_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "macro",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "use_declaration": {
          const argNode = node.childForFieldName("argument");
          if (argNode) {
            const normalized = argNode.text.replace(/::/g, "/");
            imports.push({ module: normalized, raw: node.text });
          }
          break;
        }
      }

      for (const child of node.children ?? node.namedChildren) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return { symbols, imports };
  },
};

/**
 * Regex-based fallback used when tree-sitter WASM is unavailable
 * (e.g., offline first run without bundled grammars).
 * Preserves the pre-upgrade behavior.
 */
function rustRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;

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
}
