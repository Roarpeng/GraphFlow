/**
 * GraphFlow — Standalone precision regression test for `src/doc-graph.ts`.
 *
 * Covers the four real-world defects fixed in 3.3.1:
 *  1. Over-linking: an explicit symbol section must win; a concept-only section built from
 *     generic vocabulary ([cancel, order, refund, return], [handle, payment, callback, ...])
 *     must NOT link to the symbol.
 *  2. Cross-language explicit mentions (`cancel_order` <-> `CancelOrder`) link only the section
 *     that actually names the symbol, never every section of the document.
 *  3. Concept-only links still work when they are built from multiple distinctive shared
 *     concepts (rare-term weighting + minimum score + margin).
 *  4. `gf_read` on a code symbol / document only surfaces the correct linked section.
 *  5. Cross-agent briefs hide recorded activities whose files no longer exist.
 *
 * Self-contained (hand-built minimal .docx, temp dirs only). Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  buildDocCodeLinks,
  executeSurgicalRead,
  findLinkedDocsForSymbol,
  generateCrossAgentBrief,
  getWorkspaceAstIndex,
  parseProjectDocument,
  recordCrossAgentActivity,
} from "../src/index.js";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface DocxParagraph {
  text: string;
  heading?: boolean;
}

/**
 * Builds a minimal but real `.docx` (ZIP with a single deflated `word/document.xml`),
 * matching the zero-dependency reader implemented in `extractDocxText`.
 */
