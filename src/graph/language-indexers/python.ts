import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

export const pythonIndexer: LanguageIndexer = {
  language: "python",
  extensions: [".py"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const parser = await getTreeSitterParser("python");
    const tree = parser.parse(content);

    const traverse = (node: TreeSitterSyntaxNode) => {
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
            // Count actual parameters (excluding punctuation like '(' and ',')
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
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return { symbols, imports };
  },
};
