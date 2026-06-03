import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser } from "./tree-sitter-loader.js";

function isExported(name: string): boolean {
  if (!name) return false;
  const first = name.charAt(0);
  return first >= "A" && first <= "Z";
}

export const goIndexer: LanguageIndexer = {
  language: "go",
  extensions: [".go"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const parser = await getTreeSitterParser("go");
    const tree = parser.parse(content);

    const traverse = (node: any) => {
      const lineNo = node.startPosition.row + 1;

      if (node.type === "package_clause") {
        const nameNode = node.childForFieldName("package_identifier") || node.namedChildren[0];
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: "package",
            exported: true,
            line: lineNo,
            file: filePath,
          });
        }
      } else if (node.type === "function_declaration" || node.type === "method_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          let paramsCount = 0;
          const paramsNode = node.childForFieldName("parameters");
          if (paramsNode) {
            paramsCount = paramsNode.namedChildren.filter((c: any) => c.type === "parameter_declaration").length;
          }
          
          symbols.push({
            name,
            kind: node.type === "method_declaration" ? "method" : "func",
            exported: isExported(name),
            line: lineNo,
            file: filePath,
            paramsCount,
          });
        }
      } else if (node.type === "type_spec") {
        const nameNode = node.childForFieldName("name");
        const typeNode = node.childForFieldName("type");
        if (nameNode) {
          const name = nameNode.text;
          const kind = typeNode && typeNode.type === "struct_type" ? "struct" : 
                       typeNode && typeNode.type === "interface_type" ? "interface" : "type";
          symbols.push({
            name,
            kind,
            exported: isExported(name),
            line: lineNo,
            file: filePath,
          });
        }
      } else if (node.type === "import_spec") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          // Go string literals include quotes
          const text = pathNode.text.replace(/^"|"$/g, '');
          imports.push({ module: text, raw: node.text });
        }
      } else if (node.type === "var_spec" || node.type === "const_spec") {
        const nameNodes = node.namedChildren.filter((c: any) => c.type === "identifier");
        for (const nameNode of nameNodes) {
          const name = nameNode.text;
          symbols.push({
            name,
            kind: node.type === "const_spec" ? "const" : "variable",
            exported: isExported(name),
            line: lineNo,
            file: filePath,
          });
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