function buildDocx(paragraphs: DocxParagraph[]): Buffer {
  const body = paragraphs
    .map((paragraph) => {
      const style = paragraph.heading
        ? "<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>"
        : "";
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;

  const compressed = deflateRawSync(Buffer.from(documentXml, "utf8"));
  const fileName = Buffer.from("word/document.xml", "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(compressed.length, 18); // compressed size
  localHeader.writeUInt32LE(Buffer.byteLength(documentXml, "utf8"), 22); // uncompressed size
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([localHeader, fileName, compressed]);
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "gf-docgraph-precision-"));
  try {
    // ── Fixture: two namespaces of symbols that must not cross-link via generic concepts ──
    writeFile(
      root,
      "py/app.py",
      [
        "def cancel_order(order_id: str) -> bool:",
        '    """Cancel a pending order and release reserved stock."""',
        '    return order_id != ""',
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "py/callback.py",
      [
        "def handleDingDanZhiFu(payload: str) -> bool:",
        '    """Verify a WeChat payment callback signature."""',
        '    return payload.startswith("wx_")',
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "py/inventory.py",
      [
        "def reconcileInventory(ledger_total: int) -> int:",
        '    """Reconcile warehouse inventory counts against the ledger."""',
        "    return ledger_total",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "go/order.go",
      [
        "package order",
        "",
        "func CancelOrder(id string) bool {",
        '    return id != ""',
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "cs/Order.cs",
      [
        "public class OrderCancellationService",
        "{",
        "    public bool CancelOrder(string id)",
        "    {",
        '        return id != "";',
        "    }",
        "}",
        "",
      ].join("\n")
    );

    // ── Real .docx with 4 sections: two explicit, one concept-only, one generic-only ──
    const docRelPath = "docs/order-spec.docx";
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "order-spec.docx"),
      buildDocx([
        { text: "Order Cancellation Spec", heading: true },
        {
          text: "The `cancel_order` function cancels a pending order and releases reserved stock.",
        },
        { text: "Payment Callback", heading: true },
        {
          text: "Use `handleDingDanZhiFu` to verify WeChat payment callback signatures before settling funds.",
        },
        { text: "Inventory Reconciliation", heading: true },
        { text: "Reconcile warehouse inventory counts nightly against the ledger." },
        { text: "Generic Ops Notes", heading: true },
        { text: "Cancel the order and handle any refund or return flow." },
      ])
    );

    const index = getWorkspaceAstIndex(root);

    // ── 0. Document parsing sanity: 4 sections and all expected identifiers extracted ──
    const sections = parseProjectDocument(docRelPath, join(root, "docs", "order-spec.docx"));
    assert.equal(sections.length, 4, "docx must parse into 4 sections");
    assert.deepEqual(
      sections.map((section) => section.title),
      [
        "Order Cancellation Spec",
        "Payment Callback",
        "Inventory Reconciliation",
        "Generic Ops Notes",
      ]
    );
    assert.ok(
      sections[0]!.referencedIdentifiers.includes("cancel_order"),
      "explicit identifier extraction must keep snake_case mentions"
    );
    assert.ok(
      sections[1]!.referencedIdentifiers.includes("handleDingDanZhiFu"),
      "explicit identifier extraction must keep Pinyin camelCase mentions"
    );

    // ── 1. Cross-language symbols are present in the AST index ──
    const goSymbols = index.getFileAnalysis("go/order.go")?.ast.symbols.map((s) => s.name) ?? [];
    assert.ok(goSymbols.includes("CancelOrder"), "Go fixture must expose CancelOrder symbol");
    const csSymbols = index.getFileAnalysis("cs/Order.cs")?.ast.symbols.map((s) => s.name) ?? [];
    assert.ok(csSymbols.includes("CancelOrder"), "C# fixture must expose CancelOrder symbol");
    const pySymbols = index.getFileAnalysis("py/app.py")?.ast.symbols.map((s) => s.name) ?? [];
    assert.ok(pySymbols.includes("cancel_order"), "Python fixture must expose cancel_order symbol");

    // ── 2. Explicit identifier mentions dominate; unrelated sections do not link ──
    const links = buildDocCodeLinks(index, sections);
    const linksFor = (codeFile: string, symbolName: string) =>
      links.filter((link) => link.codeFile === codeFile && link.symbolName === symbolName);

    const pyCancelLinks = linksFor("py/app.py", "cancel_order");
    assert.equal(pyCancelLinks.length, 1, "cancel_order must link exactly one doc section");
    assert.equal(pyCancelLinks[0]!.docPath, docRelPath);
    assert.equal(
      pyCancelLinks[0]!.sectionTitle,
      "Order Cancellation Spec",
      "cancel_order must link only the section that explicitly names it"
    );

    for (const [codeFile, symbolName] of [
      ["go/order.go", "CancelOrder"],
      ["cs/Order.cs", "CancelOrder"],
    ] as const) {
      const candidateLinks = linksFor(codeFile, symbolName);
      assert.equal(
        candidateLinks.length,
        1,
        `${codeFile}#${symbolName} must link exactly one doc section`
      );
      assert.equal(
        candidateLinks[0]!.sectionTitle,
        "Order Cancellation Spec",
        `${codeFile}#${symbolName} must link only its explicit section (cross-language CancelOrder)`
      );
    }

    const callbackLinks = linksFor("py/callback.py", "handleDingDanZhiFu");
    assert.equal(
      callbackLinks.length,
      1,
      "handleDingDanZhiFu must link exactly one doc section"
    );
    assert.equal(callbackLinks[0]!.sectionTitle, "Payment Callback");

    // The classic regression: "Payment Callback" used to link cancel_order through
    // generic concepts [cancel, order, refund, return].
    assert.ok(
      !links.some(
        (link) => link.sectionTitle === "Payment Callback" && link.symbolName === "cancel_order"
      ),
      "Payment Callback must not link cancel_order via generic concepts"
    );
    assert.ok(
      !links.some(
        (link) =>
          link.sectionTitle === "Payment Callback" && link.symbolName === "CancelOrder"
      ),
      "Payment Callback must not link cross-language CancelOrder symbols"
    );
    assert.ok(
      !links.some(
        (link) =>
          link.sectionTitle === "Order Cancellation Spec" &&
          link.symbolName === "handleDingDanZhiFu"
      ),
      "Order Cancellation Spec must not link handleDingDanZhiFu"
    );

    // Generic-only vocabulary must never produce a concept link.
    assert.deepEqual(
      links.filter((link) => link.sectionTitle === "Generic Ops Notes"),
      [],
      "generic vocabulary (cancel/order/refund/return/handle) must not create doc links"
    );

    // ── 3. Concept-only links still work with multiple distinctive concepts ──
    const inventoryLinks = findLinkedDocsForSymbol(index, "py/inventory.py", "reconcileInventory", 3);
    assert.ok(
      inventoryLinks.some(
        (link) =>
          link.docPath === docRelPath && link.sectionTitle === "Inventory Reconciliation"
      ),
      "reconcileInventory must concept-link to the distinctive Inventory Reconciliation section"
    );
    assert.ok(
      !inventoryLinks.some((link) => link.sectionTitle === "Payment Callback"),
      "reconcileInventory must not concept-link to the unrelated Payment Callback section"
    );

    // ── 4. Reading a code symbol surfaces only the correct linked doc section ──
    const readSymbol = executeSurgicalRead({
      rootDir: root,
      targets: ["py/app.py#cancel_order"],
      includeCallers: false,
    });
    assert.ok(
      readSymbol.text.includes("[Linked Spec Doc]") &&
        readSymbol.text.includes(`${docRelPath}#Order Cancellation Spec`),
      "gf_read on cancel_order must surface the Order Cancellation Spec"
    );
    assert.ok(
      !readSymbol.text.includes("Payment Callback"),
      "gf_read on cancel_order must not surface the unrelated Payment Callback section"
    );

    // ── 5. Reading the document links each section only to its own symbols ──
    const readDoc = executeSurgicalRead({ rootDir: root, targets: [docRelPath] });
    const orderSectionStart = readDoc.text.indexOf("#### Order Cancellation Spec");
    const paymentSectionStart = readDoc.text.indexOf("#### Payment Callback");
    const inventorySectionStart = readDoc.text.indexOf("#### Inventory Reconciliation");
    const genericSectionStart = readDoc.text.indexOf("#### Generic Ops Notes");
    assert.ok(
      orderSectionStart >= 0 &&
        paymentSectionStart > orderSectionStart &&
        inventorySectionStart > paymentSectionStart &&
        genericSectionStart > inventorySectionStart,
      "gf_read on the .docx must render all 4 sections in order"
    );

    const orderSectionText = readDoc.text.slice(orderSectionStart, paymentSectionStart);
    const paymentSectionText = readDoc.text.slice(paymentSectionStart, inventorySectionStart);
    const genericSectionText = readDoc.text.slice(genericSectionStart);

    assert.ok(
      orderSectionText.includes("py/app.py#cancel_order"),
      "Order Cancellation Spec must link py/app.py#cancel_order"
    );
    assert.ok(
      !orderSectionText.includes("handleDingDanZhiFu"),
      "Order Cancellation Spec must not link handleDingDanZhiFu"
    );
    assert.ok(
      paymentSectionText.includes("py/callback.py#handleDingDanZhiFu"),
      "Payment Callback must link py/callback.py#handleDingDanZhiFu"
    );
    assert.ok(
      !paymentSectionText.includes("cancel_order") &&
        !paymentSectionText.includes("CancelOrder"),
      "Payment Callback must not link any CancelOrder/cancel_order symbol"
    );
    assert.ok(
      !genericSectionText.includes("[Linked Code]"),
      "Generic Ops Notes must not render any linked code symbol"
    );

    // ── 6. Cross-agent brief hides stale activities but keeps live ones ──
    writeFile(root, "src/keep.ts", "export function keepAlive(): number {\n  return 1;\n}\n");
    recordCrossAgentActivity(root, {
      agentHint: "cursor-agent",
      action: "read",
      summary: "Read src/keep.ts while working on keepAlive",
      files: ["src/keep.ts", "src/keep.ts#keepAlive"],
      ok: true,
    });
    recordCrossAgentActivity(root, {
      agentHint: "cursor-agent",
      action: "edit",
      summary: "Edited scripts/backfill-episodes.cjs from a stale 2.x checkout",
      files: ["scripts/backfill-episodes.cjs", "src/graph/legacy.ts"],
      ok: true,
    });

    const brief = generateCrossAgentBrief(getWorkspaceAstIndex(root));
    assert.ok(
      brief.includes("Read src/keep.ts while working on keepAlive"),
      "brief must keep activities whose files still exist"
    );
    assert.ok(
      !brief.includes("backfill-episodes.cjs"),
      "brief must hide activities whose recorded files were all deleted"
    );
    assert.ok(
      !brief.includes("stale 2.x checkout"),
      "brief must not surface summaries of fully-stale activities"
    );

    console.log(
      "PASS [doc-graph-precision] explicit refs dominate, generic concepts filtered, concept margin enforced, stale brief activities hidden"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error("FAIL [doc-graph-precision]", error);
  process.exit(1);
});
