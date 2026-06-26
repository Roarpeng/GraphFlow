import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveBundledWasmPath,
  type TreeSitterLanguage,
} from "../src/graph/language-indexers/tree-sitter-loader.js";

const GRAMMARS: TreeSitterLanguage[] = ["python", "go", "rust", "c", "cpp", "java", "ruby"];

describe("M54 bundled wasm grammars", () => {
  it("resolves all required grammars from the bundled wasm directory", () => {
    const repoWasmDir = join(process.cwd(), "wasm");
    if (!existsSync(repoWasmDir)) {
      return;
    }

    for (const language of GRAMMARS) {
      const resolved = resolveBundledWasmPath(language);
      expect(resolved, `missing bundled grammar for ${language}`).toBeTruthy();
      expect(resolved!.includes(`tree-sitter-${language}.wasm`)).toBe(true);
    }
  });
});
