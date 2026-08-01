/**
 * plcopen-xml.ts — PLCopen XML indexer (IEC 61131-10 / Beremiz / OpenPLC)
 *
 * Regex-based parser that extracts POU, variable, task, and ST code
 * symbols from PLCopen TC6-compliant XML project files.
 *
 * NOTE: PLC XML files can exceed DEFAULT_MAX_FILE_SIZE (200 KB) for
 * large projects with many SFC steps or inlined data. Consider raising
 * `maxFileSizeBytes` when indexing large PLC workspaces.
 */

import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import type { GraphEdge } from "../../core/types.js";
import type { IndexedSymbol } from "../file-indexer-nodes.js";

const PROJECT_TAG_RE = /<project\s+[^>]*xmlns\s*=\s*"[^"]*plcopen[^"]*"/i;

const VAR_SCOPE_TAGS = [
  "localVars",
  "inputVars",
  "outputVars",
  "inOutVars",
  "tempVars",
];

function isPlcOpenXml(content: string): boolean {
  return PROJECT_TAG_RE.test(content);
}

function extractTypeName(typeContent: string): string {
  const derived = typeContent.match(/<derived\s+name="([^"]+)"/);
  if (derived?.[1]) return derived[1];

  const baseType = typeContent.match(/<baseType>\s*<(\w+)\s*\/?>/);
  if (baseType?.[1]) return baseType[1];

  if (/<array>/.test(typeContent)) return "ARRAY";

  const simple = typeContent.match(/<(\w+)\s*\/?>/);
  if (simple?.[1]) return simple[1];

  return "UNKNOWN";
}

function extractReturnType(
  pouBody: string,
  pouName: string,
  filePath: string,
  symbols: DeclaredSymbol[],
): void {
  const rtRe = /<returnType>\s*(?:<type>([\s\S]*?)<\/type>|([\s\S]*?))\s*<\/returnType>/i;
  const m = rtRe.exec(pouBody);
  const typeContent = (m?.[1] ?? m?.[2])?.trim();
  if (typeContent) {
    const retType = extractTypeName(typeContent);
    symbols.push({
      name: `${pouName}.return`,
      kind: "variable",
      line: 0,
      exported: true,
      signature: `VAR_RETURN ${retType} ${pouName}`,
      jsdoc: `${pouName}:returnType`,
      file: filePath,
    });
  }
}

function extractPouVariables(
  pouBody: string,
  pouName: string,
  filePath: string,
  symbols: DeclaredSymbol[],
  imports: ImportTarget[],
): void {
  for (const scopeTag of VAR_SCOPE_TAGS) {
    const scopeRe = new RegExp(
      `<${scopeTag}>([\\s\\S]*?)</${scopeTag}>`,
      "gi",
    );
    let scopeMatch: RegExpExecArray | null;
    while ((scopeMatch = scopeRe.exec(pouBody)) !== null) {
      const scopeBody = scopeMatch[1];
      if (!scopeBody) continue;

      const varRe =
        /<variable\s+name="([^"]+)">\s*<type>([\s\S]*?)<\/type>/gi;
      let varMatch: RegExpExecArray | null;
      while ((varMatch = varRe.exec(scopeBody)) !== null) {
        const varName = varMatch[1];
        const typeContentRaw = varMatch[2];
        if (!varName || !typeContentRaw) continue;

        const typeContent = typeContentRaw.trim();
        const varType = extractTypeName(typeContent);

        const fullName = `${pouName}.${varName}`;
        symbols.push({
          name: fullName,
          kind: "variable",
          line: 0,
          exported: true,
          signature: `VAR ${varType} ${fullName}`,
          jsdoc: `${pouName}:${scopeTag}`,
          file: filePath,
        });

        const derived = typeContent.match(/<derived\s+name="([^"]+)"/);
        if (derived?.[1]) {
          imports.push({ module: `pou:${derived[1]}` });
        }
      }
    }
  }
}

function extractStCode(
  pouBody: string,
  pouName: string,
  filePath: string,
  symbols: DeclaredSymbol[],
): void {
  const stRe = /<ST>\s*<xhtml>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/xhtml>\s*<\/ST>/gi;
  let match: RegExpExecArray | null;
  while ((match = stRe.exec(pouBody)) !== null) {
    const code = match[1]?.trim();
    if (!code) continue;
    symbols.push({
      name: `${pouName}.st_code`,
      kind: "code",
      line: 0,
      exported: true,
      signature: code,
      file: filePath,
    });
  }
}

