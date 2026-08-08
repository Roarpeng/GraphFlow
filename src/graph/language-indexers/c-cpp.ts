import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, walkTreeSitterAst, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

const FUNC_NAME_BLACKLIST = new Set([
  "if", "else", "for", "while", "switch", "return", "do", "case", "sizeof", "typeof",
  "new", "delete", "throw", "try", "catch", "operator",
]);

/**
 * C/C++ indexer using tree-sitter AST (upgraded from line-level regex).
 *
 * Extracts: functions, classes/structs, enums, typedefs, macros (#define),
 * namespaces, includes (#include).
 *
 * Visibility is approximated: `static` → not exported, everything else → exported.
 */
export const cppIndexer: LanguageIndexer = {
  language: "c-cpp",
  extensions: [".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const lower = filePath.toLowerCase();
    const useCppGrammar = [".cpp", ".cc", ".cxx", ".hpp", ".hxx"].some((ext) => lower.endsWith(ext));

    let tree;
    try {
      const parser = await getTreeSitterParser(useCppGrammar ? "cpp" : "c");
      tree = parser.parse(content);
    } catch {
      try {
        const parser = await getTreeSitterParser("c");
        tree = parser.parse(content);
      } catch {
        return cppRegexFallback(filePath, content);
      }
    }

    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    // Iterative walk — recursive DFS overflows on large C/C++ ASTs
    // ("Maximum call stack size exceeded" when indexing big projects).
    walkTreeSitterAst(tree.rootNode, (node) => {
      const lineNo = node.startPosition.row + 1;

      switch (node.type) {
        case "function_definition": {
          if (node.text.startsWith("class ")) {
            const match = node.text.match(/class\s+(\w+)/);
            const className = match?.[1];
            if (className) {
              symbols.push({
                name: className,
                kind: "class",
                exported: true,
                line: lineNo,
                file: filePath,
              });
            }
            break;
          }
          const name = extractFunctionName(node);
          if (name && !FUNC_NAME_BLACKLIST.has(name)) {
            const isStatic = hasStorageClass(node, "static");
            let paramsCount = 0;
            const paramsNode = findChildByType(node, "parameter_list");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "parameter_declaration"
              ).length;
            }
            symbols.push({
              name,
              kind: "function",
              exported: !isStatic,
              line: lineNo,
              file: filePath,
              paramsCount,
            });
          }
          break;
        }
        case "declaration": {
          if (isClassDeclaration(node)) {
            const nameNode = findChildByType(node, "type_identifier");
            if (nameNode) {
              symbols.push({
                name: nameNode.text,
                kind: "class",
                exported: true,
                line: lineNo,
                file: filePath,
              });
            }
          } else if (isFunctionPrototype(node)) {
            const name = extractFunctionName(node);
            if (name && !FUNC_NAME_BLACKLIST.has(name)) {
              const isStatic = hasStorageClass(node, "static");
              let paramsCount = 0;
              const paramsNode = findChildByType(node, "parameter_list");
              if (paramsNode) {
                paramsCount = paramsNode.namedChildren.filter(
                  (c) => c.type === "parameter_declaration"
                ).length;
              }
              symbols.push({
                name,
                kind: "function",
                exported: !isStatic,
                line: lineNo,
                file: filePath,
                paramsCount,
              });
            }
          }
          break;
        }
        case "class_specifier": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "class",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "struct_specifier": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "struct",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "enum_specifier": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "enum",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "type_definition": {
          const nameNode = findChildByType(node, "type_identifier");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "type",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "preproc_def": {
          // #define NAME value
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
        case "namespace_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "namespace",
              exported: true,
              line: lineNo,
              file: filePath,
            });
          }
          break;
        }
        case "preproc_include": {
          // #include <path> or #include "path"
          const pathNode = node.childForFieldName("path");
          if (pathNode) {
            const text = pathNode.text.replace(/[<>"]/g, "");
            imports.push({ module: text, raw: node.text });
          }
          break;
        }
      }
    });

    return { symbols, imports };
  },
};

function isFunctionPrototype(node: TreeSitterSyntaxNode): boolean {
  // A declaration is a function prototype if it contains a parameter_list
  // but no compound_statement (body). Prefer namedChildren to avoid walking
  // every punctuation token on large declarators.
  const kids = node.namedChildren;
  const hasParams = kids.some((c) => c.type === "parameter_list");
  const hasBody = kids.some((c) => c.type === "compound_statement");
  return hasParams && !hasBody;
}

function extractFunctionName(node: TreeSitterSyntaxNode): string | null {
  // Look for the function_declarator child, then its identifier
  const declarator = findChildByType(node, "function_declarator");
  if (declarator) {
    const decl = declarator.childForFieldName("declarator");
    if (decl) {
      return decl.text;
    }
  }
  // Fallback: look for identifier directly
  const identifier = findChildByType(node, "identifier");
  return identifier ? identifier.text : null;
}

function findChildByType(node: TreeSitterSyntaxNode, type: string): TreeSitterSyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  // Some grammars expose field-only nodes via children; fall back lightly.
  for (const child of node.children ?? []) {
    if (child.type === type) return child;
  }
  return null;
}

function hasStorageClass(node: TreeSitterSyntaxNode, storageClass: string): boolean {
  return (
    node.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === storageClass) ||
    (node.children?.some((c) => c.type === "storage_class_specifier" && c.text === storageClass) ?? false)
  );
}

function isClassDeclaration(node: TreeSitterSyntaxNode): boolean {
  return (
    node.namedChildren.some((c) => c.type === "class_specifier") ||
    (node.children?.some((c) => c.type === "class_specifier") ?? false)
  );
}
/**
 * Regex-based fallback used when tree-sitter WASM is unavailable.
 * Preserves the pre-upgrade behavior.
 */
function cppRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];

  const RE_FUNC = /^\s*((?:(?:static|inline|extern|virtual|constexpr|explicit|friend)\s+)*)((?:[\w:*&<>~]+\s+)+)(\w+)\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:=\s*\w+\s*)?[;{]/;
  const RE_CLASS = /^\s*(class|struct)\s+(\w+)\s*(?:final\s*)?[:{]/;
  const RE_ENUM = /^\s*enum(?:\s+class)?\s+(\w+)/;
  const RE_TYPEDEF = /^\s*typedef\s+.+?\s+(\w+)\s*;/;
  const RE_DEFINE = /^\s*#\s*define\s+(\w+)/;
  const RE_NAMESPACE = /^\s*namespace\s+(\w+)/;
  const RE_INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/;

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
}
