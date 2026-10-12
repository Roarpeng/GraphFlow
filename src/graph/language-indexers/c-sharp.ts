import type {
  CallRelation,
  DeclaredSymbol,
  ExtractionResult,
  ImportTarget,
  InheritRelation,
  LanguageIndexer,
} from "./index.js";
import {
  getTreeSitterParser,
  walkTreeSitterAstWithState,
  type TreeSitterSyntaxNode,
} from "./tree-sitter-loader.js";

function csharpModifierText(node: TreeSitterSyntaxNode): string {
  return node.namedChildren
    .filter((c) => c.type === "modifier")
    .map((c) => c.text)
    .join(" ");
}

function csharpVisibility(modifierText: string): {
  visibility: "public" | "protected" | "private";
  exported: boolean;
} {
  if (/\bprivate\b/.test(modifierText)) {
    return { visibility: "private", exported: false };
  }
  if (/\bprotected\b/.test(modifierText)) {
    return { visibility: "protected", exported: true };
  }
  return { visibility: "public", exported: true };
}

function csharpCalleeName(node: TreeSitterSyntaxNode | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "member_access_expression" || node.type === "qualified_name") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      return nameNode.text;
    }
    const parts = node.namedChildren.filter((c) => c.type === "identifier");
    return parts.length > 0 ? parts[parts.length - 1]!.text : undefined;
  }
  return undefined;
}

/**
 * C# indexer using tree-sitter AST (grammar ships as tree-sitter-c_sharp.wasm).
 *
 * Extracts: classes, interfaces, structs, enums, records, methods, constructors,
 * fields/consts, properties, imports (using directives), calls, inheritance
 * (base_list: first entry extends, remaining entries implement).
 *
 * Visibility (`public`/`protected`/`private`) is determined by `modifier` children.
 */
export const csharpIndexer: LanguageIndexer = {
  language: "c-sharp",
  extensions: [".cs"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const calls: CallRelation[] = [];
    const inherits: InheritRelation[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("c-sharp");
      tree = parser.parse(content);
    } catch {
      return csharpRegexFallback(filePath, content);
    }

    walkTreeSitterAstWithState(tree.rootNode, undefined as string | undefined, (node, caller) => {
      const lineNo = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const modifierText = csharpModifierText(node);
      const { visibility, exported } = csharpVisibility(modifierText);

      switch (node.type) {
        case "class_declaration":
        case "interface_declaration":
        case "struct_declaration":
        case "enum_declaration":
        case "record_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            symbols.push({
              name,
              kind: node.type === "class_declaration"
                ? "class"
                : node.type === "interface_declaration"
                  ? "interface"
                  : node.type === "struct_declaration"
                    ? "struct"
                    : node.type === "enum_declaration"
                      ? "enum"
                      : "record",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
            });

            const baseList = node.namedChildren.find((c) => c.type === "base_list");
            if (baseList) {
              const parents = baseList.namedChildren.filter((c) => c.text);
              for (let i = 0; i < parents.length; i += 1) {
                inherits.push({
                  child: name,
                  parent: parents[i]!.text,
                  kind: i === 0 ? "extends" : "implements",
                  line: lineNo,
                });
              }
            }
          }
          break;
        }
        case "method_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter((c) => c.type === "parameter").length;
            }
            let returnType: string | undefined;
            const retNode = node.childForFieldName("type");
            if (retNode) {
              returnType = retNode.text.slice(0, 80);
            }
            symbols.push({
              name,
              kind: "method",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
              paramsCount,
              ...(returnType ? { returnType } : {}),
              signature: `${returnType ?? "void"} ${name}(${paramsCount} params)`,
            });
            return name;
          }
          break;
        }
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter((c) => c.type === "parameter").length;
            }
            symbols.push({
              name,
              kind: "constructor",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
              paramsCount,
              signature: `${name}(${paramsCount} params)`,
            });
            return name;
          }
          break;
        }
        case "field_declaration": {
          const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
          const declarators = varDecl
            ? varDecl.namedChildren.filter((c) => c.type === "variable_declarator")
            : [];
          const isConst = /\bconst\b/.test(modifierText);
          for (const declarator of declarators) {
            const nameNode =
              declarator.childForFieldName("name") ??
              declarator.namedChildren.find((c) => c.type === "identifier");
            if (nameNode) {
              symbols.push({
                name: nameNode.text,
                kind: isConst ? "const" : "field",
                exported,
                line: lineNo,
                endLine,
                file: filePath,
                visibility,
              });
            }
          }
          break;
        }
        case "property_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "property",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "using_directive": {
          const nameNode = node.namedChildren.find(
            (c) => c.type === "qualified_name" || c.type === "identifier"
          );
          if (nameNode) {
            imports.push({
              module: nameNode.text.replace(/\./g, "/"),
              raw: node.text,
            });
          }
          break;
        }
        case "invocation_expression": {
          const callee = csharpCalleeName(node.childForFieldName("function"));
          if (callee) {
            calls.push({ callee, ...(caller ? { caller } : {}), line: lineNo });
          }
          break;
        }
      }
      return caller;
    });

    return { symbols, imports, calls, inherits };
  },
};

/**
 * Regex-based fallback used when tree-sitter WASM is unavailable.
 */
function csharpRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const MODIFIERS = "(?:(?:public|internal|protected|private|static|abstract|sealed|partial|readonly|async|virtual|override|extern|unsafe|new|const)\\s+)*";
  const RE_USING = /^\s*using\s+(?:static\s+)?([\w.]+);/;
  const RE_CLASS = new RegExp(`^\\s*${MODIFIERS}class\\s+(\\w+)`);
  const RE_INTERFACE = new RegExp(`^\\s*${MODIFIERS}interface\\s+(\\w+)`);
  const RE_STRUCT = new RegExp(`^\\s*${MODIFIERS}struct\\s+(\\w+)`);
  const RE_ENUM = new RegExp(`^\\s*${MODIFIERS}enum\\s+(\\w+)`);
  const RE_METHOD = new RegExp(`^\\s*${MODIFIERS}[\\w<>\\[\\],.?]+\\s+(\\w+)\\s*\\(([^)]*)\\)`);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const usingMatch = RE_USING.exec(line);
    if (usingMatch) {
      imports.push({
        module: usingMatch[1]!.replace(/\./g, "/"),
        raw: line.trim(),
      });
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: "class", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const ifaceMatch = RE_INTERFACE.exec(line);
    if (ifaceMatch) {
      symbols.push({ name: ifaceMatch[1]!, kind: "interface", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const structMatch = RE_STRUCT.exec(line);
    if (structMatch) {
      symbols.push({ name: structMatch[1]!, kind: "struct", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const enumMatch = RE_ENUM.exec(line);
    if (enumMatch) {
      symbols.push({ name: enumMatch[1]!, kind: "enum", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const methodMatch = RE_METHOD.exec(line);
    if (methodMatch) {
      const paramsStr = methodMatch[2] ?? "";
      const paramsCount = paramsStr.trim() ? paramsStr.split(",").length : 0;
      symbols.push({
        name: methodMatch[1]!,
        kind: "method",
        exported: true,
        line: lineNo,
        file: filePath,
        paramsCount,
      });
    }
  }

  return { symbols, imports };
}
