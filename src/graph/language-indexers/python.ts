import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser } from "./tree-sitter-loader.js";

export const pythonIndexer: LanguageIndexer = {
  language: "python",
  extensions: [".py"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const parser = await getTreeSitterParser("python");
    const tree = parser.parse(content);

    const traverse = (node: any) => {
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
              imports.push({ module: nameNode.text, raw: node.text });
            }
          }
        }
      } else if (node.type === "import_from_statement") {
        const moduleNameNode = node.childForFieldName("module_name");
        if (moduleNameNode) {
          imports.push({ module: moduleNameNode.text, raw: node.text });
        }
      }

      for (const child of node.children) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return { symbols, imports };
  },
};