function extractTasks(
  xml: string,
  filePath: string,
  symbols: DeclaredSymbol[],
): void {
  const resourceRe = /<resource\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/resource>/g;
  let resourceMatch: RegExpExecArray | null;
  while ((resourceMatch = resourceRe.exec(xml)) !== null) {
    const resourceName = resourceMatch[1];
    const resourceBody = resourceMatch[2];
    if (!resourceName || !resourceBody) continue;

    const taskRe =
      /<task\s+name="([^"]+)"(?:\s+priority="(\d+)")?(?:\s+interval="([^"]+)")?/gi;
    let taskMatch: RegExpExecArray | null;
    while ((taskMatch = taskRe.exec(resourceBody)) !== null) {
      const taskName = taskMatch[1];
      if (!taskName) continue;
      const priority = taskMatch[2] ?? "0";
      const interval = taskMatch[3] ?? "N/A";
      symbols.push({
        name: `task.${taskName}`,
        kind: "task",
        line: 0,
        exported: true,
        signature: `TASK ${taskName} interval=${interval} prio=${priority}`,
        jsdoc: `resource=${resourceName}`,
        file: filePath,
      });
    }
  }
}

function extractInstanceRefs(xml: string, imports: ImportTarget[]): void {
  const re = /<pouInstance\s+name="([^"]+)"\s+typeName="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const typeName = match[2];
    if (!typeName) continue;
    imports.push({ module: `pou:${typeName}` });
  }
}

function extract(filePath: string, content: string): ExtractionResult {
  if (!isPlcOpenXml(content)) {
    return { symbols: [], imports: [] };
  }

  const cleanXml = content.replace(/<!--[\s\S]*?-->/g, "");

  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];

  const pouRe =
    /<pou\s+[^>]*?\bname="([^"]+)"[^>]*?\bpouType="([^"]+)"[^>]*>([\s\S]*?)<\/pou>/g;
  let pouMatch: RegExpExecArray | null;
  while ((pouMatch = pouRe.exec(cleanXml)) !== null) {
    const pouName = pouMatch[1];
    const pouType = pouMatch[2];
    const pouBody = pouMatch[3];
    if (!pouName || !pouType) continue;

    symbols.push({
      name: pouName,
      kind: "pou",
      line: 0,
      exported: true,
      signature: `POU ${pouType} ${pouName}`,
      jsdoc: pouType,
      file: filePath,
    });

    if (pouBody) {
      extractReturnType(pouBody, pouName, filePath, symbols);
      extractPouVariables(pouBody, pouName, filePath, symbols, imports);
      extractStCode(pouBody, pouName, filePath, symbols);
    }
  }

  extractTasks(cleanXml, filePath, symbols);
  extractInstanceRefs(cleanXml, imports);

  return { symbols, imports };
}

export function buildPlcEdges(
  fileNodeId: string,
  symbols: IndexedSymbol[],
  _imports: string[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const sym of symbols) {
    if (sym.kind === "variable" && sym.jsdoc) {
      const pouName = sym.jsdoc.split(":")[0]!;
      const pouNode = symbols.find(
        (s) => s.kind === "pou" && s.name === pouName,
      );
      if (pouNode?.nodeId && sym.nodeId) {
        edges.push({
          from: pouNode.nodeId,
          to: sym.nodeId,
          relation: "depends_on",
        });
      }
    }

    if (sym.kind === "code") {
      const pouName = sym.name.replace(".st_code", "");
      const pouNode = symbols.find(
        (s) => s.kind === "pou" && s.name === pouName,
      );
      if (pouNode?.nodeId && sym.nodeId) {
        edges.push({
          from: pouNode.nodeId,
          to: sym.nodeId,
          relation: "depends_on",
        });
      }
    }

    if (sym.kind === "task" && sym.nodeId) {
      edges.push({
        from: fileNodeId,
        to: sym.nodeId,
        relation: "depends_on",
      });
    }
  }

  return edges;
}

export const plcopenIndexer: LanguageIndexer = {
  language: "plcopen",
  extensions: [".xml"],
  extract,
};
