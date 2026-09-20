import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { resolveConfig } from "../src/config/resolve";
import { createGraphClient } from "../src/graph/client-factory";
import { searchDialogueTurns } from "../src/graph/graph-search";
import {
  MAX_ECHO_TURN_CHARS,
  dialogueSessionIdFor,
  dialogueTurnIdFor,
  recordDialogueTurn,
} from "../src/learning/dialogue-thread";
import {
  estimateUnbudgetedPayloadTokens,
  expandAnchor,
  previewContext,
} from "../src/surfaces/cli/runtime/graph";

/**
 * 召回命中回显瘦身 + 按实际下发负载记账 / Dialogue-recall hits ride clipped.
 *
 * `graphflow_context` used to attach the recalled turns' full `userQuery`
 * (up to 4000 stored chars x 3 hits) verbatim in `dialogueHits` — the single
 * largest multi-KB chunk of the response. These tests pin the slimmed
 * contract: ids and structural marks verbatim, `userQuery` clipped to the
 * shared echo budget (`MAX_ECHO_TURN_CHARS`) with a `truncated` marker,
 * `unbudgetedTokens` measured on the clipped payload as sent, and anchor
 * expansion still returning the full stored text (it reads the graph store,
 * not this attached view).
 */

const LONG_BODY = "正文填充".repeat(1_000); // 4000 chars — saturates the store-side write clip too
const LONG_QUERY = `历史问题 alpha beta gamma ${LONG_BODY}`;
const SHORT_QUERY = "短问题 zeta 召回";

describe("previewContext dialogueHits: clipped previews, honest accounting (m107)", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m107-dialoguehits-"));
  // 隔离 config（参照 m106 的 createIsolatedConfig 模式）：文件后端 +
  // 自动索引全关——召回只依赖种子 dialogue 节点，绝不碰真实工作区。
  // Isolated config (m106 createIsolatedConfig pattern): file backend and
  // all auto-indexing off — recall only needs the seeded dialogue turns.
  const configPath = (() => {
    const path = join(root, "graphflow.config.json");
    const config = getDefaultConfig();
    writeFileSync(
      path,
      JSON.stringify(
        {
          ...config,
          graphPolicy: {
            ...config.graphPolicy,
            transport: "file",
            autoIndexOnPreview: false,
            autoIndexOnRun: false,
            autoIndexOnSave: false,
            graphStorePath: join(root, "graphflow-graph.json"),
            workspaceRoot: root,
          },
        },
        null,
        2
      ),
      "utf8"
    );
    return path;
  })();
  const sessionId = dialogueSessionIdFor("main", root);
  let longTurnId = "";
  let storedLongQuery = "";

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("seeds a 4000-char dialogue turn whose full text lands in the store", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    const seeded = await recordDialogueTurn(client, {
      userQuery: LONG_QUERY,
      assistantReply: `历史结论 ${LONG_BODY}`,
      workspaceRoot: root,
      now: 1_000,
    });
    expect(seeded.turn).toBeDefined();
    longTurnId = seeded.turn!.id;
    storedLongQuery = seeded.turn!.userQuery;
    expect(longTurnId).toBe(dialogueTurnIdFor(sessionId, 1));
    // Store-side write clip keeps at most 4000 chars — still far above the
    // echo budget, so this turn must arrive as a clipped preview.
    expect(storedLongQuery.length).toBeLessThanOrEqual(4_000);
    expect(storedLongQuery.length).toBeGreaterThan(MAX_ECHO_TURN_CHARS);

    await recordDialogueTurn(client, {
      userQuery: SHORT_QUERY,
      workspaceRoot: root,
      now: 2_000,
    });
  });

  it("dialogueHits[0] rides a <=200-char userQuery preview, truncated=true, other fields verbatim", async () => {
    // recordDialogue:false keeps the store at exactly the two seeded turns —
    // historical recall is read-only and still runs (and no thread spine or
    // workbench echo joins this preview, so unbudgetedTokens is hits-only).
    const preview = await previewContext("alpha beta gamma", configPath, root, undefined, {
      recordDialogue: false,
    });

    expect(preview.dialogueHits).toBeDefined();
    expect(preview.dialogueHits).toHaveLength(1);
    const hit = preview.dialogueHits![0]!;
    expect(hit.id).toBe(longTurnId);
    expect(hit.seq).toBe(1);
    expect(hit.sessionId).toBe(sessionId);
    expect(hit.superseded).toBe(false);
    expect(hit.truncated).toBe(true);
    // Clipped preview: bounded, prefix-preserving, shorter than the stored text.
    expect(hit.userQuery.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
    expect(hit.userQuery.startsWith("历史问题 alpha beta gamma")).toBe(true);
    expect(hit.userQuery.length).toBeLessThan(storedLongQuery.length);

    // Every non-text field passes through verbatim, checked against the
    // full-text hit the graph store still returns for the same query.
    const raw = (
      await searchDialogueTurns(createGraphClient(resolveConfig(configPath)), "alpha beta gamma", {
        limit: 3,
      })
    )[0]!;
    expect(raw.userQuery.length).toBeGreaterThan(MAX_ECHO_TURN_CHARS);
    expect(hit.id).toBe(raw.id);
    expect(hit.seq).toBe(raw.seq);
    expect(hit.sessionId).toBe(raw.sessionId);
    expect(hit.title).toBe(raw.title);
    expect(hit.summary).toBe(raw.summary);
    expect(hit.updatedAt).toBe(raw.updatedAt);
    expect(hit.correctionLine).toBe(raw.correctionLine);
    expect(hit.superseded).toBe(raw.superseded);
    expect(hit.userQuery === raw.userQuery).toBe(false);

    // Accounting is measured on the clipped payload actually sent...
    expect(preview.unbudgetedTokens).toBe(
      estimateUnbudgetedPayloadTokens(preview.dialogueHits!)
    );
    // ...which is strictly cheaper than the full-text hit would have been.
    expect(preview.unbudgetedTokens!).toBeLessThan(estimateUnbudgetedPayloadTokens([raw]));
    // True accounted total = budgeted + unbudgeted, as in m105.
    expect(preview.accountedTokens).toBe(
      preview.tokenBudget.compressedTokens + preview.unbudgetedTokens!
    );
  });

  it("a short stored query rides unclipped and unmarked", async () => {
    const preview = await previewContext("zeta 召回", configPath, root, undefined, {
      recordDialogue: false,
    });
    expect(preview.dialogueHits).toHaveLength(1);
    const hit = preview.dialogueHits![0]!;
    expect(hit.id).toBe(dialogueTurnIdFor(sessionId, 2));
    expect(hit.userQuery).toBe(SHORT_QUERY);
    expect("truncated" in hit).toBe(false);
  });

  it("anchor expansion still returns the full stored text (store read, not the view)", async () => {
    const expanded = await expandAnchor(longTurnId, configPath, root);
    expect(expanded).toBeDefined();
    expect(expanded!.anchorId).toBe(longTurnId);
    // expandAnchor reads the stored node: content carries the FULL Q text,
    // far beyond the 200-char echo budget that rode in dialogueHits.
    expect(expanded!.content).toContain(`Q: ${storedLongQuery}`);
    expect(expanded!.content.length).toBeGreaterThan(storedLongQuery.length);
  });
});
