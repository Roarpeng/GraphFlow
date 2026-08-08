import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  convertDocumentToMarkdown,
  isOfficeDocumentPath,
  OFFICE_DOCUMENT_EXTENSIONS,
  setDocumentConverterForTests,
  resetDocumentConverterCache,
} from "../src/graph/document-convert";
import {
  buildDocumentSemanticWorkItems,
  outlineFromMarkdown,
} from "../src/graph/document-semantic-bridge";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { createGraphClient } from "../src/graph/client-factory";
import { validateConfig } from "../src/config/loader";
import { DEFAULT_INCLUDE_EXTENSIONS } from "../src/config/include-extensions";

describe("document convert + office path helpers", () => {
  afterEach(() => {
    resetDocumentConverterCache();
  });

  it("recognizes office/PDF extensions", () => {
    expect(isOfficeDocumentPath("docs/spec.pdf")).toBe(true);
    expect(isOfficeDocumentPath("a/b/c.DOCX")).toBe(true);
    expect(isOfficeDocumentPath("readme.md")).toBe(false);
    expect(OFFICE_DOCUMENT_EXTENSIONS).toContain(".pdf");
  });

  it("includes office extensions in default include set", () => {
    expect(DEFAULT_INCLUDE_EXTENSIONS).toContain(".pdf");
    expect(DEFAULT_INCLUDE_EXTENSIONS).toContain(".docx");
  });

  it("returns unavailable when converter is missing", async () => {
    setDocumentConverterForTests(null);
    const result = await convertDocumentToMarkdown("/tmp/missing.pdf", Buffer.from("%PDF"));
    expect(result.converter).toBe("unavailable");
    expect(result.markdown).toBe("");
    expect(result.skippedReason).toContain("optional-dependency-missing");
  });

  it("uses injected anydoc toMarkdown", async () => {
    setDocumentConverterForTests({
      toMarkdown: async () => "# Spec\n\nHello GraphFlow.\n",
    });
    const result = await convertDocumentToMarkdown("/tmp/spec.pdf");
    expect(result.converter).toBe("anydoc");
    expect(result.markdown).toContain("# Spec");
  });
});

describe("document semantic bridge", () => {
  it("builds outline from markdown headings", () => {
    const md = "# Title\n\n## A\n\ntext\n\n### B\n";
    expect(outlineFromMarkdown(md)).toContain("# Title");
    expect(outlineFromMarkdown(md)).toContain("## A");
  });

  it("emits optional document-semantic work items", () => {
    const items = buildDocumentSemanticWorkItems([
      {
        relPath: "docs/api.pdf",
        outline: "# API",
        excerpt: "# API\n\nEndpoints...",
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("document-semantic-1");
    expect(items[0]!.kind).toBe("document-semantic");
    expect(items[0]!.optional).toBe(true);
    expect(items[0]!.prompt).toContain("docs/api.pdf");
  });
});

describe("office document indexing via mocked converter", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gf-doc-index-"));
    setDocumentConverterForTests({
      toMarkdown: async () =>
        [
          "# Product Spec",
          "",
          "## Overview",
          "GraphFlow indexes documents.",
          "",
          "## API",
          "Use graphflow_index.",
        ].join("\n"),
    });
  });

  afterEach(() => {
    resetDocumentConverterCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("converts PDF bytes to markdown graph sections and returns bridge work items", async () => {
    writeFileSync(join(root, "spec.pdf"), Buffer.from("%PDF-1.4 fake"), "binary");
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        enableNearLosslessMode: true,
        autoIndexOnPreview: true,
        workspaceRoot: root,
        includeExtensions: [".pdf"],
        transport: "memory",
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });
    const client = createGraphClient(config);
    const result = await indexWorkspaceFiles(client, root, {
      includeExtensions: [".pdf"],
      forceReindex: true,
    });

    expect(result.indexedFiles).toBeGreaterThanOrEqual(1);
    expect(result.indexedSymbols).toBeGreaterThanOrEqual(2);
    expect(result.agentWorkItems?.some((w) => w.kind === "document-semantic")).toBe(true);
    expect(result.agentInstructions).toMatch(/document semantic/i);

    const snapshot = client.readSnapshot!();
    const fileNode = snapshot.nodes.find((n) => n.id === "file:spec.pdf");
    expect(fileNode).toBeDefined();
    expect(fileNode?.metadata?.language).toBe("document");
    expect(fileNode?.metadata?.convertedVia).toBe("anydoc");

    const sections = snapshot.nodes.filter(
      (n) => n.type === "Symbol" && String(n.metadata?.kind ?? "") === "section"
    );
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });
});
