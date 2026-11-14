/** Optional, bounded LSP reference check for a low-confidence read result. */
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createLspBridge, findAvailableLspPreset } from "./lsp-bridge.js";
import { getWorkspaceAstIndex, normalizeWorkspaceRelPath } from "./slicer.js";

const LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp",
};

export async function escalateReadReferences(rootDir: string, target: string): Promise<{ confidence: "lsp"; text: string } | undefined> {
  const [filePart, name] = target.split("#", 2);
  if (!filePart || !name) return undefined;
  const file = normalizeWorkspaceRelPath(rootDir, filePart);
  if (!file) return undefined;
  const language = LANGUAGE[extname(file).toLowerCase()];
  if (!language) return undefined;
  const preset = findAvailableLspPreset(language);
  if (!preset) return undefined;
  const data = getWorkspaceAstIndex(rootDir).getFileAnalysis(file);
  const symbol = data?.ast.symbols.find((s) => s.name === name || `${s.parentClass}.${s.name}` === name);
  if (!symbol || !data) return undefined;
  const line = data.content.split(/\r?\n/)[symbol.line - 1] ?? "";
  const character = Math.max(0, line.indexOf(symbol.name));
  const bridge = await createLspBridge({ ...preset, cwd: rootDir, requestTimeoutMs: 1200,
    initializeTimeoutMs: 1200, restartLimit: 0 });
  if (!bridge) return undefined;
  try {
    const refs = await bridge.references(resolve(rootDir, file), symbol.line - 1, character);
    const inside = refs.filter((ref) => {
      if (!isAbsolute(ref.file)) return false;
      const rel = relative(rootDir, ref.file);
      return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    });
    if (inside.length === 0) return undefined;
    const lines = inside.slice(0, 8).map((ref) => `  -> ${relative(rootDir, ref.file).replace(/\\/g, "/")}:${ref.line + 1}`);
    return { confidence: "lsp", text: `// [LSP References: ${inside.length}, confidence=verified]\n${lines.join("\n")}` };
  } finally { await bridge.dispose(); }
}
