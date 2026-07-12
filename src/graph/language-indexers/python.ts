import type { CallRelation, DeclaredSymbol, ExtractionResult, ImportTarget, InheritRelation, LanguageIndexer } from "./index.js";
import { parseFileIncremental } from "./incremental-parse.js";
import type { TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

export const pythonIndexer: LanguageIndexer = {
  language: "python",
  extensions: [".py"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const calls: CallRelation[] = [];
    const inherits: InheritRelation[] = [];
    const tree = await parseFileIncremental(filePath, "python", content);

    const traverse = (node: TreeSitterSyntaxNode, caller?: string) => {
      const lineNo = node.startPosition.row + 1;

      if (node.type === "class_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: "class",
            exported: !name.startsWith("_"),
            line: lineNo,
            file: filePath,
          });

          // Extract inheritance: superclasses field
          const superclassesNode = node.childForFieldName("superclasses");
          if (superclassesNode) {
            for (const arg of superclassesNode.namedChildren) {
              // argument_list children are the base class expressions
              const parentText = arg.text.trim();
              if (parentText && parentText !== "(" && parentText !== ")") {
                inherits.push({
                  child: name,
                  parent: parentText,
                  kind: "extends",
                  line: lineNo,
                });
              }
            }
          }
        }
      } else if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const parentType = node.parent?.type;
          const kind = parentType === "block" && node.parent?.parent?.type === "class_definition" ? "method" : "function";

          let paramsCount = 0;
          const parametersNode = node.childForFieldName("parameters");
          if (parametersNode) {
            paramsCount = parametersNode.namedChildren.length;
          }

          symbols.push({
            name,
            kind,
            exported: !name.startsWith("_"),
            line: lineNo,
            file: filePath,
            paramsCount,
          });

          // This function is the caller for nested call expressions
          caller = name;
        }
      } else if (node.type === "call") {
        // Extract function call: the "function" field holds the callee expression
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          let calleeName: string | undefined;
          if (funcNode.type === "identifier") {
            calleeName = funcNode.text;
          } else if (funcNode.type === "attribute") {
            // e.g. self.method() or obj.method() → extract the attribute name
            const attrNode = funcNode.childForFieldName("attribute");
            if (attrNode) {
              calleeName = attrNode.text;
            }
          }
          if (calleeName) {
            calls.push({
              callee: calleeName,
              ...(caller ? { caller } : {}),
              line: lineNo,
            });
          }
        }
      } else if (node.type === "import_statement") {
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name" || child.type === "aliased_import") {
            const nameNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
            if (nameNode) {
              imports.push({ module: nameNode.text.replace(/\./g, "/"), raw: node.text });
            }
          }
        }
      } else if (node.type === "import_from_statement") {
        const moduleNameNode = node.childForFieldName("module_name");
        if (moduleNameNode) {
          let modName = moduleNameNode.text;
          if (modName.startsWith(".")) {
            let upLevel = 0;
            while (modName.startsWith(".")) {
              upLevel++;
              modName = modName.slice(1);
            }
            const parts = filePath.split(/[\\/]/);
            // parts.length - 1 is the directory
            const dirParts = parts.slice(0, parts.length - upLevel);
            if (modName) {
              dirParts.push(...modName.split("."));
            }
            imports.push({ module: dirParts.join("/"), raw: node.text });
          } else {
            imports.push({ module: modName.replace(/\./g, "/"), raw: node.text });
          }
        }
      }

      for (const child of node.children ?? node.namedChildren) {
        traverse(child, caller);
      }
    };

    traverse(tree.rootNode);
    return { symbols, imports, calls, inherits };
  },
};
