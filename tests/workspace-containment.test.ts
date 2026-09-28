import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideWorkspace, isWorkspaceEscapingPath } from "../src/graph/workspace-containment";

function scratch(): { root: string; sibling: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "containment-"));
  const root = join(base, "project");
  const sibling = join(base, "other-project");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(sibling, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(sibling, "src", "b.ts"), "export const b = 2;\n");
  return { root, sibling, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("workspace containment", () => {
  it("accepts files inside the root", () => {
    const { root, cleanup } = scratch();
    try {
      expect(isInsideWorkspace(root, join(root, "src", "a.ts"))).toBe(true);
      expect(isInsideWorkspace(root, join(root, "src"))).toBe(true);
      expect(isInsideWorkspace(root, root)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects a sibling project, which is the leak found in the wild", () => {
    const { root, sibling, cleanup } = scratch();
    try {
      expect(isInsideWorkspace(root, join(sibling, "src", "b.ts"))).toBe(false);
      // The shape that actually got indexed: a relative path walking out.
      expect(isInsideWorkspace(root, "../other-project/src/b.ts")).toBe(false);
      expect(isInsideWorkspace(root, "../../elsewhere/x.ts")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a symlink inside the root that points outside it", () => {
    // Passes every lexical check — the path is textually local — and would
    // otherwise import a whole foreign tree through a path that looks fine.
    const { root, sibling, cleanup } = scratch();
    try {
      const link = join(root, "src", "looks-local.ts");
      symlinkSync(join(sibling, "src", "b.ts"), link);
      expect(isInsideWorkspace(root, link)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts a relative path resolved against the root", () => {
    const { root, cleanup } = scratch();
    try {
      expect(isInsideWorkspace(root, "src/a.ts")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("falls back to the lexical check when the path does not exist", () => {
    const { root, cleanup } = scratch();
    try {
      // A fresh workspace has files that do not exist yet. That is not evidence
      // the path is foreign, and the caller's statSync will report the real error.
      expect(isInsideWorkspace(root, join(root, "src", "not-yet.ts"))).toBe(true);
      expect(isInsideWorkspace(root, join(root, "..", "sibling", "new.ts"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("classifies stored relative paths without touching the filesystem", () => {
    expect(isWorkspaceEscapingPath("../other/f.ts")).toBe(true);
    expect(isWorkspaceEscapingPath("src/../../other/f.ts")).toBe(true);
    expect(isWorkspaceEscapingPath("..\\other\\f.ts")).toBe(true);
    expect(isWorkspaceEscapingPath("src/graph/f.ts")).toBe(false);
    expect(isWorkspaceEscapingPath("a..b/f.ts")).toBe(false);
  });
});
