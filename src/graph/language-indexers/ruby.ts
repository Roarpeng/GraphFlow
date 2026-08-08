import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, walkTreeSitterAst } from "./tree-sitter-loader.js";

/**
 * Ruby indexer using tree-sitter AST.
 *
 * Extracts: methods, classes, modules, constants, singleton methods.
 *
 * Visibility is inferred from method naming convention:
 *   - `public` by default
 *   - `private` if name starts with `_` or declared under `private` keyword
 *
 * Borrowed from codebase-memory-mcp's broad language support pattern.
 */
export const rubyIndexer: LanguageIndexer = {
  language: "ruby",
  extensions: [".rb", ".rake", ".gemspec"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("ruby");
      tree = parser.parse(content);
    } catch {
      return rubyRegexFallback(filePath, content);
    }

    let privateScope = false;

    walkTreeSitterAst(tree.rootNode, (node) => {
      const lineNo = node.startPosition.row + 1;

      switch (node.type) {
        case "class": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "class",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "module": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "module",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "method": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) =>
                  c.type === "identifier" ||
                  c.type === "optional_parameter" ||
                  c.type === "keyword_parameter" ||
                  c.type === "splat_parameter" ||
                  c.type === "hash_splat_parameter" ||
                  c.type === "block_parameter"
              ).length;
            }
            const name = nameNode.text;
            const isPrivate = privateScope || name.startsWith("_");
            symbols.push({
              name,
              kind: "method",
              exported: !isPrivate,
              line: lineNo,
              file: filePath,
              visibility: isPrivate ? "private" : "public",
              paramsCount,
              signature: `def ${name}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "singleton_method": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.length;
            }
            symbols.push({
              name: nameNode.text,
              kind: "method",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
              paramsCount,
              signature: `def self.${nameNode.text}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "assignment": {
          // Constants: FOO = ... or FOO::BAR = ...
          const leftNode = node.childForFieldName("left");
          if (leftNode && /^[A-Z][A-Z0-9_]*$/.test(leftNode.text)) {
            symbols.push({
              name: leftNode.text,
              kind: "const",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "call": {
          // Detect `require`/`require_relative`/`include` calls as imports
          const receiver = node.childForFieldName("receiver");
          const methodNode = node.childForFieldName("method");
          const methodName = methodNode?.text ?? "";
          if (!receiver && (methodName === "require" || methodName === "require_relative")) {
            const args = node.childForFieldName("arguments");
            if (args) {
              const argText = args.text.replace(/[\(\)"']/g, "").trim();
              if (argText) {
                imports.push({ module: argText, raw: node.text });
              }
            }
          }
          // Detect `private` keyword (method call without args) toggling scope
          if (!receiver && methodName === "private") {
            const args = node.childForFieldName("arguments");
            if (!args) {
              privateScope = true;
            }
          }
          if (!receiver && methodName === "public") {
            const args = node.childForFieldName("arguments");
            if (!args) {
              privateScope = false;
            }
          }
          break;
        }
      }
    });

    return { symbols, imports };
  },
};

/**
 * Regex-based fallback used when tree-sitter WASM is unavailable.
 */
function rubyRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);
  let privateScope = false;

  const RE_CLASS = /^\s*class\s+([\w:]+)/;
  const RE_MODULE = /^\s*module\s+([\w:]+)/;
  const RE_METHOD = /^\s*def\s+(?:self\.)?([\w=<>!?]+)/;
  const RE_REQUIRE = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/;
  const RE_CONST = /^\s*([A-Z][A-Z0-9_]*)\s*=/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    if (/^\s*private\b/.test(line)) {
      privateScope = true;
      continue;
    }
    if (/^\s*public\b/.test(line)) {
      privateScope = false;
      continue;
    }

    const requireMatch = RE_REQUIRE.exec(line);
    if (requireMatch) {
      imports.push({ module: requireMatch[1]!, raw: line.trim() });
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({
        name: classMatch[1]!,
        kind: "class",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
      continue;
    }

    const moduleMatch = RE_MODULE.exec(line);
    if (moduleMatch) {
      symbols.push({
        name: moduleMatch[1]!,
        kind: "module",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
      continue;
    }

    const methodMatch = RE_METHOD.exec(line);
    if (methodMatch) {
      const name = methodMatch[1]!;
      const isPrivate = privateScope || name.startsWith("_");
      symbols.push({
        name,
        kind: "method",
        exported: !isPrivate,
        line: lineNo,
        file: filePath,
        visibility: isPrivate ? "private" : "public",
      });
      continue;
    }

    const constMatch = RE_CONST.exec(line);
    if (constMatch) {
      symbols.push({
        name: constMatch[1]!,
        kind: "const",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
    }
  }

  return { symbols, imports };
}
