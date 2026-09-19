import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getToolDefinitions } from "../src/surfaces/mcp/server";

/**
 * Doc/code consistency guard (inspired by ponytail's check-rule-copies.js).
 *
 * The MCP tool list is a single source of truth in code. Docs that
 * hand-maintain copies of it (or of the package version) drift silently — we
 * shipped a README claiming v0.6.13 / 177 tests while code was 0.6.15 / 45
 * files, and later bumped README.md while the Chinese badge and the extension
 * VSIX filenames lagged a release behind. Policy since v1.23.2: user-facing
 * docs are VERSION-LESS by design (dynamic npm badge, `<version>` placeholders,
 * unversioned npx commands); per-release history lives only in CHANGELOG.md.
 * These tests make any reintroduced hardcoded version a CI failure instead of
 * a release-day chore.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/** Files that reference MCP tool names and must stay in sync with code. */
const DOC_FILES = [
  "AGENTS.md",
  "README.md",
  "README.zh.md",
  // The extension README is the VS Code Marketplace / Open VSX listing page: it
  // ships inside the VSIX and is *published*, so it drifts visibly to users.
  "vscode-extension/README.md",
  ".cursor/rules/graphflow.mdc",
  "src/surfaces/cursor-rules/graphflow.mdc",
  "src/surfaces/trae-rules/graphflow.md",
  "src/surfaces/trae-skill/graphflow/SKILL.md",
  "CLAUDE.md",
];

/** Every user-facing README that must stay version-less. */
const README_SURFACES = [
  "README.md",
  "README.zh.md",
  "vscode-extension/README.md",
];

function canonicalizeToolMention(raw: string): string | undefined {
  // DeepSeek Harness public names: mcp__graphflow__graphflow_context
  const name = raw.startsWith("graphflow__") ? raw.slice("graphflow__".length) : raw;
  if (name === "graphflow_" || /^graphflow_+$/.test(name)) {
    return undefined;
  }
  return name;
}

describe("Doc/code consistency", () => {
  const toolNames = getToolDefinitions().map((t) => t.name);
  const toolNameSet = new Set(toolNames);

  it("every graphflow_* tool mentioned in docs exists in the MCP server", () => {
    for (const file of DOC_FILES) {
      if (!existsSync(join(root, file))) continue;
      const content = read(file);
      const mentioned = content.match(/graphflow_[a-z_]+/g) ?? [];
      for (const raw of new Set(mentioned)) {
        const name = canonicalizeToolMention(raw);
        if (!name) continue;
        expect(
          toolNameSet.has(name),
          `${file} references "${raw}" which is not a real MCP tool. ` +
            `Real tools: ${toolNames.join(", ")}`
        ).toBe(true);
      }
    }
  });

  it("AGENTS.md lists the core context/plan/run tools (agent entrypoints)", () => {
    const agents = read("AGENTS.md");
    for (const required of ["graphflow_context", "graphflow_plan", "graphflow_run"]) {
      expect(agents, `AGENTS.md must document ${required}`).toContain(required);
    }
  });

  it("root and vscode-extension versions match", () => {
    const rootPkg = readJson("package.json");
    const extPkg = readJson("vscode-extension/package.json");
    expect(extPkg.version).toBe(rootPkg.version);
  });

  it("README uses the dynamic npm badge, never a hardcoded version badge", () => {
    for (const file of ["README.md", "README.zh.md"]) {
      const content = read(file);
      expect(
        content,
        `${file} must use the dynamic npm badge (img.shields.io/npm/v/@roarpeng/graphflow)`
      ).toContain("img.shields.io/npm/v/@roarpeng/graphflow");
      expect(
        content,
        `${file} must not hardcode a static npm version badge`
      ).not.toMatch(/badge\/npm-\d/);
    }
  });

  it("README does not reference deleted docs/testing artifacts", () => {
    const readme = read("README.md");
    // We removed the stale docs/testing/*.md references at 1.0; guard against reintroduction.
    const hasTestingRef = /docs\/testing\/[0-9]{4}-/.test(readme);
    if (hasTestingRef) {
      const exists = existsSync(join(root, "docs", "testing"));
      expect(exists, "README references docs/testing/* but that directory does not exist").toBe(true);
    }
  });

  it("user-facing READMEs never hardcode the package version", () => {
    const version = readJson("package.json").version as string;
    for (const file of README_SURFACES) {
      const filePath = join(root, file);
      if (!existsSync(filePath)) continue;
      // Releases must not require doc edits: the version number may only live
      // in package metadata and CHANGELOG.md, never in user-facing docs.
      expect(
        read(file),
        `${file} hardcodes the package version ${version} — use the dynamic badge / <version> placeholders instead`
      ).not.toContain(version);
    }
  });

  it("the extension README's install instructions are version-free", () => {
    const ext = read("vscode-extension/README.md");

    // Historically the Marketplace listing told users to install
    // graphflow-1.15.3.vsix for several releases after 1.15.3. Placeholder
    // filenames (<version>) make that whole failure class impossible.
    const pinnedVsix = [...ext.matchAll(/graphflow-(\d+\.\d+\.\d+)\.vsix/g)].map((m) => m[1]);
    expect(
      pinnedVsix,
      "extension README must use graphflow-<version>.vsix placeholders, not pinned filenames"
    ).toEqual([]);

    // Same for the npx install hint: unversioned always resolves to latest.
    const pinned = [...ext.matchAll(/@roarpeng\/graphflow@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(pinned, "extension README must not pin @roarpeng/graphflow@<version>").toEqual([]);
  });

  it("user-facing READMEs carry no version-annotated capability bullets", () => {
    // "能力（v1.18.5）"-style annotations forced a doc sweep on every release.
    // Capabilities are described as they are; history lives in CHANGELOG.md.
    // Note: platform constraints like the VS Code engine `^1.99.0` are not
    // package versions and are intentionally allowed.
    for (const file of README_SURFACES) {
      const filePath = join(root, file);
      if (!existsSync(filePath)) continue;
      const content = read(file);
      const versionTags = content.match(/[（(]v\d+\.\d+(\.\d+)?[）)]/g) ?? [];
      expect(
        versionTags,
        `${file} still annotates capabilities with version tags (${versionTags.join(", ")})`
      ).toEqual([]);
    }
  });

  it("shipped docs are valid UTF-8 (no lossy byte replacement)", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const files = [
      ...DOC_FILES,
      "ROADMAP.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "docs/context-contract.md",
      "docs/experience-memory.md",
    ];
    for (const file of files) {
      const filePath = join(root, file);
      if (!existsSync(filePath)) continue;
      // v1.15.4's release bump rewrote both READMEs, replacing the third byte of
      // ~100 multi-byte sequences with "?" — mojibake that shipped to npm.
      // Decoding fatally makes any recurrence a CI failure instead of a surprise.
      expect(() => decoder.decode(readFileSync(filePath)), `${file} is not valid UTF-8`).not.toThrow();
    }
  });
});
