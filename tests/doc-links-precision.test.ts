/**
 * GraphFlow — Standalone precision test for the self-written BM25/IDF + reciprocal-pruned
 * doc<->code link pipeline in `src/doc-graph.ts`.
 *
 * Covers:
 *  1. Explicit identifier mentions always link (real `.docx` + Markdown sections).
 *  2. Adversarial generic-only sections link nothing (static stoplist + dynamic DF cutoff).
 *  3. Ambiguous same-topic sections are pruned to the top 1-2 by reciprocal top-K + margin.
 *  4. `GRAPHFLOW_DOC_LINKS_MAX` global cap is respected.
 *  5. `.graphflow/doc-link-feedback.json` can suppress (reject) a specific link; the pipeline
 *     itself never writes the feedback file (write happens only through the exported helper).
 *  6. Determinism (identical output across builds) and runtime < 2s.
 *
 * Temp dirs only. Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  buildDocCodeLinks,
  getWorkspaceAstIndex,
  type DocCodeLink,
} from "../src/index.js";
import {
  docCodeLinkId,
  loadDocLinkFeedback,
  recordDocLinkFeedback,
} from "../src/doc-graph.js";

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

/** Builds a minimal but real `.docx` (ZIP + deflated `word/document.xml`). */
function buildDocx(paragraphs: DocxParagraph[]): Buffer {
  const body = paragraphs
    .map((paragraph) => {
      const style = paragraph.heading
        ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
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
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(Buffer.byteLength(documentXml, "utf8"), 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);
  return Buffer.concat([localHeader, fileName, compressed]);
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function linksWithTitle(links: DocCodeLink[], title: string): DocCodeLink[] {
  return links.filter((link) => link.sectionTitle === title);
}

function linksForSymbol(links: DocCodeLink[], symbolName: string): DocCodeLink[] {
  return links.filter((link) => link.symbolName === symbolName);
}

function findLink(
  links: DocCodeLink[],
  sectionTitle: string,
  symbolName: string
): DocCodeLink | undefined {
  return links.find(
    (link) => link.sectionTitle === sectionTitle && link.symbolName === symbolName
  );
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), "gf-doclinks-precision-"));
  const previousCap = process.env.GRAPHFLOW_DOC_LINKS_MAX;
  try {
    // ── Source symbols ──
    writeFile(
      root,
      "src/orders.ts",
      [
        "export function cancelOrder(orderId: string): boolean {",
        "  return orderId.length > 0;",
        "}",
        "",
        "export function cancelSubscription(subscriptionId: string): boolean {",
        "  return subscriptionId.length > 0;",
        "}",
        "",
        "export function capturePayment(payload: string): boolean {",
        '  return payload.startsWith("captured:");',
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "src/inventory.ts",
      [
        "export function reconcileInventory(ledgerTotal: number): number {",
        "  return ledgerTotal;",
        "}",
        "",
        "export function reconcileWarehouseStock(stockCount: number): number {",
        "  return stockCount;",
        "}",
        "",
      ].join("\n")
    );

    // ── Real .docx: explicit section + ambiguous inventory sections + adversarial generic ──
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "order-spec.docx"),
      buildDocx([
        { text: "Order Cancellation", heading: true },
        { text: "Call `cancelOrder` when a pending order expires before payment." },
        { text: "Inventory Reconciliation", heading: true },
        {
          text: "Reconcile inventory reconciliation against the warehouse ledger totals.",
        },
        { text: "Operations Notes", heading: true },
        { text: "Cancel the order and handle any refund, return, payment or callback flow." },
      ])
    );

    // ── Markdown: second explicit section + two ambiguous inventory sections ──
    writeFile(
      root,
      "docs/api.md",
      [
        "# Subscription Cancellation",
        "",
        "Call `cancelSubscription` to stop the billing cycle.",
        "",
        "# Inventory Ledger",
        "",
        "Reconcile inventory against the ledger totals.",
        "",
        "# Warehouse Inventory Audit",
        "",
        "Warehouse inventory reconciliation for the ledger.",
        "",
      ].join("\n")
    );

    const index = getWorkspaceAstIndex(root);

    // Feedback file must not exist yet (the pipeline is read-only by default).
    const feedbackPath = join(root, ".graphflow", "doc-link-feedback.json");
    assert.equal(
      existsSync(feedbackPath),
      false,
      "buildDocCodeLinks must not create the feedback file (read-only default)"
    );

    // ── 1. Explicit identifier mentions always link ──
    const links = buildDocCodeLinks(index);
    const explicitCancel = findLink(links, "Order Cancellation", "cancelOrder");
    assert.ok(explicitCancel, "backticked `cancelOrder` must produce an explicit link");
    assert.ok(explicitCancel.reason.startsWith("explicit ref"), "explicit reason must be tagged");
    assert.equal(explicitCancel.score, 100, "explicit links keep the dominant score");
    const explicitSubscription = findLink(links, "Subscription Cancellation", "cancelSubscription");
    assert.ok(
      explicitSubscription,
      "backticked `cancelSubscription` in Markdown must produce an explicit link"
    );
    assert.equal(linksWithTitle(links, "Order Cancellation").length, 1);
    assert.equal(linksWithTitle(links, "Subscription Cancellation").length, 1);

    // ── 2. Adversarial generic-only section links nothing ──
    assert.deepEqual(
      linksWithTitle(links, "Operations Notes"),
      [],
      "generic vocabulary (cancel/order/refund/return/payment/callback) must not create links"
    );

    // ── 3. Ambiguous same-topic sections prune to top 1-2 (reciprocal + margin) ──
    const ambiguousTitles = new Set([
      "Inventory Reconciliation",
      "Inventory Ledger",
      "Warehouse Inventory Audit",
    ]);
    const reconcileLinks = linksForSymbol(links, "reconcileInventory").filter((link) =>
      ambiguousTitles.has(link.sectionTitle)
    );
    assert.ok(
      reconcileLinks.length >= 1,
      "reconcileInventory must concept-link to at least one inventory section"
    );
    assert.ok(
      reconcileLinks.length <= 2,
      `ambiguous inventory sections must prune to top-1/2, got ${reconcileLinks.length}`
    );
    assert.ok(
      reconcileLinks.some((link) => link.sectionTitle === "Inventory Reconciliation"),
      "the title/doc-field-boosted Inventory Reconciliation section must survive pruning"
    );
    assert.ok(
      reconcileLinks.every((link) => link.reason.includes("distinctive concepts")),
      "concept-only links must be labelled with their distinctive concepts + confidence"
    );

    // ── 4. Determinism ──
    const linksAgain = buildDocCodeLinks(index);
    assert.deepEqual(
      linksAgain.map((link) => docCodeLinkId(link)),
      links.map((link) => docCodeLinkId(link)),
      "doc<->code links must be deterministic across builds"
    );

    // ── 5. Global cap via GRAPHFLOW_DOC_LINKS_MAX ──
    assert.ok(links.length > 1, "fixture must produce more than one link for the cap test");
    process.env.GRAPHFLOW_DOC_LINKS_MAX = "1";
    const capped = buildDocCodeLinks(index);
    assert.equal(capped.length, 1, "GRAPHFLOW_DOC_LINKS_MAX=1 must emit exactly one link");
    process.env.GRAPHFLOW_DOC_LINKS_MAX = "2";
    assert.equal(buildDocCodeLinks(index).length, 2, "GRAPHFLOW_DOC_LINKS_MAX=2 must emit two links");
    if (previousCap === undefined) delete process.env.GRAPHFLOW_DOC_LINKS_MAX;
    else process.env.GRAPHFLOW_DOC_LINKS_MAX = previousCap;

    // ── 6. Feedback can suppress a link; the pipeline never writes the file itself ──
    const suppressTarget = reconcileLinks[0]!;
    const suppressId = docCodeLinkId(suppressTarget);
    recordDocLinkFeedback(root, { rejected: [suppressId] });
    assert.deepEqual(
      loadDocLinkFeedback(root).rejected,
      [suppressId],
      "recordDocLinkFeedback must persist the rejected link id"
    );
    const feedbackContentBefore = readFileSync(feedbackPath, "utf8");
    const afterFeedback = buildDocCodeLinks(index);
    assert.ok(
      !afterFeedback.some((link) => docCodeLinkId(link) === suppressId),
      "rejected feedback must suppress the link"
    );
    assert.ok(
      findLink(afterFeedback, "Order Cancellation", "cancelOrder"),
      "feedback must not affect explicit links"
    );
    assert.equal(
      readFileSync(feedbackPath, "utf8"),
      feedbackContentBefore,
      "buildDocCodeLinks must only read the feedback file"
    );

    // ── 7. Runtime < 2s on the fixture ──
    const startedAt = Date.now();
    buildDocCodeLinks(index);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2000, `doc<->code link build must stay under 2s (took ${elapsedMs}ms)`);

    const explicitCount = links.filter((link) => link.reason.startsWith("explicit ref")).length;
    console.log(
      `[doc-links-precision] links=${links.length} explicit=${explicitCount} ` +
        `concept=${links.length - explicitCount} ambiguousReconcile=${reconcileLinks.length} ` +
        `buildMs=${elapsedMs}`
    );
    console.log(
      "PASS [doc-links-precision] explicit links preserved, generic sections dropped, reciprocal+margin pruning, caps and feedback honoured"
    );
  } finally {
    if (previousCap === undefined) delete process.env.GRAPHFLOW_DOC_LINKS_MAX;
    else process.env.GRAPHFLOW_DOC_LINKS_MAX = previousCap;
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error("FAIL [doc-links-precision]", error);
  process.exit(1);
}
