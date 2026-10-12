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

function scalaVisibility(node: TreeSitterSyntaxNode): {
  visibility: "public" | "protected" | "private";
  exported: boolean;
} {
  const text = node.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
  if (/\bprivate\b/.test(text)) {
    return { visibility: "private", exported: false };
  }
  if (/\bprotected\b/.test(text)) {
    return { visibility: "protected", exported: true };
  }
  return { visibility: "public", exported: true };
}

/** Parent type names inside an `extends_clause` (handles compound_type base/extra members). */
function scalaParents(node: TreeSitterSyntaxNode): string[] {
  const parents: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "type_identifier") {
      parents.push(child.text);
    } else if (child.type === "compound_type" || child.type === "infix_type") {
      for (const inner of child.namedChildren) {
        if (inner.type === "type_identifier") {
          parents.push(inner.text);
        }
      }
    }
  }
  return parents;
}

function scalaCalleeName(node: TreeSitterSyntaxNode | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "field_expression") {
    const fieldNode = node.childForFieldName("field");
    if (fieldNode) {
      return fieldNode.text;
    }
  }
  return undefined;
}

/**
 * Scala indexer using tree-sitter AST.
 *
 * Extracts: classes (incl. case classes), traits, objects, defs
 * (function vs method by enclosing template_body), val/var properties,
 * imports, calls, inheritance (extends_clause parents; `with` mixins are
 * part of the compound type).
 */
export const scalaIndexer: LanguageIndexer = {
  language: "scala",
  extensions: [".scala"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const calls: CallRelation[] = [];
    const inherits: InheritRelation[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("scala");
      tree = parser.parse(content);
    } catch {
      return scalaRegexFallback(filePath, content);
    }

    walkTreeSitterAstWithState(tree.rootNode, undefined as string | undefined, (node, caller) => {
      const lineNo = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;

      switch (node.type) {
        case "class_definition":
        case "trait_definition":
        case "object_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const { visibility, exported } = scalaVisibility(node);
            symbols.push({
              name,
              kind: node.type === "class_definition"
                ? "class"
                : node.type === "trait_definition"
                  ? "trait"
                  : "object",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
            });

            const extendsClause = node.childForFieldName("extend");
            if (extendsClause) {
              for (const parent of scalaParents(extendsClause)) {
                inherits.push({ child: name, parent, kind: "extends", line: lineNo });
              }
            }
          }
          break;
        }
        case "function_definition":
        case "function_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const isMethod = node.parent?.type === "template_body";
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter((c) => c.type === "parameter").length;
            }
            let returnType: string | undefined;
            const retNode = node.childForFieldName("return_type");
            if (retNode) {
              returnType = retNode.text.slice(0, 80);
            }
            const { visibility, exported } = scalaVisibility(node);
            symbols.push({
              name,
              kind: isMethod ? "method" : "function",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
              paramsCount,
              ...(returnType ? { returnType } : {}),
              signature: `def ${name}(${paramsCount} params)`,
            });
            return name;
          }
          break;
        }
        case "val_definition":
        case "var_definition": {
          const patternNode = node.childForFieldName("pattern");
          if (patternNode && patternNode.type === "identifier") {
            const { visibility, exported } = scalaVisibility(node);
            symbols.push({
              name: patternNode.text,
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
        case "import_declaration": {
          const pathNode = node.childForFieldName("path");
          const raw = pathNode?.text ?? node.text.replace(/^import\s+/, "");
          const cleaned = raw.replace(/\{.*$/, "").replace(/\.$/, "").trim();
          if (cleaned) {
            imports.push({ module: cleaned, raw: node.text });
          }
          break;
        }
        case "call_expression": {
          const callee = scalaCalleeName(node.childForFieldName("function"));
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
function scalaRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_IMPORT = /^\s*import\s+(?:@\w+\s+)?([\w.*{}[\],\s]+)/;
  const RE_CLASS = /^\s*(?:(?:private|protected|abstract|sealed|final|case|implicit)\s+)*class\s+(\w+)/;
  const RE_TRAIT = /^\s*(?:(?:private|protected|sealed)\s+)*trait\s+(\w+)/;
  const RE_OBJECT = /^\s*(?:(?:private|protected|final|case)\s+)*object\s+(\w+)/;
  const RE_DEF = /^\s*(?:(?:private|protected|override|final|implicit|lazy)\s+)*def\s+(\w+)/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      const cleaned = importMatch[1]!.replace(/\{.*$/, "").replace(/\.$/, "").trim();
      if (cleaned) {
        imports.push({ module: cleaned, raw: line.trim() });
      }
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: "class", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const traitMatch = RE_TRAIT.exec(line);
    if (traitMatch) {
      symbols.push({ name: traitMatch[1]!, kind: "trait", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const objectMatch = RE_OBJECT.exec(line);
    if (objectMatch) {
      symbols.push({ name: objectMatch[1]!, kind: "object", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const defMatch = RE_DEF.exec(line);
    if (defMatch) {
      symbols.push({ name: defMatch[1]!, kind: "function", exported: true, line: lineNo, file: filePath });
    }
  }

  return { symbols, imports };
}
