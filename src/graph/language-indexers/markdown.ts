import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import type { GraphEdge } from "../../core/types.js";

export const markdownIndexer: LanguageIndexer = {
  language: "markdown",
  extensions: [".md"],
  extract(filePath: string, content: string): ExtractionResult {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const lines = content.split(/\r?\n/);

    let frontmatterTitle: string | undefined;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line === "---") break;
        const match = /^(\w[\w-]*):\s*(.+)/.exec(line ?? "");
        if (match && match[1] === "title") {
          frontmatterTitle = match[2]!.trim();
        }
      }
    }

    interface HeadingInfo {
      line: number;
      level: number;
      text: string;
    }
    const headings: HeadingInfo[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/;
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    const mdLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";

      const headingMatch = headingRegex.exec(line);
      if (headingMatch) {
        headings.push({
          line: i + 1,
          level: headingMatch[1]!.length,
          text: headingMatch[2]!.trim(),
        });
      }

      let wikiMatch: RegExpExecArray | null;
      wikiLinkRegex.lastIndex = 0;
      while ((wikiMatch = wikiLinkRegex.exec(line)) !== null) {
        imports.push({ module: wikiMatch[1]!.trim() });
      }

      let mdMatch: RegExpExecArray | null;
      mdLinkRegex.lastIndex = 0;
      while ((mdMatch = mdLinkRegex.exec(line)) !== null) {
        const text = mdMatch[1]?.trim() ?? "";
        const url = mdMatch[2]?.trim() ?? "";
        imports.push({ module: url, raw: text });
      }
    }

    for (const heading of headings) {
      const headingLine = lines[heading.line - 1] ?? "";
      symbols.push({
        name: heading.text.slice(0, 120),
        kind: "section",
        exported: true,
        line: heading.line,
        file: filePath,
        jsdoc: `#${heading.level}`,
        signature: headingLine.trim(),
      });
    }

    if (frontmatterTitle && symbols.length > 0 && symbols[0]?.kind === "section") {
      symbols[0]!.name = frontmatterTitle.slice(0, 120);
    }

    if (headings.length === 0) {
      const chunkContent = content.trim();
      if (chunkContent) {
        symbols.push({
          name: chunkContent.slice(0, 80),
          kind: "chunk",
          exported: true,
          line: 1,
          file: filePath,
          signature: chunkContent,
        });
      }
    } else {
      let contentStartLine = 1;
      if (lines[0]?.trim() === "---") {
        for (let i = 1; i < lines.length; i++) {
          if (lines[i]?.trim() === "---") {
            contentStartLine = i + 2;
            break;
          }
        }
      }

      for (let i = 0; i < headings.length; i++) {
        const heading = headings[i]!;
        const nextHeading = headings[i + 1];
        const startLine = i === 0 ? contentStartLine : heading.line + 1;
        const endLine = nextHeading ? nextHeading.line - 1 : lines.length;

        if (startLine <= endLine) {
          const chunkLines: string[] = [];
          for (let j = startLine; j <= endLine; j++) {
            chunkLines.push(lines[j - 1] ?? "");
          }
          const chunkContent = chunkLines.join("\n").trim();

          if (chunkContent) {
            symbols.push({
              name: `chunk: ${heading.text.slice(0, 70)}`,
              kind: "chunk",
              exported: true,
              line: startLine,
              file: filePath,
              signature: chunkContent,
            });
          }
        }
      }
    }

    return { symbols, imports };
  },
};

interface SymbolRef {
  nodeId: string;
  kind: string;
  line: number;
}

export function buildDocumentEdges(
  fileNodeId: string,
  symbols: SymbolRef[]
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const sections = symbols.filter((s) => s.kind === "section");
  const chunks = symbols.filter((s) => s.kind === "chunk");

  sections.sort((a, b) => a.line - b.line);
  chunks.sort((a, b) => a.line - b.line);

  for (const section of sections) {
    edges.push({ from: section.nodeId, to: fileNodeId, relation: "part_of" });
  }

  for (let i = 0; i < sections.length - 1; i++) {
    edges.push({
      from: sections[i]!.nodeId,
      to: sections[i + 1]!.nodeId,
      relation: "next_section",
    });
  }

  for (const chunk of chunks) {
    const chunkLine = chunk.line;
    let parentSection: (typeof sections)[number] | undefined;
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i]!.line < chunkLine) {
        parentSection = sections[i];
        break;
      }
    }
    if (parentSection) {
      edges.push({
        from: chunk.nodeId,
        to: parentSection.nodeId,
        relation: "part_of",
      });
    } else {
      edges.push({
        from: chunk.nodeId,
        to: fileNodeId,
        relation: "part_of",
      });
    }
  }

  return edges;
}
